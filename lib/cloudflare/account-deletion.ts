import type { SessionUser } from "@/lib/auth/session";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

export type CloudflareAccountDeletionState =
  | "prepared"
  | "auth_delete_started"
  | "auth_deleted"
  | "data_deleted"
  | "complete";

export type CloudflareAccountDeletionAuthAuthority = "supabase" | "cloudflare";
export type CloudflareNativeAccountState = "exists" | "deleted" | "unknown";

interface DeletionRow {
  user_id: string;
  operation_id: string;
  state: CloudflareAccountDeletionState;
  auth_authority: CloudflareAccountDeletionAuthAuthority;
  email_for_cleanup: string | null;
  lease_expires_at: string;
}

interface DeletionJobRow {
  user_id: string;
  operation_id: string;
  state: CloudflareAccountDeletionState;
  auth_authority: CloudflareAccountDeletionAuthAuthority;
  prepared_at: string;
  auth_delete_started_at: string | null;
  auth_deleted_at: string | null;
  data_deleted_at: string | null;
  completed_at: string | null;
  last_error_code: string | null;
  objects_discovered: number;
  objects_deleted: number;
  updated_at: string;
}

export interface CloudflareAccountDeletionPreparation {
  operationId: string;
  state: CloudflareAccountDeletionState;
  authAuthority: CloudflareAccountDeletionAuthAuthority;
}

export interface CloudflareAccountDeletionResult {
  complete: boolean;
  state: CloudflareAccountDeletionState;
}

export interface CloudflareAccountDeletionJob {
  userId: string;
  operationId: string;
  state: CloudflareAccountDeletionState;
  authAuthority: CloudflareAccountDeletionAuthAuthority;
  preparedAt: string;
  authDeleteStartedAt: string | null;
  authDeletedAt: string | null;
  dataDeletedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  objectsDiscovered: number;
  objectsDeleted: number;
  updatedAt: string;
}

export class CloudflareAccountDeletionInProgressError extends Error {
  constructor() {
    super("Account deletion is already in progress");
    this.name = "CloudflareAccountDeletionInProgressError";
  }
}

const PREPARE_LEASE_MS = 10 * 60 * 1000;
const R2_DELETE_BATCH = 1000;
const D1_DELETE_BIND_BATCH = 80;
const OBJECT_INSERT_BATCH = 25;
const USER_OBJECT_PREFIXES = [
  "private/avatars",
  "private/attempts",
  "private/subscriptions",
  "private/provider-events",
  "private/progress/ielts-prep-v1",
  "private/progress/bandup.drills.v1",
  "private/progress/bandup.lookups.v1",
  "private/replica-outbox",
] as const;

function now(): string {
  return new Date().toISOString();
}

function leaseExpiry(): string {
  return new Date(Date.now() + PREPARE_LEASE_MS).toISOString();
}

function safeObjectKey(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("private/")
    && value.length <= 1024;
}

async function deletionRow(
  bindings: BandUpCloudflareBindings,
  userId: string,
): Promise<DeletionRow | null> {
  return await bindings.db.prepare(`
    SELECT user_id, operation_id, state, auth_authority, email_for_cleanup, lease_expires_at
      FROM account_deletion_tombstones
     WHERE user_id = ?
  `).bind(userId).first<DeletionRow>();
}

function deletionJob(row: DeletionJobRow): CloudflareAccountDeletionJob {
  return {
    userId: row.user_id,
    operationId: row.operation_id,
    state: row.state,
    authAuthority: row.auth_authority,
    preparedAt: row.prepared_at,
    authDeleteStartedAt: row.auth_delete_started_at,
    authDeletedAt: row.auth_deleted_at,
    dataDeletedAt: row.data_deleted_at,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
    objectsDiscovered: Number(row.objects_discovered),
    objectsDeleted: Number(row.objects_deleted),
    updatedAt: row.updated_at,
  };
}

