import type { BandUpCloudflareBindings } from "./bindings";
import { readStoredJson, sha256, storeJson, type StoredJson } from "./payloads";
import { canonicalCloudflareSourceClock } from "./source-clock";
import { cutoverWriteBarrierArmed } from "./write-barrier";

export const CLOUDFLARE_REPLICA_MAX_ATTEMPTS = 12;
/*
  The ceilings a single drain page may ask for.

  These were 8 and 16 while the only thing that ever called a drain was a
  learner's own request, where a big page would have made somebody's save
  slower to pay off somebody else's backlog. The scheduled drain in
  lib/cloudflare/scheduled-replica-drain.ts has no user waiting on it, and a
  ceiling of 8 there would have meant a backlog draining at the speed of the
  cron rather than at the speed of the queue. The bounds still exist — an
  unbounded page is how one poisoned row turns into a 30-second CPU timeout
  that starves every row behind it — they are simply set for the caller that
  has time rather than for the caller that does not. Request paths ask for 2.
*/
const MAX_DRAIN = 25;
const MAX_CLEANUP_DRAIN = 50;
const LEASE_MS = 2 * 60 * 1000;
const INLINE_PAYLOAD_LIMIT = 512 * 1024;
const MAX_PAYLOAD_BYTES = 1_900_000;
const encoder = new TextEncoder();

export type CloudflareReplicaOperation =
  | "learner_profile"
  | "account_identity"
  | "username"
  | "progress_snapshot"
  | "avatar_put"
  | "avatar_delete"
  | "stripe_billing"
  | "usage_event"
  | "ai_cost_event"
  | "ai_cost_coverage";

export interface CloudflareReplicaTask<Payload = unknown> {
  taskId: string;
  operation: CloudflareReplicaOperation;
  subjectUserId: string | null;
  sourceUpdatedAt: string;
  payload: Payload;
}

interface ReplicaOutboxRow {
  task_id: string;
  operation: CloudflareReplicaOperation;
  subject_user_id: string | null;
  source_updated_at: string;
  payload_inline: string | null;
  payload_object_key: string | null;
  payload_sha256: string;
  payload_bytes: number;
  generation: number;
  attempts_made: number;
  updated_at: string;
}

interface CleanupRow {
  object_key: string;
  subject_user_id: string | null;
  attempts_made: number;
}

export interface CloudflareReplicaDrainResult {
  selected: number;
  succeeded: number;
  failed: number;
  dead: number;
}

/**
 * One reason, with enough shape for the owner to go and find the rows.
 *
 * `detail` is deliberately not the row identity: for the outbox it is the set
 * of operations, and for object cleanup it is the key namespace with the owner
 * id and content hash removed. A stuck queue is an operational fact an admin
 * needs; which learner it belongs to is not, and this report is also read
 * through the admin UI.
 */
export interface CloudflareReplicaFailureGroup {
  code: string;
  status: "pending" | "dead";
  count: number;
  detail: string[];
  maxAttempts: number;
  oldestAt: string | null;
  oldestAgeSeconds: number | null;
}

