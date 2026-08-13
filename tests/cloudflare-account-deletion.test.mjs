import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const route = readFileSync(
  join(process.cwd(), "app", "api", "account", "delete", "route.ts"),
  "utf8",
);
const runtime = readFileSync(
  join(process.cwd(), "lib", "cloudflare", "account-deletion.ts"),
  "utf8",
);
const migration = readFileSync(
  join(process.cwd(), "cloudflare", "migrations", "0005_account_deletion.sql"),
  "utf8",
);
const copy = readFileSync(
  join(process.cwd(), "scripts", "migrate-supabase-to-cloudflare.mjs"),
  "utf8",
);
const recoveryRoute = readFileSync(
  join(process.cwd(), "app", "api", "admin", "account-deletions", "route.ts"),
  "utf8",
);
const payloads = readFileSync(
  join(process.cwd(), "lib", "cloudflare", "payloads.ts"),
  "utf8",
);

test("Supabase Auth remains the irreversible deletion authority", () => {
  const prepared = route.indexOf("prepareCloudflareAccountDeletion(user)");
  const authStarted = route.indexOf("beginCloudflareAccountAuthDeletion(");
  const authDeleted = route.indexOf("deleteAccount(user.id");
  const authConfirmed = route.lastIndexOf("confirmCloudflareAccountAuthDeleted(");
  const cleanupScheduled = route.lastIndexOf("scheduleCloudflareCleanup(");
  assert.ok(
    prepared >= 0
    && authStarted > prepared
    && authDeleted > authStarted
    && authConfirmed > authDeleted
    && cleanupScheduled > authConfirmed,
  );
  assert.doesNotMatch(
    route.slice(authDeleted),
    /cancelCloudflareAccountDeletion/,
    "an ambiguous external DELETE must retain its recovery tombstone",
  );
  assert.match(route, /cleanupPending: true[\s\S]*status: 202/);
});