const DELETION_JOB_COLUMNS = `
  user_id, operation_id, state, auth_authority, prepared_at, auth_delete_started_at,
  auth_deleted_at, data_deleted_at, completed_at, last_error_code,
  objects_discovered, objects_deleted, updated_at
`;

export async function cloudflareAccountDeletionJob(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountDeletionJob | null> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT ${DELETION_JOB_COLUMNS}
      FROM account_deletion_tombstones WHERE user_id = ?
  `).bind(userId).first<DeletionJobRow>();
  return row ? deletionJob(row) : null;
}

export async function pendingCloudflareAccountDeletionJobs(
  limit = 100,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountDeletionJob[]> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const result = await bindings.db.prepare(`
    SELECT ${DELETION_JOB_COLUMNS}
      FROM account_deletion_tombstones
     WHERE state <> 'complete'
     ORDER BY updated_at ASC LIMIT ?
  `).bind(safeLimit).all<DeletionJobRow>();
  return result.results.map(deletionJob);
}

/**
 * Reads only the native D1 identity state for a deletion job explicitly
 * labelled as Cloudflare-owned. A missing/tombstoned app user is deleted;
 * anything the database cannot prove stays unknown and recovery fails closed.
 */
export async function cloudflareNativeAccountState(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareNativeAccountState> {
  try {
    const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
    const row = await bindings.db.prepare(`
      SELECT deleted_at FROM app_users WHERE id = ?
    `).bind(userId).first<{ deleted_at: string | null }>();
    return row && row.deleted_at === null ? "exists" : "deleted";
  } catch {
    return "unknown";
  }
}

async function insertObjectKeys(
  bindings: BandUpCloudflareBindings,
  userId: string,
  keys: readonly string[],
): Promise<void> {
  const clean = [...new Set(keys.filter(safeObjectKey))];
  const discoveredAt = now();
  for (let offset = 0; offset < clean.length; offset += OBJECT_INSERT_BATCH) {
    const page = clean.slice(offset, offset + OBJECT_INSERT_BATCH);
    const values = page.map(() => "(?, ?, ?)").join(",");
    const parameters = page.flatMap((key) => [userId, key, discoveredAt]);
    await bindings.db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (user_id, object_key, discovered_at)
      VALUES ${values}
    `).bind(...parameters).run();
  }
}

async function listObjectPrefix(
  bindings: BandUpCloudflareBindings,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bindings.files.list({ prefix, limit: 1000, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function captureReferencedObjects(
  bindings: BandUpCloudflareBindings,
  userId: string,
): Promise<void> {
  const stamp = now();
  const { db } = bindings;
  const sourceSubject = `EXISTS (
    SELECT 1 FROM json_each(data_migration_source_rows.subject_user_ids_json)
     WHERE value = ?
  )`;
  const subscriptionPrefix = `private/subscriptions/${userId}/`;
  const providerEventPrefix = `private/provider-events/${userId}/`;
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, avatar_object_key, ? FROM learner_profiles
       WHERE user_id = ? AND avatar_object_key IS NOT NULL
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, payload_object_key, ? FROM progress_snapshots
       WHERE user_id = ? AND payload_object_key IS NOT NULL
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, raw_object_key, ? FROM subscriptions
       WHERE user_id = ? AND raw_object_key IS NOT NULL
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, result_object_key, ? FROM practice_attempts
       WHERE user_id = ? AND result_object_key IS NOT NULL
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, payload_object_key, ? FROM organization_attempt_sync_outbox
       WHERE user_id = ? AND payload_object_key IS NOT NULL
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, object_key, ? FROM organization_attempt_object_cleanup
       WHERE user_id = ?
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, payload_object_key, ? FROM cloudflare_replica_outbox
       WHERE subject_user_id = ? AND payload_object_key IS NOT NULL
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, object_key, ? FROM cloudflare_replica_object_cleanup
       WHERE subject_user_id = ?
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, source_object_key, ? FROM data_migration_source_rows
       WHERE source_object_key IS NOT NULL AND ${sourceSubject}
    `).bind(userId, stamp, userId),
    db.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
      SELECT ?, provider_events.payload_object_key, ?
        FROM provider_events
       WHERE provider_events.payload_object_key IS NOT NULL
         AND (
           substr(provider_events.payload_object_key, 1, length(?)) = ?
           OR substr(provider_events.payload_object_key, 1, length(?)) = ?
           OR EXISTS (
             SELECT 1 FROM data_migration_source_rows
              WHERE table_name = 'provider_events'
                AND source_id = provider_events.provider || ':' || provider_events.event_id
                AND ${sourceSubject}
           )
         )
    `).bind(
      userId,
      stamp,
      subscriptionPrefix,
      subscriptionPrefix,
      providerEventPrefix,
      providerEventPrefix,
      userId,
    ),
  ]);

  // Prefix discovery also catches superseded avatar/progress objects no
  // longer referenced by D1 after a profile or snapshot replacement.
  // These prefixes are independent. Listing them concurrently avoids making
  // an account with several kinds of saved work wait for six complete R2
  // round trips in sequence before the Auth deletion may safely start.
  const prefixedKeys = await Promise.all(
    USER_OBJECT_PREFIXES.map((namespace) => (
      listObjectPrefix(bindings, `${namespace}/${userId}/`)
    )),
  );
  await insertObjectKeys(bindings, userId, prefixedKeys.flat());
}

