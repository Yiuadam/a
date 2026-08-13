import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const notifications = await load("lib", "cloudflare", "notifications.ts");
const migration = readFileSync(
  join(process.cwd(), "cloudflare", "migrations", "0011_organization_notifications.sql"),
  "utf8",
);
const route = readFileSync(
  join(process.cwd(), "app", "api", "account", "notifications", "route.ts"),
  "utf8",
);

function fakeDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = { sql, values };
          statements.push(statement);
          return statement;
        },
      };
    },
  };
}

function sqliteAdapter() {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return { sql, values };
        },
      };
    },
  };
}

function runtimeD1(database) {
  const execute = (statement) => {
    const prepared = database.prepare(statement.sql);
    if (/^\s*(?:SELECT|WITH)\b/i.test(statement.sql)) {
      return { success: true, results: prepared.all(...statement.values), meta: { changes: 0 } };
    }
    const result = prepared.run(...statement.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute({ sql, values }); },
    async first() { return database.prepare(sql).get(...values) ?? null; },
  });
  return {
    prepare(sql) {
      return { bind: (...values) => bound(sql, values) };
    },
    async batch(statements) {
      return statements.map(execute);
    },
  };
}

test("notification schema is typed, private and indexed for one recipient", () => {
  assert.match(migration, /CREATE TABLE user_notifications/);
  assert.match(migration, /recipient_user_id TEXT NOT NULL REFERENCES app_users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /kind TEXT NOT NULL CHECK \(kind IN/);
  for (const kind of notifications.NOTIFICATION_KINDS) assert.match(migration, new RegExp(`'${kind}'`));
  assert.match(migration, /dedupe_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /user_notifications_recipient_unread_idx/);
  assert.match(migration, /organization_practice_assignments_completion_idx[\s\S]*student_user_id, module, assigned_at/);
  const schemaWithoutComments = migration.replaceAll(/--.*$/gm, "");
  assert.doesNotMatch(schemaWithoutComments, /\b(?:email|message|body|title)\b/i);
});

test("a source command can enqueue a content-free notification in its D1 batch", () => {
  const db = fakeDb();
  const statement = notifications.notificationInsertStatement(db, {
    kind: "practice_assigned",
    recipientUserId: "50000000-0000-4000-8000-000000000002",
    actorUserId: "50000000-0000-4000-8000-000000000001",
    organizationId: "11111111-1111-4111-8111-111111111111",
    entityId: "a0000000-0000-4000-8000-000000000099",
    eventId: "assignment:a0000000-0000-4000-8000-000000000099",
    createdAt: "2026-08-13T12:00:00.000Z",
  });
  assert.match(statement.sql, /INSERT INTO user_notifications/);
  assert.match(statement.sql, /ON CONFLICT\(dedupe_key\) DO NOTHING/);
  assert.ok(statement.values.includes("practice_assigned"));
  assert.equal(statement.values.some((value) => typeof value === "string" && value.includes("@")), false);
});

test("assignment completion fanout is one set-based, idempotent statement", () => {
  const db = fakeDb();
  const statement = notifications.assignmentCompletionNotificationStatement(db, {
    studentUserId: "50000000-0000-4000-8000-000000000002",
    sourceKey: "preview-speaking-current",
    practiceKind: "speaking",
    practiceId: "next-speaking",
    submittedAt: "2026-08-13T12:00:00.000Z",
    createdAt: "2026-08-13T12:00:01.000Z",
  });
  assert.match(statement.sql, /INSERT INTO user_notifications[\s\S]*SELECT/);
  assert.match(statement.sql, /FROM organization_practice_assignments/);
  assert.match(statement.sql, /attempt\.source_key = \?/);
  assert.match(statement.sql, /membership\.share_future_history = 1/);
  assert.match(statement.sql, /assigner_membership\.status IN \('active', 'leave_requested'\)/);
  assert.match(statement.sql, /assignment\.teacher_user_id = pa\.assigned_by_user_id/);
  assert.match(statement.sql, /assignment\.revoked_at IS NULL/);
  assert.match(statement.sql, /ON CONFLICT\(dedupe_key\) DO NOTHING/);
  assert.doesNotMatch(statement.sql, /pa\.id \|\| ':' \|\| attempt\.id/);
});

test("organization requests fan out only to decision-makers in one statement", () => {
  const db = fakeDb();
  const statement = notifications.organizationRequestNotificationStatement(db, {
    organizationId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "50000000-0000-4000-8000-000000000002",
    requestId: "60000000-0000-4000-8000-000000000001",
    requestKind: "history_access_change",
    createdAt: "2026-08-13T12:00:00.000Z",
  });
  assert.match(statement.sql, /membership\.role IN \('owner', 'manager'\)/);
  assert.match(statement.sql, /UNION[\s\S]*teacher_student_assignments/);
  assert.match(statement.sql, /teacher\.revoked_at IS NULL/);
  assert.match(statement.sql, /history_access_change/);
});

test("completion SQL resolves the canonical upserted attempt and notifies once per assignment", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_users (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE account_deletion_tombstones (user_id TEXT PRIMARY KEY);
    CREATE TABLE organization_memberships (
      organization_id TEXT, user_id TEXT, status TEXT, share_future_history INTEGER,
      joined_at TEXT, created_at TEXT, role TEXT, PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE teacher_student_assignments (
      organization_id TEXT, teacher_user_id TEXT, student_user_id TEXT, revoked_at TEXT
    );
    CREATE TABLE organization_practice_assignments (
      id TEXT PRIMARY KEY, organization_id TEXT, assigned_by_user_id TEXT,
      student_user_id TEXT, module TEXT, test_id TEXT, test_title TEXT,
      due_at TEXT, assigned_at TEXT
    );
    CREATE TABLE practice_attempts (
      id TEXT PRIMARY KEY, user_id TEXT, source_key TEXT, module TEXT,
      test_id TEXT, submitted_at TEXT, UNIQUE(user_id, source_key)
    );
  `);
  database.exec(migration);
  const teacher = "50000000-0000-4000-8000-000000000001";
  const student = "50000000-0000-4000-8000-000000000002";
  const organization = "11111111-1111-4111-8111-111111111111";
  const assignment = "a0000000-0000-4000-8000-000000000099";
  const canonicalAttempt = "a0000000-0000-4000-8000-000000000001";
  database.prepare("INSERT INTO app_users(id) VALUES (?), (?)").run(teacher, student);
  database.prepare("INSERT INTO organizations(id,name) VALUES (?,?)")
    .run(organization, "Harbour English Academy");
  database.prepare(`INSERT INTO organization_memberships
    (organization_id,user_id,status,share_future_history,joined_at,created_at,role)
    VALUES (?,?,?,?,?,?,?)`).run(
      organization, student, "active", 1,
      "2026-07-12T09:00:00.000Z", "2026-07-12T09:00:00.000Z", "student",
    );
  database.prepare(`INSERT INTO organization_memberships
    (organization_id,user_id,status,share_future_history,joined_at,created_at,role)
    VALUES (?,?,?,?,?,?,?)`).run(
      organization, teacher, "active", 1,
      "2026-07-06T09:00:00.000Z", "2026-07-06T09:00:00.000Z", "teacher",
    );
  database.prepare(`INSERT INTO teacher_student_assignments
    (organization_id,teacher_user_id,student_user_id,revoked_at)
    VALUES (?,?,?,NULL)`).run(organization, teacher, student);
  database.prepare(`INSERT INTO organization_practice_assignments
    (id,organization_id,assigned_by_user_id,student_user_id,module,test_id,test_title,due_at,assigned_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      assignment, organization, teacher, student, "speaking", "next-speaking",
      "Speaking · next interview", null, "2026-08-12T09:00:00.000Z",
    );
  database.prepare(`INSERT INTO practice_attempts
    (id,user_id,source_key,module,test_id,submitted_at) VALUES (?,?,?,?,?,?)`).run(
      canonicalAttempt, student, "stable-source-key", "speaking", "speaking-live",
      "2026-08-13T12:00:00.000Z",
    );
  const statement = notifications.assignmentCompletionNotificationStatement(
    sqliteAdapter(),
    {
      studentUserId: student,
      sourceKey: "stable-source-key",
      practiceKind: "speaking",
      practiceId: "speaking-live",
      submittedAt: "2026-08-13T12:00:00.000Z",
      createdAt: "2026-08-13T12:00:01.000Z",
    },
  );
  database.prepare(statement.sql).run(...statement.values);
  database.prepare(statement.sql).run(...statement.values);
  const rows = database.prepare(`SELECT id, entity_id, related_entity_id
    FROM user_notifications`).all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(rows[0].entity_id, canonicalAttempt);
  assert.equal(rows[0].related_entity_id, assignment);
  database.prepare(`UPDATE teacher_student_assignments SET revoked_at = ?
    WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?`).run(
      "2026-08-13T12:00:02.000Z", organization, teacher, student,
    );
  database.prepare("DELETE FROM user_notifications").run();
  database.prepare(statement.sql).run(...statement.values);
  assert.equal(
    database.prepare("SELECT count(*) AS total FROM user_notifications").get().total,
    0,
    "a former assigned teacher must not receive a completion notification",
  );
  database.close();
});

test("notification pagination and cursors are bounded and deterministic", () => {
  assert.equal(notifications.normalizeNotificationLimit(null), 20);
  assert.equal(notifications.normalizeNotificationLimit("50"), 50);
  assert.equal(notifications.normalizeNotificationLimit("51"), 0);
  assert.deepEqual(
    notifications.parseNotificationCursor(
      "2026-08-13T12:00:00.000Z~a0000000-0000-4000-8000-000000000001",
    ),
    {
      createdAt: "2026-08-13T12:00:00.000Z",
      id: "a0000000-0000-4000-8000-000000000001",
    },
  );
  assert.equal(notifications.parseNotificationCursor("bad"), "invalid");
});

test("each notification kind resolves to its exact attention target", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_users (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE learner_profiles (user_id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE usernames (user_id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE account_deletion_tombstones (user_id TEXT PRIMARY KEY);
    CREATE TABLE organization_practice_assignments (
      id TEXT PRIMARY KEY, organization_id TEXT, assigned_by_user_id TEXT,
      student_user_id TEXT, module TEXT, test_id TEXT, test_title TEXT,
      due_at TEXT, assigned_at TEXT
    );
    CREATE TABLE practice_attempts (
      id TEXT PRIMARY KEY, user_id TEXT, module TEXT, test_id TEXT, submitted_at TEXT
    );
  `);
  database.exec(migration);

  const recipient = "50000000-0000-4000-8000-000000000001";
  const actor = "50000000-0000-4000-8000-000000000002";
  const student = "50000000-0000-4000-8000-000000000003";
  const organization = "11111111-1111-4111-8111-111111111111";
  const speakingAssignment = "a0000000-0000-4000-8000-000000000001";
  const listeningAssignment = "a0000000-0000-4000-8000-000000000002";
  const feedbackAttempt = "b0000000-0000-4000-8000-000000000001";
  const completedAttempt = "b0000000-0000-4000-8000-000000000002";
  const request = "60000000-0000-4000-8000-000000000001";
  const invitation = "60000000-0000-4000-8000-000000000002";
  database.prepare("INSERT INTO app_users(id) VALUES (?),(?),(?)")
    .run(recipient, actor, student);
  database.prepare("INSERT INTO organizations(id,name) VALUES (?,?)")
    .run(organization, "Harbour English Academy");
  database.prepare(`INSERT INTO organization_practice_assignments
    (id,organization_id,assigned_by_user_id,student_user_id,module,test_id,test_title,due_at,assigned_at)
    VALUES (?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?)`).run(
      speakingAssignment, organization, actor, recipient, "speaking", "next-speaking",
      "Speaking · next interview", null, "2026-08-13T10:00:00.000Z",
      listeningAssignment, organization, actor, recipient, "listening", "listening-1",
      "Listening · Booking a Badminton Class", null, "2026-08-13T10:01:00.000Z",
    );
  database.prepare(`INSERT INTO practice_attempts
    (id,user_id,module,test_id,submitted_at) VALUES (?,?,?,?,?),(?,?,?,?,?)`).run(
      feedbackAttempt, recipient, "writing", "writing-task-2", "2026-08-13T11:00:00.000Z",
      completedAttempt, student, "listening", "listening-1", "2026-08-13T11:01:00.000Z",
    );

  const rows = [
    {
      id: "83000000-0000-4000-8000-000000000001",
      kind: "practice_assigned",
      entityId: speakingAssignment,
      relatedEntityId: null,
      expected: `/speaking?assignment=${speakingAssignment}&from=notification`,
    },
    {
      id: "83000000-0000-4000-8000-000000000002",
      kind: "practice_assigned",
      entityId: listeningAssignment,
      relatedEntityId: null,
      expected: `/practice/listening?id=listening-1&assignment=${listeningAssignment}&from=notification`,
    },
    {
      id: "83000000-0000-4000-8000-000000000003",
      kind: "teacher_feedback",
      entityId: feedbackAttempt,
      relatedEntityId: null,
      expected: `/organization?organization=${organization}&focus=teacher-feedback&attempt=${feedbackAttempt}`,
    },
    {
      id: "83000000-0000-4000-8000-000000000004",
      kind: "assignment_completed",
      entityId: completedAttempt,
      relatedEntityId: listeningAssignment,
      expected: `/organization/students/${student}/sittings/${completedAttempt}?organization=${organization}&focus=assignment-completed`,
    },
    {
      id: "83000000-0000-4000-8000-000000000005",
      kind: "organization_request",
      entityId: request,
      relatedEntityId: "leave",
      expected: `/organization?organization=${organization}&section=requests&request=${request}&focus=request&requestKind=leave`,
    },
    {
      id: "83000000-0000-4000-8000-000000000006",
      kind: "organization_invitation",
      entityId: invitation,
      relatedEntityId: null,
      expected: `/organization/invite?request=${invitation}`,
    },
  ];
  const insert = database.prepare(`INSERT INTO user_notifications
    (id,recipient_user_id,actor_user_id,organization_id,kind,entity_id,related_entity_id,dedupe_key,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  rows.forEach((row, index) => insert.run(
    row.id, recipient, actor, organization, row.kind, row.entityId, row.relatedEntityId,
    `attention-target:${index}`, `2026-08-13T12:0${index}:00.000Z`,
  ));

  const page = await notifications.listCloudflareNotifications(
    { id: recipient }, { limit: 20, cursor: null }, { db: runtimeD1(database), files: {} },
  );
  const byId = new Map(page.notifications.map((item) => [item.id, item]));
  for (const row of rows) assert.equal(byId.get(row.id)?.actionPath, row.expected, row.kind);
  assert.equal(byId.get(rows[4].id)?.requestKind, "leave");
  assert.equal(byId.get(rows[3].id)?.requestKind, null);
  database.close();
});

test("notification reads and read-state updates are isolated to the recipient", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_users (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE learner_profiles (user_id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE usernames (user_id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE account_deletion_tombstones (user_id TEXT PRIMARY KEY);
    CREATE TABLE organization_practice_assignments (
      id TEXT PRIMARY KEY, organization_id TEXT, assigned_by_user_id TEXT,
      student_user_id TEXT, module TEXT, test_id TEXT, test_title TEXT,
      due_at TEXT, assigned_at TEXT
    );
    CREATE TABLE practice_attempts (
      id TEXT PRIMARY KEY, user_id TEXT, module TEXT, test_id TEXT, submitted_at TEXT
    );
  `);
  database.exec(migration);
  const student = "50000000-0000-4000-8000-000000000002";
  const teacher = "50000000-0000-4000-8000-000000000003";
  const outsider = "50000000-0000-4000-8000-000000000004";
  const organization = "11111111-1111-4111-8111-111111111111";
  const studentNotice = "83000000-0000-4000-8000-000000000001";
  const teacherNotice = "83000000-0000-4000-8000-000000000002";
  database.prepare("INSERT INTO app_users(id) VALUES (?),(?),(?)").run(student, teacher, outsider);
  database.prepare("INSERT INTO organizations(id,name) VALUES (?,?)")
    .run(organization, "Harbour English Academy");
  database.prepare(`INSERT INTO user_notifications
    (id,recipient_user_id,actor_user_id,organization_id,kind,entity_id,dedupe_key,created_at)
    VALUES (?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?)`).run(
      studentNotice, student, teacher, organization, "organization_invitation",
      "60000000-0000-4000-8000-000000000001", `invite:${student}`, "2026-08-13T12:00:00.000Z",
      teacherNotice, teacher, student, organization, "organization_request",
      "60000000-0000-4000-8000-000000000002", `request:${teacher}`, "2026-08-13T12:01:00.000Z",
    );
  const bindings = { db: runtimeD1(database), files: {} };

  const studentPage = await notifications.listCloudflareNotifications(
    { id: student }, { limit: 20, cursor: null }, bindings,
  );
  const teacherPage = await notifications.listCloudflareNotifications(
    { id: teacher }, { limit: 20, cursor: null }, bindings,
  );
  const outsiderPage = await notifications.listCloudflareNotifications(
    { id: outsider }, { limit: 20, cursor: null }, bindings,
  );
  assert.deepEqual(studentPage.notifications.map((item) => item.id), [studentNotice]);
  assert.equal(
    studentPage.notifications[0].actionPath,
    "/organization/invite?request=60000000-0000-4000-8000-000000000001",
  );
  assert.deepEqual(teacherPage.notifications.map((item) => item.id), [teacherNotice]);
  assert.equal(
    teacherPage.notifications[0].actionPath,
    `/organization?organization=${organization}&section=requests`
      + "&request=60000000-0000-4000-8000-000000000002&focus=request",
  );
  assert.deepEqual(outsiderPage.notifications, []);

  assert.equal(
    await notifications.markCloudflareNotificationsRead({ id: outsider }, studentNotice, bindings),
    0,
  );
  assert.equal(
    database.prepare("SELECT read_at FROM user_notifications WHERE id = ?").get(studentNotice).read_at,
    null,
  );
  assert.equal(
    await notifications.markCloudflareNotificationsRead({ id: student }, studentNotice, bindings),
    0,
  );
  assert.notEqual(
    database.prepare("SELECT read_at FROM user_notifications WHERE id = ?").get(studentNotice).read_at,
    null,
  );
  database.close();
});

test("notification API is private, user-scoped and preview mutations fail closed", () => {
  assert.match(route, /Cache-Control": "private, no-store, max-age=0/);
  assert.match(route, /organizationPreviewUser/);
  assert.match(route, /auth\.preview[\s\S]*shared preview is read-only/i);
  assert.match(route, /markCloudflareNotificationsRead\(auth\.user, notificationId\)/);
  assert.doesNotMatch(route, /error\.message|String\(error\)/);
});

test("account deletion guards cover notification insert and read-state update", () => {
  assert.match(migration, /user_notifications_deletion_insert_guard/);
  assert.match(migration, /user_notifications_deletion_update_guard/);
  assert.match(migration, /NEW\.recipient_user_id/);
  assert.match(migration, /NEW\.actor_user_id/);
});