export interface CloudflareReplicaOutboxStatus {
  pending: number;
  dead: number;
  oldestPendingAt: string | null;
  /**
   * The oldest pending row a drain can actually pick up — the same figure as
   * `oldestPendingAt` with the deletion-blocked rows left out.
   *
   * The health check reads this one rather than `oldestPendingAt`. A row that
   * can never be leased would otherwise pin the backlog age at "for ever" and
   * hold the alarm red permanently, which is how an alarm stops being read.
   */
  oldestRetryablePendingAt: string | null;
  cleanupPending: number;
  cleanupDead: number;
  /**
   * The recorded `last_error_code` was written on every failure and read by
   * nothing, so a stuck mirror looked like a bare count. These two lists are
   * that column, grouped.
   */
  failures: CloudflareReplicaFailureGroup[];
  cleanupFailures: CloudflareReplicaFailureGroup[];
  /**
   * Outbox rows whose subject already has an account-deletion tombstone. The
   * deletion guard triggers abort every insert and every update on such a row,
   * so the drain's lease also aborts and the row is skipped in silence: it
   * never attempts, never records an error and never dies. Counting it is the
   * only way that shape of stuck row is visible at all.
   */
  blockedByAccountDeletion: number;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function retryAt(nowMs: number, attemptsMade: number): string {
  const exponent = Math.min(8, Math.max(0, attemptsMade - 1));
  const baseSeconds = Math.min(60 * 60, 15 * (2 ** exponent));
  // Deterministic jitter avoids Math.random while keeping tasks with the same
  // failure count from all becoming due in the exact same millisecond.
  const jitterMs = (attemptsMade * 7919) % 5000;
  return iso(nowMs + baseSeconds * 1000 + jitterMs);
}

/*
  A fixed vocabulary, matched against the message but never built from it.

  `error.name` alone was almost always the literal string "Error": every throw
  in this file, every D1 constraint failure and every R2 failure share that one
  name, so the column recorded that something failed and nothing about what.
  The message is where the difference lives, and the message is also where a
  provider's own text lives — so it is matched, not stored. Anything unrecognised
  stays `replica_error`, and the full message is left to the server-side log.
*/
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/account deletion is (already )?in progress/i, "account_deletion_in_progress"],
  [/executor returned false/i, "executor_rejected"],
  [/object is missing/i, "object_missing"],
  [/checksum mismatch/i, "checksum_mismatch"],
  [/has no content/i, "payload_empty"],
  [/exceeds the storage limit/i, "payload_too_large"],
  [/invalid storage namespace/i, "invalid_namespace"],
  [/invalid .*(payload|identity|body)/i, "invalid_payload"],
  [/subject mismatch/i, "subject_mismatch"],
  [/no such (table|column)/i, "d1_missing_schema"],
  [/(CHECK|UNIQUE|NOT NULL|FOREIGN KEY) constraint/i, "d1_constraint"],
  [/RAISE\(ABORT\)|abort due to/i, "d1_abort"],
  [/D1_ERROR|database is locked|SQLITE_/i, "d1_error"],
  [/network connection lost|internal error|timed out|too many subrequests/i, "transient"],
];

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "replica_error";
  const message = String(error.message ?? "");
  for (const [pattern, code] of ERROR_PATTERNS) if (pattern.test(message)) return code;
  const name = error.name && error.name !== "Error" ? error.name : "replica_error";
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "replica_error";
}

function stored(row: ReplicaOutboxRow): StoredJson {
  return {
    inline: row.payload_inline,
    objectKey: row.payload_object_key,
    sha256: row.payload_sha256,
    bytes: Number(row.payload_bytes),
  };
}

async function storeTaskPayload(
  bindings: BandUpCloudflareBindings,
  task: CloudflareReplicaTask,
): Promise<StoredJson> {
  const json = JSON.stringify(task.payload);
  const bytes = encoder.encode(json);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("Cloudflare replica payload exceeds the storage limit");
  }
  if (bytes.byteLength <= INLINE_PAYLOAD_LIMIT) {
    return {
      inline: json,
      objectKey: null,
      sha256: await sha256(bytes),
      bytes: bytes.byteLength,
    };
  }
  return storeJson(
    bindings,
    "replica-outbox",
    task.subjectUserId ?? "system",
    task.payload,
    { forceObject: true },
  );
}

/**
 * Insert before attempting a target write. Mutable tasks coalesce by task id
 * and source clock; immutable event tasks use their source identity in the id.
 */