async function cancelPreparedDeletion(
  bindings: BandUpCloudflareBindings,
  userId: string,
  operationId: string,
): Promise<void> {
  await bindings.db.prepare(`
    DELETE FROM account_deletion_tombstones
     WHERE user_id = ? AND operation_id = ? AND state = 'prepared'
  `).bind(userId, operationId).run();
}

/**
 * Freeze Cloudflare writes and build a complete D1/R2 deletion manifest before
 * the irreversible Supabase Auth deletion. Any preparation failure cancels
 * the freeze, so a reachable account is never left half-deleted.
 */
export async function prepareCloudflareAccountDeletion(
  user: SessionUser,
  providedBindings?: BandUpCloudflareBindings,
  authAuthority: CloudflareAccountDeletionAuthAuthority = "supabase",
): Promise<CloudflareAccountDeletionPreparation> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const operationId = crypto.randomUUID();
  const preparedAt = now();
  const inserted = await bindings.db.prepare(`
    INSERT OR IGNORE INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, email_for_cleanup, prepared_at,
      lease_expires_at, updated_at
    ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?)
  `).bind(
    user.id,
    operationId,
    authAuthority,
    user.email,
    preparedAt,
    leaseExpiry(),
    preparedAt,
  ).run();

  let owned = (inserted.meta.changes ?? 0) === 1;
  if (!owned) {
    const existing = await deletionRow(bindings, user.id);
    if (!existing) throw new Error("Cloudflare account deletion state is unavailable");
    if (existing.state !== "prepared") {
      return {
        operationId: existing.operation_id,
        state: existing.state,
        authAuthority: existing.auth_authority,
      };
    }

    const takeover = await bindings.db.prepare(`
      UPDATE account_deletion_tombstones
         SET operation_id = ?, auth_authority = ?, email_for_cleanup = ?, lease_expires_at = ?,
             last_error_code = NULL, updated_at = ?
       WHERE user_id = ? AND state = 'prepared' AND lease_expires_at <= ?
    `).bind(
      operationId,
      authAuthority,
      user.email,
      leaseExpiry(),
      preparedAt,
      user.id,
      preparedAt,
    ).run();
    owned = (takeover.meta.changes ?? 0) === 1;
    if (!owned) throw new CloudflareAccountDeletionInProgressError();
  }

  try {
    await captureReferencedObjects(bindings, user.id);
    const manifest = await bindings.db.prepare(`
      SELECT count(*) AS total FROM account_deletion_objects WHERE user_id = ?
    `).bind(user.id).first<{ total: number }>();
    const refreshed = now();
    const saved = await bindings.db.prepare(`
      UPDATE account_deletion_tombstones
         SET objects_discovered = ?, lease_expires_at = ?, updated_at = ?
       WHERE user_id = ? AND operation_id = ? AND state = 'prepared'
    `).bind(
      Number(manifest?.total ?? 0),
      leaseExpiry(),
      refreshed,
      user.id,
      operationId,
    ).run();
    if ((saved.meta.changes ?? 0) !== 1) {
      throw new Error("Cloudflare account deletion preparation lost its lease");
    }
    return { operationId, state: "prepared", authAuthority };
  } catch (error) {
    await cancelPreparedDeletion(bindings, user.id, operationId).catch(() => undefined);
    throw error;
  }
}

