import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const commands = await import(pathToFileURL(
  join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"),
).href);

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

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  const ids = {
    organization: "11111111-1111-4111-8111-111111111111",
    owner: "50000000-0000-4000-8000-000000000001",
    targeted: "50000000-0000-4000-8000-000000000002",
    email: "50000000-0000-4000-8000-000000000003",
    joiner: "50000000-0000-4000-8000-000000000004",
  };
  const now = "2026-08-13T12:00:00.000Z";
  const users = [
    [ids.owner, "owner@example.com"],
    [ids.targeted, "targeted@example.com"],
    [ids.email, "email@example.com"],
    [ids.joiner, "joiner@example.com"],
  ];
  const insertUser = database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `);
  for (const [id, email] of users) insertUser.run(id, email, now, now);
  database.prepare(`
    INSERT INTO organizations (
      id, application_id, name, slug, status, created_by,
      created_at, updated_at, join_code
    ) VALUES (?, NULL, 'Harbour English Academy', NULL, 'active', ?, ?, ?, 'harbour-join-code')
  `).run(ids.organization, ids.owner, now, now);
  database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, 'owner', 'active', 1, 0, ?, ?, ?, ?)
  `).run("70000000-0000-4000-8000-000000000001", ids.organization, ids.owner, now, now, now, now);
  const insertSubscription = database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'standard', ?, ?, ?)
  `);
  insertSubscription.run("71000000-0000-4000-8000-000000000001", ids.targeted, now, now, now);
  insertSubscription.run("71000000-0000-4000-8000-000000000002", ids.email, now, now, now);
  insertSubscription.run("71000000-0000-4000-8000-000000000003", ids.joiner, now, now, now);
  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
    ids,
    user(id, email) { return { id, email }; },
  };
}

function expectConflict(promise, message) {
  return assert.rejects(
    promise,
    (error) => error instanceof commands.OrganizationCommandError
      && error.status === 409
      && error.message === message,
  );
}

test("an account-bound invitation accepts without a URL secret, while email acceptance still needs it", async () => {
  const context = fixture();
  const owner = context.user(context.ids.owner, "owner@example.com");
  const targeted = context.user(context.ids.targeted, "targeted@example.com");
  const emailed = context.user(context.ids.email, "email@example.com");
  const targetToken = "target-account-secret-abcdefghijklmnopqrstuvwxyz";
  const emailToken = "email-secret-abcdefghijklmnopqrstuvwxyz";

  try {
    const targetedInvite = await commands.cloudflareOrganizationCommand(
      owner,
      false,
      "invite_member",
      {
        organizationId: context.ids.organization,
        userId: context.ids.targeted,
        role: "student",
        token: targetToken,
      },
      "target-invite-0001",
      context.bindings,
    );
    const targetRequest = targetedInvite.invitation.requestId;
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        targeted,
        false,
        "accept_invitation",
        { requestId: targetRequest, token: "wrong", shareFutureHistoryConsent: true },
        "target-short-token-1",
        context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 404
        && error.message === "Invitation not found.",
    );
    await commands.cloudflareOrganizationCommand(
      targeted,
      false,
      "accept_invitation",
      { requestId: targetRequest, shareFutureHistoryConsent: true },
      "target-accept-0001",
      context.bindings,
    );
    assert.equal(
      context.database.prepare(`SELECT status FROM organization_memberships
        WHERE organization_id = ? AND user_id = ?`).get(
        context.ids.organization,
        context.ids.targeted,
      ).status,
      "active",
    );

    const emailInvite = await commands.cloudflareOrganizationCommand(
      owner,
      false,
      "invite_member",
      {
        organizationId: context.ids.organization,
        email: "email@example.com",
        role: "student",
        token: emailToken,
      },
      "email-invite-0001",
      context.bindings,
    );
    const emailRequest = emailInvite.invitation.requestId;
    assert.equal(
      context.database.prepare(`SELECT count(*) AS total FROM user_notifications
        WHERE kind = 'organization_invitation' AND recipient_user_id = ?`)
        .get(context.ids.email).total,
      0,
      "email invitations stay in email because the inbox has no secret token",
    );
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        emailed,
        false,
        "accept_invitation",
        { requestId: emailRequest, shareFutureHistoryConsent: true },
        "email-accept-no-token",
        context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 404
        && error.message === "Invitation not found.",
    );
    assert.equal(
      context.database.prepare("SELECT status FROM organization_requests WHERE id = ?")
        .get(emailRequest).status,
      "pending",
    );
    await commands.cloudflareOrganizationCommand(
      emailed,
      false,
      "accept_invitation",
      { requestId: emailRequest, token: emailToken, shareFutureHistoryConsent: true },
      "email-accept-token-1",
      context.bindings,
    );
    assert.equal(
      context.database.prepare("SELECT status FROM organization_requests WHERE id = ?")
        .get(emailRequest).status,
      "approved",
    );
  } finally {
    context.database.close();
  }
});

test("fresh idempotency keys cannot duplicate a pending account invitation or join request", async () => {
  const context = fixture();
  const owner = context.user(context.ids.owner, "owner@example.com");
  const joiner = context.user(context.ids.joiner, "joiner@example.com");
  try {
    await commands.cloudflareOrganizationCommand(
      owner,
      false,
      "invite_member",
      {
        organizationId: context.ids.organization,
        userId: context.ids.targeted,
        role: "student",
        token: "first-target-secret-abcdefghijklmnopqrstuvwxyz",
      },
      "duplicate-invite-01",
      context.bindings,
    );
    await expectConflict(
      commands.cloudflareOrganizationCommand(
        owner,
        false,
        "invite_member",
        {
          organizationId: context.ids.organization,
          userId: context.ids.targeted,
          role: "student",
          token: "second-target-secret-abcdefghijklmnopqrstuvwxyz",
        },
        "duplicate-invite-02",
        context.bindings,
      ),
      "An invitation for that account is already awaiting a response.",
    );
    assert.equal(
      context.database.prepare(`SELECT count(*) AS total FROM organization_requests
        WHERE kind = 'invitation' AND status = 'pending'`).get().total,
      1,
    );
    assert.equal(
      context.database.prepare(`SELECT count(*) AS total FROM user_notifications
        WHERE kind = 'organization_invitation'`).get().total,
      1,
    );

    await commands.cloudflareOrganizationCommand(
      joiner,
      false,
      "request_to_join",
      { organizationId: context.ids.organization, shareFutureHistoryConsent: true },
      "duplicate-join-0001",
      context.bindings,
    );
    const requestNotifications = context.database.prepare(`SELECT count(*) AS total
      FROM user_notifications WHERE kind = 'organization_request'`).get().total;
    await expectConflict(
      commands.cloudflareOrganizationCommand(
        joiner,
        false,
        "request_to_join",
        { organizationId: context.ids.organization, shareFutureHistoryConsent: true },
        "duplicate-join-0002",
        context.bindings,
      ),
      "Your join request is already awaiting review.",
    );
    assert.equal(
      context.database.prepare(`SELECT count(*) AS total FROM organization_requests
        WHERE kind = 'join' AND status = 'pending' AND requester_user_id = ?`)
        .get(context.ids.joiner).total,
      1,
    );
    assert.equal(
      context.database.prepare(`SELECT count(*) AS total FROM user_notifications
        WHERE kind = 'organization_request'`).get().total,
      requestNotifications,
    );
  } finally {
    context.database.close();
  }
});