export async function enqueueCloudflareReplicaTask(
  task: CloudflareReplicaTask,
  bindings: BandUpCloudflareBindings,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!task.taskId || task.taskId.length > 512 || !validTimestamp(task.sourceUpdatedAt)) {
    throw new Error("Invalid Cloudflare replica task identity");
  }
  const payload = await storeTaskPayload(bindings, task);
  const sourceUpdatedAt = canonicalCloudflareSourceClock(task.sourceUpdatedAt);
  const stamp = iso(nowMs);
  let result: D1Result;
  try {
    result = await bindings.db.prepare(`
      INSERT INTO cloudflare_replica_outbox (
        task_id, operation, subject_user_id, source_updated_at,
        payload_inline, payload_object_key, payload_sha256, payload_bytes,
        generation, attempts_made, status, available_at,
        lease_token, lease_expires_at, last_attempt_at, last_error_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        operation = excluded.operation,
        subject_user_id = excluded.subject_user_id,
        source_updated_at = excluded.source_updated_at,
        payload_inline = excluded.payload_inline,
        payload_object_key = excluded.payload_object_key,
        payload_sha256 = excluded.payload_sha256,
        payload_bytes = excluded.payload_bytes,
        generation = cloudflare_replica_outbox.generation + 1,
        attempts_made = 0,
        status = 'pending',
        available_at = excluded.available_at,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_attempt_at = NULL,
        last_error_code = NULL,
        updated_at = excluded.updated_at
      WHERE excluded.source_updated_at > cloudflare_replica_outbox.source_updated_at
    `).bind(
      task.taskId,
      task.operation,
      task.subjectUserId,
      sourceUpdatedAt,
      payload.inline,
      payload.objectKey,
      payload.sha256,
      payload.bytes,
      stamp,
      stamp,
      stamp,
    ).run();
  } catch (error) {
    if (payload.objectKey) {
      await enqueueCloudflareObjectCleanup(
        bindings,
        payload.objectKey,
        task.subjectUserId,
        nowMs,
      ).catch(() => undefined);
    }
    throw error;
  }
  if (!result.success) return false;
  if (result.meta.changes === 0 && payload.objectKey) {
    // A newer task won the race. Its pointer check protects a same-hash key.
    await enqueueCloudflareObjectCleanup(
      bindings,
      payload.objectKey,
      task.subjectUserId,
      nowMs,
    );
  }
  return true;
}

/** Delete only the exact generation/source snapshot which was executed. */
export async function acknowledgeCloudflareReplicaTask(
  bindings: BandUpCloudflareBindings,
  task: Pick<CloudflareReplicaTask, "taskId" | "sourceUpdatedAt">,
): Promise<boolean> {
  const result = await bindings.db.prepare(`
    DELETE FROM cloudflare_replica_outbox
     WHERE task_id = ? AND source_updated_at = ?
  `).bind(
    task.taskId,
    canonicalCloudflareSourceClock(task.sourceUpdatedAt),
  ).run();
  return result.success;
}

export async function enqueueCloudflareObjectCleanup(
  bindings: BandUpCloudflareBindings,
  objectKey: string,
  subjectUserId: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!objectKey.startsWith("private/") || objectKey.length > 1024) return false;
  const stamp = iso(nowMs);
  const result = await bindings.db.prepare(`
    INSERT INTO cloudflare_replica_object_cleanup (
      object_key, subject_user_id, attempts_made, status, available_at,
      last_attempt_at, last_error_code, created_at, updated_at
    ) VALUES (?, ?, 0, 'pending', ?, NULL, NULL, ?, ?)
    ON CONFLICT(object_key) DO UPDATE SET
      subject_user_id = coalesce(
        cloudflare_replica_object_cleanup.subject_user_id,
        excluded.subject_user_id
      ),
      attempts_made = 0,
      status = 'pending',
      available_at = min(
        cloudflare_replica_object_cleanup.available_at,
        excluded.available_at
      ),
      last_error_code = NULL,
      updated_at = excluded.updated_at
  `).bind(objectKey, subjectUserId, stamp, stamp, stamp).run();
  return result.success;
}

async function objectIsReferenced(
  bindings: BandUpCloudflareBindings,
  objectKey: string,
): Promise<boolean> {
  const row = await bindings.db.prepare(`
    SELECT 1 AS referenced FROM (
      SELECT avatar_object_key AS object_key FROM learner_profiles
      UNION ALL SELECT payload_object_key FROM progress_snapshots
      UNION ALL SELECT raw_object_key FROM subscriptions
      UNION ALL SELECT payload_object_key FROM provider_events
      UNION ALL SELECT result_object_key FROM practice_attempts
      UNION ALL SELECT payload_object_key FROM organization_attempt_sync_outbox
      UNION ALL SELECT payload_object_key FROM cloudflare_replica_outbox
    ) pointers WHERE object_key = ? LIMIT 1
  `).bind(objectKey).first<{ referenced: number }>();
  return row?.referenced === 1;
}