/** Cancel only a preparation owned by this request; an auth-deleted job wins. */
export async function cancelCloudflareAccountDeletion(
  userId: string,
  operationId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<void> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await cancelPreparedDeletion(bindings, userId, operationId);
}

/**
 * A Cloudflare-owned identity is still present in D1 after a crash between
 * the durable marker and local session invalidation. Re-open only that known
 * native job; a legacy Supabase job can never be rewound this way because its
 * external DELETE may already have succeeded.
 */
export async function reopenCloudflareNativeAccountDeletion(
  userId: string,
  operationId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const stamp = now();
  const result = await bindings.db.prepare(`
    UPDATE account_deletion_tombstones
       SET state = 'prepared', auth_delete_started_at = NULL,
           lease_expires_at = ?, last_error_code = NULL, updated_at = ?
     WHERE user_id = ? AND operation_id = ?
       AND auth_authority = 'cloudflare' AND state = 'auth_delete_started'
  `).bind(leaseExpiry(), stamp, userId, operationId).run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Persist the point of no safe cancellation before calling the selected
 * identity authority. A legacy external delete remains ambiguous after a
 * timeout; native jobs carry their authority in the tombstone and are
 * therefore separately recoverable from D1.
 * A timeout after the external DELETE can then be reconciled without ever
 * mistaking "unknown" for "the identity definitely still exists".
 */
export async function beginCloudflareAccountAuthDeletion(
  userId: string,
  operationId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountDeletionPreparation> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const stamp = now();
  await bindings.db.prepare(`
    UPDATE account_deletion_tombstones
       SET state = 'auth_delete_started', auth_delete_started_at = ?,
           lease_expires_at = ?, last_error_code = NULL, updated_at = ?
     WHERE user_id = ? AND operation_id = ? AND state = 'prepared'
  `).bind(stamp, stamp, stamp, userId, operationId).run();
  const row = await deletionRow(bindings, userId);
  if (!row || row.operation_id !== operationId) {
    throw new Error("Cloudflare account deletion operation does not match");
  }
  if (row.state !== "auth_delete_started") {
    throw new Error("Cloudflare account deletion could not start Auth deletion");
  }
  return { operationId, state: row.state, authAuthority: row.auth_authority };
}

async function markAuthDeleted(
  bindings: BandUpCloudflareBindings,
  userId: string,
  operationId: string,
): Promise<DeletionRow> {
  const stamp = now();
  await bindings.db.prepare(`
    UPDATE account_deletion_tombstones
       SET state = 'auth_deleted', auth_deleted_at = coalesce(auth_deleted_at, ?),
           last_error_code = NULL, updated_at = ?
     WHERE user_id = ? AND operation_id = ? AND state = 'auth_delete_started'
  `).bind(stamp, stamp, userId, operationId).run();
  const row = await deletionRow(bindings, userId);
  if (!row || row.operation_id !== operationId) {
    throw new Error("Cloudflare account deletion operation does not match");
  }
  return row;
}

/**
 * Record a confirmed identity deletion before slow D1/R2 cleanup moves
 * to background work. This is intentionally a small, idempotent D1 write.
 */
export async function confirmCloudflareAccountAuthDeleted(
  userId: string,
  operationId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountDeletionPreparation> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await markAuthDeleted(bindings, userId, operationId);
  return { operationId: row.operation_id, state: row.state, authAuthority: row.auth_authority };
}

async function purgeCloudflareRows(
  bindings: BandUpCloudflareBindings,
  row: DeletionRow,
): Promise<void> {
  if (row.state === "data_deleted" || row.state === "complete") return;
  if (row.state !== "auth_deleted") {
    throw new Error("Identity deletion is not recorded");
  }
  const { db } = bindings;
  const userId = row.user_id;
  const email = row.email_for_cleanup;
  const stamp = now();
  const subscriptionPrefix = `private/subscriptions/${userId}/`;
  const providerEventPrefix = `private/provider-events/${userId}/`;
  const sourceSubject = `EXISTS (
    SELECT 1 FROM json_each(data_migration_source_rows.subject_user_ids_json)
     WHERE value = ?
  )`;
  const sourceCount = await db.prepare(`
    SELECT count(*) AS total FROM data_migration_source_rows
     WHERE ${sourceSubject}
  `).bind(userId).first<{ total: number }>();
  // A Worker may reach production a few seconds before its additive D1
  // migration. Keep deletion compatible with that safe deployment order;
  // once the table exists the actor pointer is always scrubbed.
  const hasAppSettings = await db.prepare(`
    SELECT 1 AS present FROM sqlite_schema
     WHERE type = 'table' AND name = 'app_settings'
  `).first<{ present: number }>();
  const appSettingsScrub = hasAppSettings
    ? [db.prepare("UPDATE app_settings SET updated_by = NULL WHERE updated_by = ?").bind(userId)]
    : [];

  // D1 batch is transactional: a failed statement rolls this entire privacy
  // scrub back, while the tombstone/manifest still contains everything needed
  // for a retry. The immutable organization audit and removal tombstones are
  // intentionally absent from this list.
  await db.batch([
    // Delete rows owned by the account before scrubbing its nullable actor
    // references on other rows. The ownership freeze triggers permit deletes
    // but correctly reject an update to a row the deleting account still owns.
    db.prepare("DELETE FROM user_notifications WHERE recipient_user_id = ?").bind(userId),
    db.prepare("UPDATE user_notifications SET actor_user_id = NULL WHERE actor_user_id = ?")
      .bind(userId),
    db.prepare("DELETE FROM organization_teacher_feedback WHERE student_user_id = ?")
      .bind(userId),
    db.prepare("UPDATE organization_teacher_feedback SET teacher_user_id = NULL WHERE teacher_user_id = ?")
      .bind(userId),
    db.prepare("DELETE FROM organization_practice_assignments WHERE student_user_id = ?")
      .bind(userId),
    db.prepare("UPDATE organization_practice_assignments SET assigned_by_user_id = NULL WHERE assigned_by_user_id = ?")
      .bind(userId),
    db.prepare(`
      DELETE FROM organization_requests
       WHERE requester_user_id = ? OR target_user_id = ?
          OR (? IS NOT NULL AND lower(invitation_email) = lower(?))
    `).bind(userId, userId, email, email),
    db.prepare(`
      DELETE FROM teacher_student_assignments
       WHERE teacher_user_id = ? OR student_user_id = ?
    `).bind(userId, userId),
    db.prepare("DELETE FROM organization_seat_allocations WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM organization_memberships WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM organization_applications WHERE applicant_user_id = ?").bind(userId),
    db.prepare("UPDATE organization_applications SET reviewed_by = NULL WHERE reviewed_by = ?")
      .bind(userId),
    db.prepare("UPDATE organization_requests SET decided_by = NULL WHERE decided_by = ?")
      .bind(userId),
    db.prepare(`
      UPDATE teacher_student_assignments
         SET assigned_by = CASE WHEN assigned_by = ? THEN NULL ELSE assigned_by END,
             revoked_by = CASE WHEN revoked_by = ? THEN NULL ELSE revoked_by END
       WHERE assigned_by = ? OR revoked_by = ?
    `).bind(userId, userId, userId, userId),
    db.prepare("UPDATE organization_seat_allocations SET allocated_by = NULL WHERE allocated_by = ?")
      .bind(userId),
    db.prepare(`
      UPDATE organization_attempt_archives
         SET archived_by = CASE WHEN archived_by = ? THEN NULL ELSE archived_by END,
             restored_by = CASE WHEN restored_by = ? THEN NULL ELSE restored_by END
       WHERE archived_by = ? OR restored_by = ?
    `).bind(userId, userId, userId, userId),
    db.prepare(`
      UPDATE provider_events
         SET payload_object_key = NULL, payload_sha256 = NULL
       WHERE payload_object_key IS NOT NULL AND (
         substr(payload_object_key, 1, length(?)) = ?
         OR substr(payload_object_key, 1, length(?)) = ?
         OR EXISTS (
           SELECT 1 FROM data_migration_source_rows
            WHERE table_name = 'provider_events'
              AND source_id = provider_events.provider || ':' || provider_events.event_id
              AND ${sourceSubject}
         )
       )
    `).bind(
      subscriptionPrefix,
      subscriptionPrefix,
      providerEventPrefix,
      providerEventPrefix,
      userId,
    ),
    db.prepare("DELETE FROM organization_command_receipts WHERE actor_user_id = ?").bind(userId),
    db.prepare("DELETE FROM organization_sync_receipts WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM organization_attempt_sync_outbox WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM practice_attempts WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM organization_attempt_object_cleanup WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM cloudflare_replica_outbox WHERE subject_user_id = ?").bind(userId),
    db.prepare("DELETE FROM cloudflare_replica_object_cleanup WHERE subject_user_id = ?").bind(userId),
    db.prepare("DELETE FROM organization_history_clear_watermarks WHERE user_id = ?").bind(userId),
    // The sign-in itself, not only the practice it was used for. Nothing
    // cascades this row away for us: `app_users` deliberately stays behind as
    // an anonymous tombstone, so the ON DELETE CASCADE on user_id never fires,
    // and without this statement the row keeps the provider's permanent
    // subject identifier for this person and the address the provider supplied
    // — indefinitely, for Google as much as for Apple. The privacy page
    // promises deletion is complete, and this is the statement that makes it
    // true. It also unblocks a second first-time sign-in: while the row
    // survives, resolveGoogleIdentity and resolveAppleIdentity still find it,
    // follow it to the tombstone, see a deleted user and refuse — so deleting
    // an account used to mean that Google or Apple account could never open a
    // new one. Nothing reads the row for a deleted account otherwise; the
    // backfill in native-identity-backfill.ts only ever writes rows for users
    // whose app_users record is live.
    db.prepare("DELETE FROM app_user_identities WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM learner_profiles WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM progress_snapshots WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM usernames WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM usage_events WHERE user_id = ?").bind(userId),
    // `app_users` remains as an anonymous deletion tombstone, so its foreign
    // key is not physically deleted and cannot clear this audit pointer for
    // us. Remove the personal association explicitly when the additive table
    // is already installed.
    ...appSettingsScrub,
    db.prepare(`
      DELETE FROM data_migration_row_map
       WHERE EXISTS (
         SELECT 1 FROM json_each(data_migration_row_map.subject_user_ids_json)
          WHERE value = ?
       )
    `).bind(userId),
    db.prepare(`
      DELETE FROM data_migration_source_rows WHERE ${sourceSubject}
    `).bind(userId),
    db.prepare(`
      UPDATE app_users
         SET email = NULL, role = 'user', deleted_at = ?, updated_at = ?
       WHERE id = ?
    `).bind(stamp, stamp, userId),
    db.prepare(`
      UPDATE account_deletion_tombstones
         SET state = 'data_deleted', email_for_cleanup = NULL,
             data_deleted_at = coalesce(data_deleted_at, ?),
             purged_source_rows = ?, last_error_code = NULL, updated_at = ?
       WHERE user_id = ? AND operation_id = ? AND state = 'auth_deleted'
    `).bind(
      stamp,
      Number(sourceCount?.total ?? 0),
      stamp,
      userId,
      row.operation_id,
    ),
  ]);
}

async function deleteR2Manifest(
  bindings: BandUpCloudflareBindings,
  userId: string,
  operationId: string,
): Promise<void> {
  while (true) {
    const result = await bindings.db.prepare(`
      SELECT object_key FROM account_deletion_objects
       WHERE user_id = ? ORDER BY object_key LIMIT ?
    `).bind(userId, R2_DELETE_BATCH).all<{ object_key: string }>();
    const keys = result.results.map((item) => item.object_key);
    if (keys.length === 0) return;
    if (!keys.every(safeObjectKey)) throw new Error("Invalid private object deletion key");

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await bindings.files.delete(keys);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;

    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < keys.length; offset += D1_DELETE_BIND_BATCH) {
      const page = keys.slice(offset, offset + D1_DELETE_BIND_BATCH);
      const placeholders = page.map(() => "?").join(",");
      const stamp = now();
      // Count manifest rows that still exist inside the same transaction. If
      // two retries selected the same page, only the first one increments.
      statements.push(bindings.db.prepare(`
        UPDATE account_deletion_tombstones
           SET objects_deleted = objects_deleted + (
                 SELECT count(*) FROM account_deletion_objects
                  WHERE user_id = ? AND object_key IN (${placeholders})
               ),
               updated_at = ?
         WHERE user_id = ? AND operation_id = ? AND state = 'data_deleted'
      `).bind(userId, ...page, stamp, userId, operationId));
      statements.push(bindings.db.prepare(`
        DELETE FROM account_deletion_objects
         WHERE user_id = ? AND object_key IN (${placeholders})
      `).bind(userId, ...page));
    }
    await bindings.db.batch(statements);
  }
}

