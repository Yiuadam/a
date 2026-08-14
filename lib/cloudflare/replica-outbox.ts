import type { BandUpCloudflareBindings } from "./bindings";
import { readStoredJson, sha256, storeJson, type StoredJson } from "./payloads";
import { canonicalCloudflareSourceClock } from "./source-clock";

export const CLOUDFLARE_REPLICA_MAX_ATTEMPTS = 12;
const MAX_DRAIN = 8;
const MAX_CLEANUP_DRAIN = 16;
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

export interface CloudflareReplicaOutboxStatus {
  pending: number;
  dead: number;
  oldestPendingAt: string | null;
  cleanupPending: number;
  cleanupDead: number;
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

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.name : "replica_error";
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "replica_error";
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

export type CloudflareReplicaExecutor = (
  task: CloudflareReplicaTask,
  bindings: BandUpCloudflareBindings,
) => Promise<boolean>;

/**
 * Lease and replay a bounded page. Execution is at-least-once: every target
 * operation is source-clocked or keyed by its immutable source identity.
 */
export async function drainCloudflareReplicaOutbox(
  execute: CloudflareReplicaExecutor,
  bindings: BandUpCloudflareBindings,
  options: { limit?: number; subjectUserId?: string; nowMs?: number } = {},
): Promise<CloudflareReplicaDrainResult> {
  const nowMs = options.nowMs ?? Date.now();
  const stamp = iso(nowMs);
  const limit = Math.max(1, Math.min(MAX_DRAIN, Math.trunc(options.limit ?? 4)));
  const subjectFilter = options.subjectUserId ? "AND subject_user_id = ?" : "";
  const values: (string | number)[] = [stamp, stamp];
  if (options.subjectUserId) values.push(options.subjectUserId);
  values.push(limit);
  const due = await bindings.db.prepare(`
    SELECT task_id, operation, subject_user_id, source_updated_at,
           payload_inline, payload_object_key, payload_sha256, payload_bytes,
           generation, attempts_made, updated_at
      FROM cloudflare_replica_outbox
     WHERE status = 'pending' AND available_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ${subjectFilter}
     ORDER BY available_at, updated_at LIMIT ?
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

/** Operator/parity evidence. Dead rows deliberately remain visible. */
export async function cloudflareReplicaOutboxStatus(
  bindings: BandUpCloudflareBindings,
): Promise<CloudflareReplicaOutboxStatus> {
  const row = await bindings.db.prepare(`
    SELECT
      sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
      min(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at
    FROM cloudflare_replica_outbox
  `).first<{ pending: number | null; dead: number | null; oldest_pending_at: string | null }>();
  const cleanup = await bindings.db.prepare(`
    SELECT
      sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
    FROM cloudflare_replica_object_cleanup
  `).first<{ pending: number | null; dead: number | null }>();
  return {
    pending: Number(row?.pending ?? 0),
    dead: Number(row?.dead ?? 0),
    oldestPendingAt: row?.oldest_pending_at ?? null,
    cleanupPending: Number(cleanup?.pending ?? 0),
    cleanupDead: Number(cleanup?.dead ?? 0),
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
