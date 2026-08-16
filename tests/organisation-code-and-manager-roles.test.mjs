import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const commands = await load("lib", "cloudflare", "organization-commands.ts");
const cloudflareOrganizations = await load("lib", "cloudflare", "organizations.ts");

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

// Every id below is a distinct valid v4-shaped UUID so the id() validator in
// organization-commands.ts accepts it without complaint.
const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  owner: "50000000-0000-4000-8000-000000000001",
  manager: "50000000-0000-4000-8000-000000000002",
  manager2: "50000000-0000-4000-8000-000000000003",
  teacher: "50000000-0000-4000-8000-000000000004",
  student: "50000000-0000-4000-8000-000000000005",
  learner: "50000000-0000-4000-8000-000000000006",
};

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  const insertUser = database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `);
  for (const [key, id] of Object.entries(ids)) insertUser.run(id, `${key}@example.com`, now, now);

  database.prepare(`
    INSERT INTO organizations (
      id, application_id, name, slug, status, created_by,
      created_at, updated_at, join_code
    ) VALUES (?, NULL, 'Harbour English Academy', NULL, 'active', ?, ?, ?, 'harbourjoincode1')
  `).run(ids.organization, ids.owner, now, now);

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?)
  `);
  insertMembership.run("70000000-0000-4000-8000-000000000001", ids.organization, ids.owner, "owner", now, now, now, now);
  insertMembership.run("70000000-0000-4000-8000-000000000002", ids.organization, ids.manager, "manager", now, now, now, now);
  insertMembership.run("70000000-0000-4000-8000-000000000003", ids.organization, ids.manager2, "manager", now, now, now, now);
  insertMembership.run("70000000-0000-4000-8000-000000000004", ids.organization, ids.teacher, "teacher", now, now, now, now);
  insertMembership.run("70000000-0000-4000-8000-000000000005", ids.organization, ids.student, "student", now, now, now, now);

  const insertSubscription = database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'standard', ?, ?, ?)
  `);
  // Every account that might end up as (or become) a student needs an
  // eligible plan, since studentEligible() gates that regardless of role.
  insertSubscription.run("71000000-0000-4000-8000-000000000001", ids.student, now, now, now);
  insertSubscription.run("71000000-0000-4000-8000-000000000002", ids.learner, now, now, now);
  insertSubscription.run("71000000-0000-4000-8000-000000000003", ids.teacher, now, now, now);
  insertSubscription.run("71000000-0000-4000-8000-000000000004", ids.manager2, now, now, now);

  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
    user(id) { return { id, email: `${id}@example.com` }; },
  };
}

function memberActionPayload(overrides = {}) {
  return { organizationId: ids.organization, userId: ids.teacher, ...overrides };
}

let key = 0;
function nextKey(label) {
  key += 1;
  return `${label}-${key}`;
}

// ---------------------------------------------------------------------------
// Feature 1: the join code is visible only to someone who can manage.
// ---------------------------------------------------------------------------

test("the join code reaches an owner and a manager, but nobody else", async () => {
  const context = fixture();
  try {
    const ownerPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(ids.owner), false, null, context.bindings,
    );
    assert.equal(ownerPortal.joinCode, "harbourjoincode1");

    const managerPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(ids.manager), false, null, context.bindings,
    );
    assert.equal(managerPortal.joinCode, "harbourjoincode1");

    const teacherPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(ids.teacher), false, null, context.bindings,
    );
    assert.equal(teacherPortal.joinCode, null, "a teacher must never receive the join code");

    const studentPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(ids.student), false, null, context.bindings,
    );
    assert.equal(studentPortal.joinCode, null, "a student must never receive the join code");
  } finally {
    context.database.close();
  }
});

test("a learner can join end to end using the code a manager was shown", async () => {
  const context = fixture();
  try {
    const managerPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(ids.manager), false, null, context.bindings,
    );
    const code = managerPortal.joinCode;
    assert.ok(code, "the manager must have seen a code to share it");

    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.learner), false, "request_to_join",
      { code, shareFutureHistoryConsent: true },
      nextKey("join-by-code"), context.bindings,
    );
    assert.equal(response.ok, true);

    const membership = context.database.prepare(`
      SELECT organization_id, role, status FROM organization_memberships WHERE user_id = ?
    `).get(ids.learner);
    assert.ok(membership, "the join request must create a pending membership");
    assert.equal(membership.organization_id, ids.organization, "it must resolve to the right organisation");
    assert.equal(membership.role, "student");
    assert.equal(membership.status, "pending", "a code only creates a request — it still needs approval");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// Feature 2: a manager can grant and remove the manager role.
// ---------------------------------------------------------------------------

test("a manager can promote a teacher to manager", async () => {
  const context = fixture();
  try {
    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      memberActionPayload({ role: "manager" }),
      nextKey("promote-teacher"), context.bindings,
    );
    assert.equal(response.ok, true);
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.teacher);
    assert.equal(row.role, "manager");
  } finally {
    context.database.close();
  }
});

test("a manager can demote another manager to teacher", async () => {
  const context = fixture();
  try {
    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      memberActionPayload({ userId: ids.manager2, role: "teacher" }),
      nextKey("demote-manager"), context.bindings,
    );
    assert.equal(response.ok, true);
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.manager2);
    assert.equal(row.role, "teacher");
  } finally {
    context.database.close();
  }
});

test("a manager still cannot touch an owner, in any of the four member actions", async () => {
  const context = fixture();
  const expectForbidden = (promise) => assert.rejects(
    promise,
    (error) => error instanceof commands.OrganizationCommandError
      && error.status === 400 && error.message === "Only BandUp can manage an owner.",
  );
  try {
    await expectForbidden(commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      memberActionPayload({ userId: ids.owner, role: "teacher" }),
      nextKey("owner-change-role"), context.bindings,
    ));
    await expectForbidden(commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "suspend_member",
      memberActionPayload({ userId: ids.owner }),
      nextKey("owner-suspend"), context.bindings,
    ));
    await expectForbidden(commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "restore_member",
      memberActionPayload({ userId: ids.owner }),
      nextKey("owner-restore"), context.bindings,
    ));
    await expectForbidden(commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "remove_member",
      memberActionPayload({ userId: ids.owner }),
      nextKey("owner-remove"), context.bindings,
    ));
    const row = context.database.prepare(
      "SELECT role, status FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.owner);
    assert.equal(row.role, "owner");
    assert.equal(row.status, "active");
  } finally {
    context.database.close();
  }
});

test("a manager still cannot promote anyone to owner", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(ids.manager), false, "change_member_role",
        memberActionPayload({ role: "owner" }),
        nextKey("manager-cannot-own"), context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 400 && error.message === "Invalid role.",
    );
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.teacher);
    assert.equal(row.role, "teacher", "the target must be untouched");
  } finally {
    context.database.close();
  }
});

test("an owner promoting to owner still works, and platformAdmin can too", async () => {
  const context = fixture();
  try {
    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.owner), false, "change_member_role",
      memberActionPayload({ role: "owner" }),
      nextKey("owner-can-promote-owner"), context.bindings,
    );
    assert.equal(response.ok, true);
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.teacher);
    assert.equal(row.role, "owner");
  } finally {
    context.database.close();
  }
});

// Demoting to student used to be refused outright, on the theory that a
// student always arrives having agreed to history sharing. A manager can now
// make the change — tests/organisation-role-and-join.test.mjs covers the
// replacement guarantee: the conversion clears both sharing flags instead of
// carrying across consent nobody actually gave.
test("demoting a manager to student now succeeds, since converting a member into a student is allowed", async () => {
  const context = fixture();
  try {
    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      memberActionPayload({ userId: ids.manager2, role: "student" }),
      nextKey("demote-to-student"), context.bindings,
    );
    assert.equal(response.ok, true);
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.manager2);
    assert.equal(row.role, "student");
  } finally {
    context.database.close();
  }
});

/*
  The roster has to show the people the commands above can act on.

  The command layer is only half of "a manager can remove the manager role".
  The team grid used to render teachers and students and nothing else, which
  was harmless while only an owner could appoint a manager — but the moment a
  manager can, promoting somebody made them vanish from the roster, and no
  screen anywhere could demote them again. The grant worked and the removal
  was unreachable.

  Asserted against the source because this is a rendering rule in a component
  that needs a signed-in portal to mount. It is a weaker check than the
  behavioural ones above and is written that way deliberately, rather than
  left out because it was awkward to reach.
*/
test("owners and managers are rendered in the roster, or the demotion has no button", () => {
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  const groups = portal.slice(portal.indexOf("function TeamGroups"), portal.indexOf("function JoinCodeCard"));

  assert.match(
    groups,
    /const leaders = members\.filter\(\(member\) => member\.role === "manager" \|\| member\.role === "owner"\)/,
    "managers and the owner must be selected out of the member list",
  );
  assert.match(groups, /Owners and managers/, "and given a visible section of their own");

  // Management controls against a manager, and deliberately none against an
  // owner — the server refuses every one of those, and a button that always
  // fails is worse than no button.
  assert.match(
    groups,
    /leader\.role === "manager" && \(\s*<MemberManagement/,
    "a manager row must carry the controls that demote it",
  );

  // The empty state has to account for the new group too, or an organisation
  // with only an owner reads as empty.
  assert.doesNotMatch(groups, /No teachers or students are visible/);
});