async function recordCleanupError(
  bindings: BandUpCloudflareBindings,
  userId: string,
  operationId: string,
  code: "d1_cleanup_failed" | "r2_cleanup_failed",
): Promise<void> {
  await bindings.db.prepare(`
    UPDATE account_deletion_tombstones
       SET last_error_code = ?, updated_at = ?
     WHERE user_id = ? AND operation_id = ? AND state <> 'complete'
  `).bind(code, now(), userId, operationId).run();
}

/**
 * Called only after the selected identity authority confirms deletion. It is safe to repeat:
 * D1 deletes are idempotent and each R2 manifest row is removed only after the
 * object delete succeeds. A false result means durable cleanup is pending, not
 * that the deleted identity was recreated.
 */
export async function completeCloudflareAccountDeletion(
  userId: string,
  operationId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountDeletionResult> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  let row: DeletionRow;
  try {
    row = await markAuthDeleted(bindings, userId, operationId);
    if (row.state === "complete") return { complete: true, state: "complete" };
    await purgeCloudflareRows(bindings, row);
  } catch {
    await recordCleanupError(bindings, userId, operationId, "d1_cleanup_failed")
      .catch(() => undefined);
    const current = await deletionRow(bindings, userId).catch(() => null);
    return { complete: false, state: current?.state ?? "auth_deleted" };
  }

  try {
    await deleteR2Manifest(bindings, userId, operationId);
  } catch {
    await recordCleanupError(bindings, userId, operationId, "r2_cleanup_failed")
      .catch(() => undefined);
    return { complete: false, state: "data_deleted" };
  }

  const completedAt = now();
  const completed = await bindings.db.prepare(`
    UPDATE account_deletion_tombstones
       SET state = 'complete', completed_at = ?, last_error_code = NULL, updated_at = ?
     WHERE user_id = ? AND operation_id = ? AND state = 'data_deleted'
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_objects WHERE user_id = ?
       )
  `).bind(completedAt, completedAt, userId, operationId, userId).run();
  if ((completed.meta.changes ?? 0) !== 1) {
    return { complete: false, state: "data_deleted" };
  }
  return { complete: true, state: "complete" };
}
