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
const actions = await import(pathToFileURL(
  join(process.cwd(), "lib", "organizations", "actions.ts"),
).href);
const payloads = await import(pathToFileURL(
  join(process.cwd(), "lib", "organizations", "action-payloads.ts"),
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

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  otherOrganization: "22222222-2222-4222-8222-222222222222",
  owner: "50000000-0000-4000-8000-000000000001",
  manager: "50000000-0000-4000-8000-000000000002",
  teacher: "50000000-0000-4000-8000-000000000003",
  student: "50000000-0000-4000-8000-000000000004",
  otherManager: "50000000-0000-4000-8000-000000000005",
  platformAdmin: "50000000-0000-4000-8000-000000000006",
  attempt: "90000000-0000-4000-8000-000000000001",
};

const now = "2026-08-14T04:00:00.000Z";

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
  for (const [label, userId] of Object.entries(ids)) {
    if (label === "organization" || label === "otherOrganization" || label === "attempt") continue;
    insertUser.run(userId, `${label.toLowerCase()}@example.com`, now, now);
  }

  const insertOrganization = database.prepare(`
    INSERT INTO organizations (
      id, application_id, name, slug, status, created_by,
      created_at, updated_at, join_code
    ) VALUES (?, NULL, ?, NULL, 'active', ?, ?, ?, ?)
  `);
  insertOrganization.run(
    ids.organization,
    "Harbour English Academy",
    ids.owner,
    now,
    now,
    "harbour-join-code",
  );
  insertOrganization.run(
    ids.otherOrganization,
    "Riverside English Academy",
    ids.otherManager,
    now,
    now,
    "riverside-code",
  );

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?)
  `);
  for (const [index, [userId, role]] of [
    [ids.owner, "owner"],
    [ids.manager, "manager"],
    [ids.teacher, "teacher"],
    [ids.student, "student"],
  ].entries()) {
    insertMembership.run(
      `70000000-0000-4000-8000-00000000000${index + 1}`,
      ids.organization,
      userId,
      role,
      now,
      now,
      now,
      now,
    );
  }
  insertMembership.run(
    "70000000-0000-4000-8000-000000000005",
    ids.otherOrganization,
    ids.otherManager,
    "manager",
    now,
    now,
    now,
    now,
  );

  database.prepare(`
    INSERT INTO organization_seat_pools (
      id, organization_id, provider, external_reference, seat_count,
      status, created_at, updated_at
    ) VALUES (?, ?, 'manual', 'manual-seat-contract', 10, 'active', ?, ?)
  `).run("71000000-0000-4000-8000-000000000001", ids.organization, now, now);
  database.prepare(`
    INSERT INTO organization_seat_allocations (
      id, organization_id, seat_pool_id, user_id, status, starts_at,
      allocated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    "72000000-0000-4000-8000-000000000001",
    ids.organization,
    "71000000-0000-4000-8000-000000000001",
    ids.student,
    now,
    ids.manager,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO teacher_student_assignments (
      id, organization_id, teacher_user_id, student_user_id,
      assigned_by, created_at, revoked_at, revoked_by
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    "73000000-0000-4000-8000-000000000001",
    ids.organization,
    ids.teacher,
    ids.student,
    ids.manager,
    now,
  );
  database.prepare(`
    INSERT INTO organization_requests (
      id, organization_id, kind, status, requester_user_id,
      target_user_id, created_at, updated_at
    ) VALUES (?, ?, 'leave', 'pending', ?, ?, ?, ?)
  `).run(
    "74000000-0000-4000-8000-000000000001",
    ids.organization,
    ids.student,
    ids.student,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO practice_attempts (
      id, user_id, module, test_id, test_title, submitted_at,
      band, result_inline, result_object_key, result_sha256, result_bytes,
      created_at, updated_at, result_has_review
    ) VALUES (?, ?, 'writing', 'writing-1', 'Writing task 1', ?,
      7, NULL, ?, ?, 512, ?, ?, 1)
  `).run(
    ids.attempt,
    ids.student,
    now,
    `private/attempts/${ids.student}/retained-result.json`,
    "a".repeat(64),
    now,
    now,
  );
  database.prepare(`
    INSERT INTO organization_attempt_archives (
      organization_id, attempt_id, archived_by, reason, archived_at
    ) VALUES (?, ?, ?, 'Duplicate', ?)
  `).run(ids.organization, ids.attempt, ids.manager, now);
  database.prepare(`
    INSERT INTO organization_attempt_tombstones (
      organization_id, attempt_id, student_user_id, removed_by, reason, removed_at
    ) VALUES (?, ?, ?, ?, 'Record removed by manager', ?)
  `).run(
    ids.organization,
    "90000000-0000-4000-8000-000000000002",
    ids.student,
    ids.manager,
    now,
  );
  database.prepare(`
    INSERT INTO organization_practice_assignments (
      id, organization_id, assigned_by_user_id, student_user_id,
      module, test_id, test_title, assigned_at, updated_at
    ) VALUES (?, ?, ?, ?, 'writing', 'writing-1', 'Writing task 1', ?, ?)
  `).run(
    "75000000-0000-4000-8000-000000000001",
    ids.organization,
    ids.teacher,
    ids.student,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO organization_teacher_feedback (
      id, organization_id, attempt_id, student_user_id, teacher_user_id,
      message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Clear topic sentences.', ?, ?)
  `).run(
    "76000000-0000-4000-8000-000000000001",
    ids.organization,
    ids.attempt,
    ids.student,
    ids.teacher,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO user_notifications (
      id, recipient_user_id, actor_user_id, organization_id, kind,
      entity_id, dedupe_key, created_at
    ) VALUES (?, ?, ?, ?, 'teacher_feedback', ?, ?, ?)
  `).run(
    "77000000-0000-4000-8000-000000000001",
    ids.student,
    ids.teacher,
    ids.organization,
    "76000000-0000-4000-8000-000000000001",
    "teacher-feedback-delete-fixture",
    now,
  );
  database.prepare(`
    INSERT INTO organization_audit_log (
      id, organization_id, actor_user_id, action, target_type,
      target_id, metadata_json, created_at
    ) VALUES (?, ?, ?, 'fixture_created', 'organization', ?, '{}', ?)
  `).run(
    "78000000-0000-4000-8000-000000000001",
    ids.organization,
    ids.manager,
    ids.organization,
    now,
  );

  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
    user(userId, label) {
      return { id: userId, email: `${label}@example.com` };
    },
  };
}

function count(database, table, where = "", ...values) {
  return database.prepare(`SELECT count(*) AS total FROM ${table} ${where}`).get(...values).total;
}

test("organisation deletion is an explicit command", () => {
  assert.equal(actions.isOrganizationAction("delete_organization"), true);
  assert.deepEqual(
    payloads.organizationDeletionPayload(ids.organization, "  Harbour English Academy  "),
    {
      organizationId: ids.organization,
      confirmationName: "Harbour English Academy",
    },
  );
});

test("the command boundary requires the exact typed organisation name", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(ids.manager, "manager"),
        false,
        "delete_organization",
        {
          organizationId: ids.organization,
          confirmationName: "harbour english academy",
        },
        "delete-organization-wrong-name",
        context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 400
        && error.message === "Type the organisation name exactly to confirm deletion.",
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 1);
    assert.equal(count(context.database, "organization_audit_log", "WHERE action = 'delete_organization'"), 0);
    assert.equal(count(context.database, "organization_command_receipts", "WHERE action = 'delete_organization'"), 0);
  } finally {
    context.database.close();
  }
});

test("an active manager deletes only their organisation atomically while learner evidence survives", async () => {
  const context = fixture();
  const manager = context.user(ids.manager, "manager");
  try {
    const response = await commands.cloudflareOrganizationCommand(
      manager,
      false,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-0001",
      context.bindings,
    );
    assert.deepEqual(response, { ok: true });

    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 0);
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.otherOrganization), 1);
    for (const table of [
      "organization_seat_pools",
      "organization_seat_allocations",
      "organization_memberships",
      "teacher_student_assignments",
      "organization_requests",
      "organization_attempt_archives",
      "organization_practice_assignments",
      "organization_teacher_feedback",
      "user_notifications",
    ]) {
      assert.equal(
        count(context.database, table, "WHERE organization_id = ?", ids.organization),
        0,
        `${table} must be removed with the organisation`,
      );
    }

    const retainedAttempt = context.database.prepare(`
      SELECT result_object_key FROM practice_attempts WHERE id = ?
    `).get(ids.attempt);
    assert.equal(
      retainedAttempt.result_object_key,
      `private/attempts/${ids.student}/retained-result.json`,
      "organisation deletion must not delete learner-owned results or their R2 pointers",
    );
    assert.equal(
      count(context.database, "organization_attempt_tombstones", "WHERE organization_id = ?", ids.organization),
      1,
      "immutable removal evidence survives organisation deletion",
    );
    assert.equal(
      count(context.database, "organization_audit_log", "WHERE organization_id = ?", ids.organization),
      2,
      "the prior audit trail and deletion event survive",
    );
    const deletion = context.database.prepare(`
      SELECT metadata_json FROM organization_audit_log
       WHERE organization_id = ? AND action = 'delete_organization'
    `).get(ids.organization);
    assert.deepEqual(JSON.parse(deletion.metadata_json), {
      name: "Harbour English Academy",
      previousStatus: "active",
      actorRole: "manager",
    });

    await commands.cloudflareOrganizationCommand(
      manager,
      false,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-0001",
      context.bindings,
    );
    assert.equal(
      count(context.database, "organization_audit_log", "WHERE action = 'delete_organization'"),
      1,
      "replaying the same idempotency key cannot duplicate deletion evidence",
    );
    assert.equal(
      count(context.database, "organization_command_receipts", "WHERE action = 'delete_organization'"),
      1,
    );
  } finally {
    context.database.close();
  }
});

test("owners retain manager-level deletion authority", async () => {
  const context = fixture();
  try {
    await commands.cloudflareOrganizationCommand(
      context.user(ids.owner, "owner"),
      false,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-owner",
      context.bindings,
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 0);
  } finally {
    context.database.close();
  }
});

test("a manager cannot delete an organisation they do not manage", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(ids.otherManager, "othermanager"),
        false,
        "delete_organization",
        {
          organizationId: ids.organization,
          confirmationName: "Harbour English Academy",
        },
        "delete-organization-wrong-manager",
        context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 403
        && error.code === "forbidden",
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 1);
    assert.equal(count(context.database, "organization_memberships", "WHERE organization_id = ?", ids.organization), 4);
    assert.equal(count(context.database, "organization_audit_log", "WHERE action = 'delete_organization'"), 0);
    assert.equal(count(context.database, "organization_command_receipts", "WHERE action = 'delete_organization'"), 0);
  } finally {
    context.database.close();
  }
});

test("a live externally backed seat pool blocks deletion until provider cancellation", async () => {
  const context = fixture();
  const externalPoolId = "71000000-0000-4000-8000-000000000002";
  context.database.prepare(`
    INSERT INTO organization_seat_pools (
      id, organization_id, provider, external_reference, seat_count,
      status, created_at, updated_at, source_provider,
      source_external_subscription_id, source_status
    ) VALUES (?, ?, 'stripe', 'sub_live_example', 25,
      'active', ?, ?, 'stripe', 'sub_live_example', 'active')
  `).run(externalPoolId, ids.organization, now, now);
  const manager = context.user(ids.manager, "manager");
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        manager,
        false,
        "delete_organization",
        {
          organizationId: ids.organization,
          confirmationName: "Harbour English Academy",
        },
        "delete-organization-live-billing",
        context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 409
        && error.code === "conflict"
        && error.message === "Cancel this organisation's external seat subscription before deleting it.",
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 1);
    assert.equal(count(context.database, "organization_seat_pools", "WHERE id = ?", externalPoolId), 1);
    assert.equal(count(context.database, "organization_audit_log", "WHERE action = 'delete_organization'"), 0);
    assert.equal(count(context.database, "organization_command_receipts", "WHERE action = 'delete_organization'"), 0);

    context.database.prepare(`
      UPDATE organization_seat_pools
         SET status = 'cancelled', source_status = 'cancelled'
       WHERE id = ?
    `).run(externalPoolId);
    await commands.cloudflareOrganizationCommand(
      manager,
      false,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-live-billing",
      context.bindings,
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 0);
  } finally {
    context.database.close();
  }
});

test("a platform administrator can delete a suspended organisation without membership", async () => {
  const context = fixture();
  context.database.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?")
    .run(ids.organization);
  try {
    await commands.cloudflareOrganizationCommand(
      context.user(ids.platformAdmin, "platformadmin"),
      true,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-admin",
      context.bindings,
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 0);
    const deletion = context.database.prepare(`
      SELECT metadata_json FROM organization_audit_log
       WHERE organization_id = ? AND action = 'delete_organization'
    `).get(ids.organization);
    assert.equal(JSON.parse(deletion.metadata_json).actorRole, "platform_admin");
  } finally {
    context.database.close();
  }
});

test("a failed physical delete rolls back its audit event and receipt", async () => {
  const context = fixture();
  context.database.exec(`
    CREATE TRIGGER reject_organization_delete
    BEFORE DELETE ON organizations
    BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END;
  `);
  const manager = context.user(ids.manager, "manager");
  try {
    await assert.rejects(commands.cloudflareOrganizationCommand(
      manager,
      false,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-rollback",
      context.bindings,
    ));
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 1);
    assert.equal(count(context.database, "organization_audit_log", "WHERE action = 'delete_organization'"), 0);
    assert.equal(count(context.database, "organization_command_receipts", "WHERE action = 'delete_organization'"), 0);

    context.database.exec("DROP TRIGGER reject_organization_delete");
    await commands.cloudflareOrganizationCommand(
      manager,
      false,
      "delete_organization",
      {
        organizationId: ids.organization,
        confirmationName: "Harbour English Academy",
      },
      "delete-organization-rollback",
      context.bindings,
    );
    assert.equal(count(context.database, "organizations", "WHERE id = ?", ids.organization), 0);
  } finally {
    context.database.close();
  }
});