/** Pointer-safe and bounded R2 cleanup for retired outbox/avatar objects. */
export async function drainCloudflareReplicaObjectCleanup(
  bindings: BandUpCloudflareBindings,
  options: { limit?: number; nowMs?: number } = {},
): Promise<CloudflareReplicaDrainResult> {
  const nowMs = options.nowMs ?? Date.now();
  const stamp = iso(nowMs);
  const limit = Math.max(1, Math.min(MAX_CLEANUP_DRAIN, Math.trunc(options.limit ?? 8)));
  const due = await bindings.db.prepare(`
    SELECT object_key, subject_user_id, attempts_made
      FROM cloudflare_replica_object_cleanup
     WHERE status = 'pending' AND available_at <= ?
     ORDER BY available_at, updated_at LIMIT ?
  `).bind(stamp, limit).all<CleanupRow>();

  let succeeded = 0;
  let failed = 0;
  let dead = 0;
  for (const row of due.results) {
    try {
      if (!await objectIsReferenced(bindings, row.object_key)) {
        await bindings.files.delete(row.object_key);
      }
      const removed = await bindings.db.prepare(`
        DELETE FROM cloudflare_replica_object_cleanup WHERE object_key = ?
      `).bind(row.object_key).run();
      if (removed.success) succeeded += 1;
    } catch (error) {
      failed += 1;
      const attempts = Math.min(CLOUDFLARE_REPLICA_MAX_ATTEMPTS, row.attempts_made + 1);
      const status = attempts >= CLOUDFLARE_REPLICA_MAX_ATTEMPTS ? "dead" : "pending";
      if (status === "dead") dead += 1;
      await bindings.db.prepare(`
        UPDATE cloudflare_replica_object_cleanup
           SET attempts_made = ?, status = ?, available_at = ?,
               last_attempt_at = ?, last_error_code = ?, updated_at = ?
         WHERE object_key = ?
      `).bind(
        attempts,
        status,
        retryAt(nowMs, attempts),
        stamp,
        errorCode(error),
        stamp,
        row.object_key,
      ).run().catch(() => undefined);
    }
  }
  return { selected: due.results.length, succeeded, failed, dead };
}

/*
  Rows the deletion guard will never let anybody update, left out of selection.

  `cloudflare_replica_outbox_deletion_update_guard` (migration 0013) aborts
  every UPDATE on a row whose subject has an account-deletion tombstone — the
  drain's own lease UPDATE included. Such a row was still being *selected* on
  every pass: it filled a slot in the page, the lease aborted, the `.catch`
  swallowed it, and the drain moved on having done nothing. With a page of two
  that was enough on its own to stop a queue dead, because the same two
  unusable rows were chosen every time and nothing behind them was ever
  reached.

  Leaving them out is not hiding them. They are counted by
  `blockedByAccountDeletion` below, named by the readiness report and shown in
  the admin panel; what changes is that they no longer consume a drain budget
  they cannot use. Clearing them is the owner's call — the subject is mid
  deletion, so the right answer is to finish or abandon that deletion, not to
  have a background job delete rows out from under it.
*/
const NOT_BLOCKED_BY_DELETION = `
  AND (o.subject_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_deletion_tombstones AS t
     WHERE t.user_id = o.subject_user_id
  ))
`;

export type CloudflareReplicaExecutor = (
  task: CloudflareReplicaTask,
  bindings: BandUpCloudflareBindings,
) => Promise<boolean>;