test("confirmed deletion responds before potentially long D1 and R2 cleanup", () => {
  assert.match(route, /import \{ after, NextResponse \} from "next\/server"/);
  assert.match(
    route,
    /after\(async \(\) => \{[\s\S]*completeCloudflareAccountDeletion\(userId, operationId\)/,
  );
  assert.doesNotMatch(
    route.slice(route.indexOf("async function handlePOST")),
    /await completeCloudflareAccountDeletion/,
  );
  assert.match(runtime, /export async function confirmCloudflareAccountAuthDeleted/);
});

test("independent R2 namespaces are discovered in parallel before Auth deletion", () => {
  assert.match(
    runtime,
    /Promise\.all\([\s\S]*USER_OBJECT_PREFIXES\.map[\s\S]*listObjectPrefix/,
  );
  assert.match(runtime, /insertObjectKeys\(bindings, userId, prefixedKeys\.flat\(\)\)/);
});

test("either independent Cloudflare data domain activates cleanup", () => {
  assert.match(route, /cloudflareDataMode\(\) !== "supabase"\s*\|\| organizationDataMode\(\) !== "supabase"/);
  assert.doesNotMatch(route, /CLOUDFLARE_DATA_MODE|ORGANIZATION_DATA_MODE/);
});

test("D1 deletion is recoverable and R2 keys remain manifested until delete succeeds", () => {
  assert.match(migration, /CREATE TABLE account_deletion_tombstones/);
  assert.match(
    migration,
    /state IN \('prepared', 'auth_delete_started', 'auth_deleted', 'data_deleted', 'complete'\)/,
  );
  assert.match(migration, /CREATE TABLE account_deletion_objects/);
  assert.match(runtime, /await captureReferencedObjects\(bindings, user\.id\)/);
  assert.match(runtime, /await bindings\.files\.delete\(keys\)[\s\S]*DELETE FROM account_deletion_objects/);
  assert.match(runtime, /for \(let attempt = 0; attempt < 3/);
  assert.match(runtime, /D1 batch is transactional/);
});

test("in-flight user writes are frozen atomically and late R2 uploads join the manifest", () => {
  assert.match(migration, /subscriptions_deletion_update_guard/);
  assert.match(migration, /practice_attempts_deletion_insert_guard/);
  assert.match(migration, /organization_memberships_deletion_update_guard/);
  const put = payloads.indexOf("await bindings.files.put(key");
  const capture = payloads.indexOf("await captureDeletionRace(bindings, owner, key)");
  assert.ok(put >= 0 && capture > put);
  assert.match(payloads, /state <> 'complete'/);
  assert.match(payloads, /state === "complete"[\s\S]*bindings\.files\.delete\(objectKey\)/);
});

test("ambiguous Auth deletion has an owner-only fail-closed reconciliation path", () => {
  assert.match(runtime, /SET state = 'auth_delete_started'/);
  assert.match(recoveryRoute, /isAdminEmail/);
  assert.match(recoveryRoute, /supabaseAuthUserState/);
  assert.match(recoveryRoute, /authState === "unknown"[\s\S]*Nothing was changed/);
  assert.match(recoveryRoute, /authState === "deleted"|authState === "exists"/);
});

test("privacy cleanup covers profile, progress, attempts, subscriptions and migration copies", () => {
  for (const table of [
    "learner_profiles",
    "progress_snapshots",
    "practice_attempts",
    "subscriptions",
    "usage_events",
    "data_migration_row_map",
    "data_migration_source_rows",
  ]) {
    assert.match(runtime, new RegExp(`DELETE FROM ${table}`));
  }
  assert.match(runtime, /SET email = NULL, role = 'user', deleted_at = \?/);
  assert.match(runtime, /private\/avatars/);
  assert.match(runtime, /private\/progress\/ielts-prep-v1/);
});

test("privacy cleanup explicitly captures and purges durable attempt work", () => {
  assert.match(
    runtime,
    /SELECT \?, payload_object_key, \? FROM organization_attempt_sync_outbox/,
  );
  assert.match(
    runtime,
    /SELECT \?, object_key, \? FROM organization_attempt_object_cleanup/,
  );
  for (const table of [
    "organization_attempt_sync_outbox",
    "organization_attempt_object_cleanup",
    "organization_history_clear_watermarks",
  ]) {
    assert.match(runtime, new RegExp(`DELETE FROM ${table} WHERE user_id = \\?`));
  }
});

test("app-setting audit actors are anonymised with the retained account tombstone", () => {
  assert.match(runtime, /sqlite_schema[\s\S]*name = 'app_settings'/);
  assert.match(
    runtime,
    /UPDATE app_settings SET updated_by = NULL WHERE updated_by = \?/,
  );
  assert.match(runtime, /\.\.\.appSettingsScrub/);
});

test("notification and organization learning data close cleanly on account deletion", () => {
  assert.match(runtime, /DELETE FROM user_notifications WHERE recipient_user_id = \?/);
  assert.match(runtime, /UPDATE user_notifications SET actor_user_id = NULL WHERE actor_user_id = \?/);
  assert.match(
    runtime,
    /DELETE FROM organization_practice_assignments WHERE student_user_id = \?/,
  );
  assert.match(
    runtime,
    /UPDATE organization_practice_assignments SET assigned_by_user_id = NULL WHERE assigned_by_user_id = \?/,
  );
  assert.match(
    runtime,
    /DELETE FROM organization_teacher_feedback WHERE student_user_id = \?/,
  );
  assert.match(
    runtime,
    /UPDATE organization_teacher_feedback SET teacher_user_id = NULL WHERE teacher_user_id = \?/,
  );

  const notificationDelete = runtime.indexOf(
    'DELETE FROM user_notifications WHERE recipient_user_id = ?',
  );
  const notificationScrub = runtime.indexOf(
    'UPDATE user_notifications SET actor_user_id = NULL WHERE actor_user_id = ?',
  );
  const sourceAttemptDelete = runtime.indexOf(
    'DELETE FROM practice_attempts WHERE user_id = ?',
  );
  assert.ok(notificationDelete >= 0 && notificationScrub > notificationDelete);
  assert.ok(sourceAttemptDelete > notificationScrub);
});

test("migration evidence is subject-tagged and purged only after auth deletion", () => {
  assert.match(migration, /subject_user_ids_json/);
  assert.match(migration, /deletion\.state IN \('auth_deleted', 'data_deleted', 'complete'\)/);
  assert.match(copy, /subjectUserIds: \(row\) => \[row\.id\]/);
  assert.match(copy, /subject_user_ids_json\) VALUES/);
  assert.match(copy, /providerEventSubjects/);
});

test("organization audit and permanent-removal evidence remain immutable", () => {
  assert.doesNotMatch(runtime, /DELETE FROM organization_audit_log/);
  assert.doesNotMatch(runtime, /DELETE FROM organization_attempt_tombstones/);
  assert.match(migration, /Organization audit and removal tombstones intentionally[\s\S]*remain immutable/);
});
