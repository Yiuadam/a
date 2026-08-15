import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const actions = await load("lib", "organizations", "actions.ts");
const commands = await load("lib", "cloudflare", "organization-commands.ts");
const cloudflareOrganizations = await load("lib", "cloudflare", "organizations.ts");
const previewAuth = await load("lib", "organizations", "preview-auth.ts");

function runtimeD1(database) {
  const result = (statement) => {
    const executed = database.prepare(statement.sql).run(...statement.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(executed.changes ?? 0) },
    };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() {
      return result({ sql, values });
    },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return {
    prepare(sql) {
      return {
        bind: (...values) => bound(sql, values),
        ...bound(sql, []),
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(result);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const now = "2026-08-15T04:00:00.000Z";

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
    user(id, label) {
      return { id, email: `${label}@example.com` };
    },
  };
}

function count(database, table, where = "", ...values) {
  return database.prepare(`SELECT count(*) AS total FROM ${table} ${where}`).get(...values).total;
}

const person = "50000000-0000-4000-8000-000000000001";
const admin = "50000000-0000-4000-8000-000000000002";

test("create_organization replaces the application actions", () => {
  assert.equal(actions.isOrganizationAction("create_organization"), true);
  assert.equal(actions.isOrganizationAction("submit_application"), false);
  assert.equal(actions.isOrganizationAction("withdraw_application"), false);
  assert.equal(actions.isOrganizationAction("decide_application"), false);
});

test("any signed-in user creates an organisation immediately and becomes its owner, in one atomic batch", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'person@example.com', 'user', ?, ?)
    `).run(person, now, now);

    const response = await commands.cloudflareOrganizationCommand(
      context.user(person, "person"),
      false,
      "create_organization",
      {
        organizationName: "Harbour English Academy",
        country: "United Kingdom",
        contactEmail: "director@harbour.example",
        applicantRole: "School director",
      },
      "create-organization-0001",
      context.bindings,
    );
    assert.equal(response.ok, true);
    assert.equal(typeof response.organizationId, "string");

    const organization = context.database.prepare(`
      SELECT status, name, created_by, application_id FROM organizations WHERE id = ?
    `).get(response.organizationId);
    assert.ok(organization, "the organisation row must exist");
    assert.equal(organization.status, "active");
    assert.equal(organization.name, "Harbour English Academy");
    assert.equal(organization.created_by, person);
    assert.equal(organization.application_id, null);

    const membership = context.database.prepare(`
      SELECT role, status FROM organization_memberships
       WHERE organization_id = ? AND user_id = ?
    `).get(response.organizationId, person);
    assert.ok(membership, "the owner membership row must exist");
    assert.equal(membership.role, "owner");
    assert.equal(membership.status, "active");

    assert.equal(
      count(context.database, "organization_applications"),
      0,
      "no application row is ever written",
    );
    assert.equal(
      count(context.database, "organization_audit_log", "WHERE organization_id = ? AND action = 'create_organization'", response.organizationId),
      1,
    );
  } finally {
    context.database.close();
  }
});

test("a user can create more than one organisation, with no cap", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'person@example.com', 'user', ?, ?)
    `).run(person, now, now);

    const first = await commands.cloudflareOrganizationCommand(
      context.user(person, "person"), false, "create_organization",
      { organizationName: "First Academy", country: "UK", contactEmail: "a@example.com", applicantRole: "Director" },
      "create-organization-first", context.bindings,
    );
    const second = await commands.cloudflareOrganizationCommand(
      context.user(person, "person"), false, "create_organization",
      { organizationName: "Second Academy", country: "UK", contactEmail: "b@example.com", applicantRole: "Director" },
      "create-organization-second", context.bindings,
    );
    assert.notEqual(first.organizationId, second.organizationId);
    assert.equal(
      count(context.database, "organization_memberships", "WHERE user_id = ? AND role = 'owner'", person),
      2,
    );
  } finally {
    context.database.close();
  }
});

