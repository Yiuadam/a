import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

test("practice assignments and teacher feedback emit private notifications in their atomic command batches", () => {
  const source = read("lib/cloudflare/organization-commands.ts");
  const practice = between(
    source,
    'if (\n    action === "assign_practice"',
    'if (action === "save_teacher_feedback" || action === "remove_teacher_feedback")',
  );
  const feedback = between(
    source,
    'if (action === "save_teacher_feedback" || action === "remove_teacher_feedback")',
    'if (\n    action === "change_member_role"',
  );

  assert.match(practice, /action === "assign_practice_batch"/);
  assert.match(practice, /runBatch\(db, statements/);
  assert.match(practice, /kind: "practice_assigned"/);
  assert.match(practice, /recipientUserId: studentId/);
  assert.match(practice, /entityId: assignmentId/);
  assert.match(practice, /practice_assignment_batch/);
  assert.match(feedback, /kind: "teacher_feedback"/);
  assert.match(feedback, /recipientUserId: attempt\.user_id/);
  assert.match(feedback, /eventId: `feedback:\$\{attemptId\}:\$\{user\.id\}:\$\{idempotencyKey\}`/);
  assert.doesNotMatch(feedback, /eventId: message|entityId: message/);
});

test("attempt sync emits one replay-safe completion event using the canonical stored attempt", () => {
  const source = read("lib/cloudflare/organizations.ts");
  const sync = between(
    source,
    "export async function syncCloudflareOrganizationAttempts",
    "export async function cloudflareHistoryClearAllowed",
  );

  assert.match(sync, /const attemptId = crypto\.randomUUID\(\)/);
  assert.match(sync, /sourceKey: source/);
  assert.match(sync, /assignmentCompletionNotificationStatement\(bindings\.db/);
  assert.match(sync, /practiceKind: result\.module/);
  assert.match(sync, /submittedAt: result\.date/);
  assert.ok(
    sync.indexOf("assignmentCompletionNotificationStatement") < sync.indexOf("INSERT INTO organization_sync_receipts"),
    "completion event must share the attempt/receipt batch",
  );

  const helper = read("lib/cloudflare/notifications.ts");
  assert.match(helper, /attempt\.user_id = \? AND attempt\.source_key = \?/);
  assert.match(helper, /'assignment_completed:' \|\| pa\.assigned_by_user_id \|\| ':' \|\| pa\.id/);
  assert.doesNotMatch(helper, /'assignment_completed:'[^\n]*attempt\.id/);
});

test("student organization requests notify only their authorized decision makers", () => {
  const source = read("lib/cloudflare/organization-commands.ts");
  for (const kind of ["join", "leave", "history_access_change"]) {
    assert.match(source, new RegExp(`requestKind: "${kind}"`));
  }
  const helper = read("lib/cloudflare/notifications.ts");
  assert.match(helper, /membership\.role IN \('owner', 'manager'\)/);
  assert.match(helper, /teacher\.student_user_id = \?/);
  assert.match(helper, /\? = 'history_access_change'/);
  assert.match(helper, /recipient\.user_id <> \?/);
});