/**
 * Lease and replay a bounded page. Execution is at-least-once: every target
 * operation is source-clocked or keyed by its immutable source identity.
 *
 * ---------------------------------------------------------------------------
 * The barrier check
 *
 * Every operation this outbox carries belongs to the "learner" write-authority
 * domain (see lib/cloudflare/write-barrier.ts) — arming that barrier requires
 * this same outbox to already be empty, so in the ordinary case there is
 * nothing here to refuse. It matters for the one path that can still put a row
 * back after arming: an owner explicitly requeuing a dead letter through the
 * admin route. Applying that row's pre-barrier Supabase source clock over
 * whatever D1 has since become authoritative for on its own is exactly the CAS
 * ordering violation `source_updated_at >=` guards elsewhere in this file are
 * meant to prevent — so once armed, the drain refuses every row for that
 * domain outright rather than deciding row by row. The rows stay visible and
 * counted by cloudflareReplicaOutboxStatus below; they simply never get
 * selected for replay again.
 *
 * This asks `cutoverWriteBarrierArmed` — a plain function call, cached and
 * already tolerant of `cutover_write_barriers` not existing yet — rather than
 * folding the same check into the SELECT below as a SQL subquery. A subquery
 * would run, and fail, on literally every drain until the owner applies
 * scripts/hand-run-cutover-write-barrier.sql; asking first, in JS, means that
 * gap costs one cheap, cached function call instead of a failing query.
 */
