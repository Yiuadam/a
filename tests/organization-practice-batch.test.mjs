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
    teacher: "50000000-0000-4000-8000-000000000001",
    firstStudent: "50000000-0000-4000-8000-000000000002",
    secondStudent: "50000000-0000-4000-8000-000000000003",
    unassignedStudent: "50000000-0000-4000-8000-000000000004",
  };
  const now = "2026-08-13T12:00:00.000Z";
  const insertUser = database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `);
  for (const [key, userId] of Object.entries(ids)) {
    if (key === "organization") continue;
    insertUser.run(userId, `${key}@example.com`, now, now);
  }
  database.prepare(`
    INSERT INTO organizations (
      id, application_id, name, slug, status, created_by,
      created_at, updated_at, join_code
    ) VALUES (?, NULL, 'Harbour English Academy', NULL, 'active', ?, ?, ?, NULL)
  `).run(ids.organization, ids.teacher, now, now);
  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?)
  `);
  insertMembership.run(
    "70000000-0000-4000-8000-000000000001",
    ids.organization, ids.teacher, "teacher", now, now, now, now,
  );
  for (const [index, studentId] of [
    ids.firstStudent,
    ids.secondStudent,
    ids.unassignedStudent,
  ].entries()) {
    insertMembership.run(
      `70000000-0000-4000-8000-00000000000${index + 2}`,
      ids.organization, studentId, "student", now, now, now, now,
    );
  }
  const insertTeacherAssignment = database.prepare(`
    INSERT INTO teacher_student_assignments (
      id, organization_id, teacher_user_id, student_user_id,
      assigned_by, created_at, revoked_at, revoked_by
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `);
  insertTeacherAssignment.run(
    "80000000-0000-4000-8000-000000000001",
    ids.organization, ids.teacher, ids.firstStudent, ids.teacher, now,
  );
  insertTeacherAssignment.run(
    "80000000-0000-4000-8000-000000000002",
    ids.organization, ids.teacher, ids.secondStudent, ids.teacher, now,
  );
  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
    ids,
    teacher: { id: ids.teacher, email: "teacher@example.com" },
  };
}

function payload(ids, students) {
  return {
    organizationId: ids.organization,
    studentUserIds: students,
    skill: "listening",
    testId: "listening-1",
    note: "Complete before class.",
    dueAt: "2026-08-20T09:00:00.000Z",
  };
}

test("a teacher assigns one practice to multiple assigned students atomically and idempotently", async () => {
  const context = fixture();
  const selected = [context.ids.firstStudent, context.ids.secondStudent];
  try {
    await commands.cloudflareOrganizationCommand(
      context.teacher,
      false,
      "assign_practice_batch",
      payload(context.ids, selected),
      "practice-batch-0001",
      context.bindings,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_practice_assignments").get().total,
      2,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM user_notifications WHERE kind = 'practice_assigned'").get().total,
      2,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_audit_log WHERE action = 'assign_practice_batch'").get().total,
      1,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_command_receipts WHERE action = 'assign_practice_batch'").get().total,
      1,
    );

    await commands.cloudflareOrganizationCommand(
      context.teacher,
      false,
      "assign_practice_batch",
      payload(context.ids, selected),
      "practice-batch-0001",
      context.bindings,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_practice_assignments").get().total,
      2,
      "replaying the same command cannot duplicate work",
    );
  } finally {
    context.database.close();
  }
});

test("a teacher cannot batch work to an unassigned student and no partial rows are written", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.teacher,
        false,
        "assign_practice_batch",
        payload(context.ids, [context.ids.firstStudent, context.ids.unassignedStudent]),
        "practice-batch-0002",
        context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 403,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_practice_assignments").get().total,
      0,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM user_notifications").get().total,
      0,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_command_receipts").get().total,
      0,
    );
  } finally {
    context.database.close();
  }
});

test("a D1 write failure rolls back every assignment, notification, audit and receipt", async () => {
  const context = fixture();
  const selected = [context.ids.firstStudent, context.ids.secondStudent];
  context.database.exec(`
    CREATE TRIGGER reject_second_practice
    BEFORE INSERT ON organization_practice_assignments
    WHEN NEW.student_user_id = '${context.ids.secondStudent}'
    BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END;
  `);
  try {
    await assert.rejects(commands.cloudflareOrganizationCommand(
      context.teacher,
      false,
      "assign_practice_batch",
      payload(context.ids, selected),
      "practice-batch-0003",
      context.bindings,
    ));
    for (const table of [
      "organization_practice_assignments",
      "user_notifications",
      "organization_audit_log",
      "organization_command_receipts",
    ]) {
      assert.equal(
        context.database.prepare(`SELECT count(*) AS total FROM ${table}`).get().total,
        0,
        `${table} must roll back with the failed batch`,
      );
    }

    context.database.exec("DROP TRIGGER reject_second_practice");
    await commands.cloudflareOrganizationCommand(
      context.teacher,
      false,
      "assign_practice_batch",
      payload(context.ids, selected),
      "practice-batch-0003",
      context.bindings,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_practice_assignments").get().total,
      2,
      "a failed command leaves no receipt that blocks a safe retry",
    );
  } finally {
    context.database.close();
  }
});