test("create_organization validation matches the retired application form", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'person@example.com', 'user', ?, ?)
    `).run(person, now, now);
    const base = {
      organizationName: "Valid Academy",
      country: "United Kingdom",
      contactEmail: "director@harbour.example",
      applicantRole: "School director",
    };

    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(person, "person"), false, "create_organization",
        { ...base, organizationName: "A" },
        "create-organization-bad-name", context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError && error.status === 400,
    );
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(person, "person"), false, "create_organization",
        { ...base, contactEmail: "not-an-email" },
        "create-organization-bad-email", context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError && error.status === 400,
    );
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(person, "person"), false, "create_organization",
        { ...base, estimatedStudents: 0 },
        "create-organization-bad-estimate", context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError && error.status === 400,
    );
    assert.equal(count(context.database, "organizations"), 0, "no rejected attempt may leave a row behind");
  } finally {
    context.database.close();
  }
});

test("the guard that skips the active-organisation check no longer names decide_application, and create_organization is never routed through it", () => {
  const source = readFileSync(join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"), "utf8");
  assert.doesNotMatch(source, /decide_application/);
  assert.doesNotMatch(source, /submit_application/);
  assert.doesNotMatch(source, /withdraw_application/);
  const guardStart = source.indexOf("const organizationId = await commandOrganization(db, action, payload);");
  const guardEnd = source.indexOf("fail(\"Organisation is not active.\");");
  const guard = source.slice(guardStart, guardEnd);
  assert.doesNotMatch(guard, /decide_application/);
  // create_organization carries no organizationId, so commandOrganization
  // returns null for it and the active-organisation guard is skipped
  // entirely — it is never reached via the organizationId truthiness check.
  assert.doesNotMatch(source, /action !== "create_organization"/);
});

test("the platform-admin organisations list still exists for oversight, and is not narrowed", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'admin@example.com', 'user', ?, ?)
    `).run(admin, now, now);
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'person@example.com', 'user', ?, ?)
    `).run(person, now, now);

    await commands.cloudflareOrganizationCommand(
      context.user(person, "person"), false, "create_organization",
      { organizationName: "Harbour English Academy", country: "UK", contactEmail: "a@example.com", applicantRole: "Director" },
      "create-organization-oversight", context.bindings,
    );

    const portal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(admin, "admin"),
      true,
      null,
      context.bindings,
    );
    assert.ok(Array.isArray(portal.organizations));
    assert.equal(portal.organizations.length, 1);
    assert.equal(portal.organizations[0].name, "Harbour English Academy");

    const nonAdminPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(person, "person"),
      false,
      null,
      context.bindings,
    );
    assert.equal(nonAdminPortal.organizations, null, "a non-admin never sees every organisation");
  } finally {
    context.database.close();
  }
});

test("suspend, restore and delete stay platform-admin (or manager/owner) only, unaffected by open creation", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'person@example.com', 'user', ?, ?)
    `).run(person, now, now);
    context.database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, 'other@example.com', 'user', ?, ?)
    `).run(admin, now, now);

    const created = await commands.cloudflareOrganizationCommand(
      context.user(person, "person"), false, "create_organization",
      { organizationName: "Harbour English Academy", country: "UK", contactEmail: "a@example.com", applicantRole: "Director" },
      "create-organization-for-suspend", context.bindings,
    );

    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(admin, "other"), false, "suspend_organization",
        { organizationId: created.organizationId },
        "suspend-non-admin", context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 403 && error.code === "forbidden",
    );
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(admin, "other"), false, "restore_organization",
        { organizationId: created.organizationId },
        "restore-non-admin", context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 403 && error.code === "forbidden",
    );
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(admin, "other"), false, "delete_organization",
        { organizationId: created.organizationId, confirmationName: "Harbour English Academy" },
        "delete-non-admin", context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 403 && error.code === "forbidden",
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", created.organizationId), 1);
  } finally {
    context.database.close();
  }
});

test("the shared preview host still refuses create_organization like every other write", () => {
  const route = readFileSync(join(process.cwd(), "app/api/organization/route.ts"), "utf8");
  // handlePOST refuses every previewRequest unconditionally after payload
  // shape checks, so create_organization needs no special case to stay
  // read-only there.
  assert.match(route, /if \(previewRequest\) \{\s*\n\s*return safeJsonError\(\s*\n\s*"This shared preview is read-only\. No account or organisation was changed\."/);
  assert.equal(previewAuth.organizationPreviewPayloadAllowed("create_organization", {}), true);
});