export async function drainCloudflareReplicaOutbox(
  execute: CloudflareReplicaExecutor,
  bindings: BandUpCloudflareBindings,
  options: { limit?: number; subjectUserId?: string; nowMs?: number } = {},
): Promise<CloudflareReplicaDrainResult> {
  const nowMs = options.nowMs ?? Date.now();
  if (await cutoverWriteBarrierArmed("learner", bindings)) {
    return { selected: 0, succeeded: 0, failed: 0, dead: 0 };
  }
  const stamp = iso(nowMs);
  const limit = Math.max(1, Math.min(MAX_DRAIN, Math.trunc(options.limit ?? 4)));
  const subjectFilter = options.subjectUserId ? "AND o.subject_user_id = ?" : "";
  const values: (string | number)[] = [stamp, stamp];
  if (options.subjectUserId) values.push(options.subjectUserId);
  values.push(limit);
  const due = await bindings.db.prepare(`
    SELECT o.task_id, o.operation, o.subject_user_id, o.source_updated_at,
           o.payload_inline, o.payload_object_key, o.payload_sha256,
           o.payload_bytes, o.generation, o.attempts_made, o.updated_at
      FROM cloudflare_replica_outbox AS o
     WHERE o.status = 'pending' AND o.available_at <= ?
       AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= ?)
       ${subjectFilter}
       ${NOT_BLOCKED_BY_DELETION}
     ORDER BY o.available_at, o.updated_at LIMIT ?
  `).bind(...values).all<ReplicaOutboxRow>();

  let succeeded = 0;
  let failed = 0;
  let dead = 0;
  for (const row of due.results) {
    const leaseToken = crypto.randomUUID();
    const claimed = await bindings.db.prepare(`
      UPDATE cloudflare_replica_outbox
         SET lease_token = ?, lease_expires_at = ?, last_attempt_at = ?
       WHERE task_id = ? AND generation = ? AND updated_at = ?
         AND status = 'pending' AND available_at <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).bind(
      leaseToken,
      iso(nowMs + LEASE_MS),
      stamp,
      row.task_id,
      row.generation,
      row.updated_at,
      stamp,
      stamp,
    ).run().catch(() => null);
    if (!claimed?.success || claimed.meta.changes !== 1) continue;

    try {
      const payload = await readStoredJson(bindings, stored(row));
      const task: CloudflareReplicaTask = {
        taskId: row.task_id,
        operation: row.operation,
        subjectUserId: row.subject_user_id,
        sourceUpdatedAt: row.source_updated_at,
        payload,
      };
      if (!await execute(task, bindings)) {
        throw new Error("Cloudflare replica executor returned false");
      }
      const removed = await bindings.db.prepare(`
        DELETE FROM cloudflare_replica_outbox
         WHERE task_id = ? AND generation = ? AND lease_token = ?
      `).bind(row.task_id, row.generation, leaseToken).run();
      if (removed.success && removed.meta.changes === 1) succeeded += 1;
    } catch (error) {
      failed += 1;
      const attempts = Math.min(CLOUDFLARE_REPLICA_MAX_ATTEMPTS, row.attempts_made + 1);
      const status = attempts >= CLOUDFLARE_REPLICA_MAX_ATTEMPTS ? "dead" : "pending";
      if (status === "dead") dead += 1;
      await bindings.db.prepare(`
        UPDATE cloudflare_replica_outbox
           SET attempts_made = ?, status = ?, available_at = ?,
               lease_token = NULL, lease_expires_at = NULL,
               last_error_code = ?, updated_at = ?
         WHERE task_id = ? AND generation = ? AND lease_token = ?
      `).bind(
        attempts,
        status,
        retryAt(nowMs, attempts),
        errorCode(error),
        stamp,
        row.task_id,
        row.generation,
        leaseToken,
      ).run().catch(() => undefined);
    }
  }
  await drainCloudflareReplicaObjectCleanup(bindings, { limit: 8, nowMs })
    .catch(() => undefined);
  return { selected: due.results.length, succeeded, failed, dead };
}

const FAILURE_SAMPLE_LIMIT = 250;
const MAX_DETAIL = 8;

interface FailureRow {
  status: string;
  attempts_made: number;
  last_error_code: string | null;
  last_attempt_at: string | null;
  created_at: string;
  detail: string;
}

/**
 * `private/progress/ielts-prep-v1/<user>/<sha>.json` becomes
 * `private/progress/ielts-prep-v1`. The owner id and the content hash are the
 * two trailing segments, and neither belongs in an operational report.
 */
function objectKeyNamespace(objectKey: string): string {
  const segments = objectKey.split("/");
  return segments.length <= 3 ? objectKey : segments.slice(0, -2).join("/");
}

function groupFailures(rows: FailureRow[], nowMs: number): CloudflareReplicaFailureGroup[] {
  const groups = new Map<string, CloudflareReplicaFailureGroup & { details: Set<string> }>();
  for (const row of rows) {
    const status = row.status === "dead" ? "dead" as const : "pending" as const;
    // A pending row that has never been attempted is not a failure; it is
    // simply waiting, and reporting it as one would hide the real reasons.
    if (status === "pending" && Number(row.attempts_made) === 0 && !row.last_error_code) continue;
    const code = row.last_error_code || "unrecorded";
    const key = `${status}:${code}`;
    const at = row.last_attempt_at ?? row.created_at ?? null;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.maxAttempts = Math.max(existing.maxAttempts, Number(row.attempts_made));
      if (at && (!existing.oldestAt || at < existing.oldestAt)) existing.oldestAt = at;
      existing.details.add(row.detail);
      continue;
    }
    groups.set(key, {
      code,
      status,
      count: 1,
      detail: [],
      details: new Set([row.detail]),
      maxAttempts: Number(row.attempts_made),
      oldestAt: at,
      oldestAgeSeconds: null,
    });
  }
  return [...groups.values()]
    .map((group) => {
      const parsed = group.oldestAt ? Date.parse(group.oldestAt) : Number.NaN;
      return {
        code: group.code,
        status: group.status,
        count: group.count,
        detail: [...group.details].sort().slice(0, MAX_DETAIL),
        maxAttempts: group.maxAttempts,
        oldestAt: group.oldestAt,
        oldestAgeSeconds: Number.isFinite(parsed)
          ? Math.max(0, Math.round((nowMs - parsed) / 1000))
          : null,
      };
    })
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

/** Operator/parity evidence. Dead rows deliberately remain visible. */
export async function cloudflareReplicaOutboxStatus(
  bindings: BandUpCloudflareBindings,
  nowMs: number = Date.now(),
): Promise<CloudflareReplicaOutboxStatus> {
  const row = await bindings.db.prepare(`
    SELECT
      sum(CASE WHEN o.status = 'pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN o.status = 'dead' THEN 1 ELSE 0 END) AS dead,
      min(CASE WHEN o.status = 'pending' THEN o.created_at END) AS oldest_pending_at,
      min(CASE WHEN o.status = 'pending' AND (
            o.subject_user_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM account_deletion_tombstones AS t
               WHERE t.user_id = o.subject_user_id
            )
          ) THEN o.created_at END) AS oldest_retryable_pending_at
    FROM cloudflare_replica_outbox AS o
  `).first<{
    pending: number | null;
    dead: number | null;
    oldest_pending_at: string | null;
    oldest_retryable_pending_at: string | null;
  }>();
  const cleanup = await bindings.db.prepare(`
    SELECT
      sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
    FROM cloudflare_replica_object_cleanup
  `).first<{ pending: number | null; dead: number | null }>();

  const taskRows = await bindings.db.prepare(`
    SELECT status, attempts_made, last_error_code, last_attempt_at, created_at,
           operation AS detail
      FROM cloudflare_replica_outbox
     ORDER BY created_at LIMIT ?
  `).bind(FAILURE_SAMPLE_LIMIT).all<FailureRow>();
  const cleanupRows = await bindings.db.prepare(`
    SELECT status, attempts_made, last_error_code, last_attempt_at, created_at,
           object_key AS detail
      FROM cloudflare_replica_object_cleanup
     ORDER BY created_at LIMIT ?
  `).bind(FAILURE_SAMPLE_LIMIT).all<FailureRow>();
  const blocked = await bindings.db.prepare(`
    SELECT count(*) AS blocked
      FROM cloudflare_replica_outbox AS o
      JOIN account_deletion_tombstones AS t ON t.user_id = o.subject_user_id
  `).first<{ blocked: number | null }>().catch(() => null);

  return {
    pending: Number(row?.pending ?? 0),
    dead: Number(row?.dead ?? 0),
    oldestPendingAt: row?.oldest_pending_at ?? null,
    oldestRetryablePendingAt: row?.oldest_retryable_pending_at ?? null,
    cleanupPending: Number(cleanup?.pending ?? 0),
    cleanupDead: Number(cleanup?.dead ?? 0),
    failures: groupFailures(taskRows.results, nowMs),
    cleanupFailures: groupFailures(
      cleanupRows.results.map((cleanupRow) => ({
        ...cleanupRow,
        detail: objectKeyNamespace(cleanupRow.detail),
      })),
      nowMs,
    ),
    blockedByAccountDeletion: Number(blocked?.blocked ?? 0),
  };
}

/**
 * Explicit owner action for a diagnosed dead-letter backlog. Automatic drains
 * never call this, so a persistent schema/data error cannot spin forever.
 */
export async function requeueDeadCloudflareReplicaTasks(
  bindings: BandUpCloudflareBindings,
  limit = 8,
  nowMs: number = Date.now(),
): Promise<{ tasks: number; objects: number }> {
  const safeLimit = Math.max(1, Math.min(MAX_DRAIN, Math.trunc(limit)));
  const stamp = iso(nowMs);
  const [tasks, objects] = await bindings.db.batch([
    bindings.db.prepare(`
      UPDATE cloudflare_replica_outbox
         SET attempts_made = 0, status = 'pending', available_at = ?,
             lease_token = NULL, lease_expires_at = NULL,
             last_attempt_at = NULL, last_error_code = NULL, updated_at = ?
       WHERE task_id IN (
         SELECT task_id FROM cloudflare_replica_outbox
          WHERE status = 'dead' ORDER BY updated_at LIMIT ?
       )
    `).bind(stamp, stamp, safeLimit),
    bindings.db.prepare(`
      UPDATE cloudflare_replica_object_cleanup
         SET attempts_made = 0, status = 'pending', available_at = ?,
             last_attempt_at = NULL, last_error_code = NULL, updated_at = ?
       WHERE object_key IN (
         SELECT object_key FROM cloudflare_replica_object_cleanup
          WHERE status = 'dead' ORDER BY updated_at LIMIT ?
       )
    `).bind(stamp, stamp, safeLimit),
  ]);
  return {
    tasks: tasks?.success ? Number(tasks.meta.changes ?? 0) : 0,
    objects: objects?.success ? Number(objects.meta.changes ?? 0) : 0,
  };
}
