import type { SessionUser } from "@/lib/auth/session";
import type { ModuleResult } from "@/lib/types";
import {
  organizationAttempts,
  organizationHistoryClearWatermark,
} from "@/lib/organizations/attempt-sync";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { ensureCloudflareUser } from "./learner-data";
import { syncCloudflareOrganizationAttempts } from "./organizations";
import {
  reconcileOrganizationAttemptObjects,
  retireOrganizationAttemptObjects,
} from "./organization-attempt-objects";
import { readStoredJson, storeJson, type StoredJson } from "./payloads";

const MAX_DRAIN = 8;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_EXPONENT = 8;

interface OutboxRow {
  user_id: string;
  email: string | null;
  idempotency_key: string;
  attempt_count: number;
  history_cleared_at: string | null;
  payload_inline: string | null;
  payload_object_key: string | null;
  payload_sha256: string;
  payload_bytes: number;
  attempts_made: number;
  updated_at: string;
}

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function retryAt(nowMs: number, attemptsMade: number): string {
  const seconds = Math.min(60 * 60, 15 * (2 ** Math.min(attemptsMade, MAX_BACKOFF_EXPONENT)));
  return new Date(nowMs + seconds * 1000).toISOString();
}

/**
 * Coalesce the latest complete learner history into one durable D1 row.
 * Superseded R2 payloads are retired only after the new pointer is visible.
 */
export async function enqueueCloudflareOrganizationAttemptSync(
  user: SessionUser,
  attempts: readonly ModuleResult[],
  idempotencyKey: string,
  historyClearedAt: string | null,
  providedBindings?: BandUpCloudflareBindings,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (attempts.length === 0 && historyClearedAt === null) return true;
  if (attempts.length > 100) throw new Error("Organization attempt outbox is too large");
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const watermark = organizationHistoryClearWatermark({ historyClearedAt });
  const normalizedAttempts = organizationAttempts(attempts).filter(
    (attempt) => !watermark || Date.parse(attempt.date) > Date.parse(watermark),
  );
  const stored = await storeJson(bindings, "attempts", user.id, normalizedAttempts);
  const currentStamp = stamp(nowMs);

  try {
    const statements: D1PreparedStatement[] = [];
    if (watermark) {
      statements.push(bindings.db.prepare(`
        INSERT INTO organization_history_clear_watermarks (user_id, cleared_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          cleared_at = CASE
            WHEN julianday(excluded.cleared_at) > julianday(organization_history_clear_watermarks.cleared_at)
              THEN excluded.cleared_at
            ELSE organization_history_clear_watermarks.cleared_at
          END,
          updated_at = CASE
            WHEN julianday(excluded.cleared_at) > julianday(organization_history_clear_watermarks.cleared_at)
              THEN excluded.updated_at
            ELSE organization_history_clear_watermarks.updated_at
          END
      `).bind(user.id, watermark, currentStamp));
      statements.push(bindings.db.prepare(`
        DELETE FROM practice_attempts
         WHERE user_id = ? AND EXISTS (
           SELECT 1 FROM organization_history_clear_watermarks w
            WHERE w.user_id = practice_attempts.user_id
              AND julianday(practice_attempts.submitted_at) <= julianday(w.cleared_at)
         )
      `).bind(user.id));
    }
    statements.push(bindings.db.prepare(`
      INSERT INTO organization_attempt_sync_outbox (
        user_id, idempotency_key, attempt_count, history_cleared_at,
        payload_inline, payload_object_key, payload_sha256, payload_bytes,
        attempts_made, available_at, lease_token, lease_expires_at,
        last_attempt_at, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        idempotency_key = excluded.idempotency_key,
        attempt_count = excluded.attempt_count,
        history_cleared_at = CASE
          WHEN organization_attempt_sync_outbox.history_cleared_at IS NULL
            THEN excluded.history_cleared_at
          WHEN excluded.history_cleared_at IS NULL
            THEN organization_attempt_sync_outbox.history_cleared_at
          WHEN julianday(excluded.history_cleared_at) > julianday(organization_attempt_sync_outbox.history_cleared_at)
            THEN excluded.history_cleared_at
          ELSE organization_attempt_sync_outbox.history_cleared_at
        END,
        payload_inline = excluded.payload_inline,
        payload_object_key = excluded.payload_object_key,
        payload_sha256 = excluded.payload_sha256,
        payload_bytes = excluded.payload_bytes,
        attempts_made = 0,
        available_at = excluded.available_at,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_attempt_at = NULL,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).bind(
      user.id,
      idempotencyKey,
      normalizedAttempts.length,
      watermark,
      stored.inline,
      stored.objectKey,
      stored.sha256,
      stored.bytes,
      currentStamp,
      currentStamp,
      currentStamp,
    ));
    const result = await bindings.db.batch(statements);
    if (!result.every((item) => item.success)) {
      throw new Error("Organization attempt outbox write failed");
    }
  } catch (error) {
    await retireOrganizationAttemptObjects(
      bindings,
      user.id,
      [stored.objectKey],
      nowMs,
    ).catch(() => undefined);
    throw error;
  }

  // UPDATE/DELETE triggers recorded every superseded attempt/outbox pointer in
  // the same transaction above. Reconciliation is best effort here because the
  // durable ledger, rather than this request, owns eventual R2 retirement.
  await reconcileOrganizationAttemptObjects(bindings, { limit: 8, nowMs })
    .catch(() => undefined);
  return true;
}

function stored(row: OutboxRow): StoredJson {
  return {
    inline: row.payload_inline,
    objectKey: row.payload_object_key,
    sha256: row.payload_sha256,
    bytes: row.payload_bytes,
  };
}

/**
 * Claim and reconcile a bounded page. At-least-once execution is safe because
 * the attempt batch has its own idempotency receipt; a crash after that commit
 * simply repeats the receipt read and removes this outbox row next time.
 */
export async function drainCloudflareOrganizationAttemptOutbox(
  options: {
    userId?: string;
    limit?: number;
    nowMs?: number;
    bindings?: BandUpCloudflareBindings;
  } = {},
): Promise<{ selected: number; succeeded: number; failed: number }> {
  const bindings = options.bindings ?? await requireBandUpCloudflareBindings();
  const nowMs = options.nowMs ?? Date.now();
  const currentStamp = stamp(nowMs);
  const limit = Math.max(1, Math.min(MAX_DRAIN, Math.trunc(options.limit ?? 4)));
  const filter = options.userId ? "AND o.user_id = ?" : "";
  const parameters: (string | number)[] = [currentStamp];
  if (options.userId) parameters.push(options.userId);
  parameters.push(limit);
  const due = await bindings.db.prepare(`
    SELECT o.user_id, u.email, o.idempotency_key, o.attempt_count,
           o.history_cleared_at, o.payload_inline, o.payload_object_key,
           o.payload_sha256, o.payload_bytes, o.attempts_made, o.updated_at
      FROM organization_attempt_sync_outbox o
      JOIN app_users u ON u.id = o.user_id AND u.deleted_at IS NULL
     WHERE o.available_at <= ?
       AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= ?)
       ${filter}
     ORDER BY o.available_at, o.updated_at LIMIT ?
  `).bind(currentStamp, ...parameters).all<OutboxRow>();

  let succeeded = 0;
  let failed = 0;
  for (const row of due.results) {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = stamp(nowMs + LEASE_MS);
    let claimed = false;
    try {
      const claim = await bindings.db.prepare(`
        UPDATE organization_attempt_sync_outbox
           SET lease_token = ?, lease_expires_at = ?, last_attempt_at = ?, updated_at = ?
         WHERE user_id = ? AND idempotency_key = ? AND updated_at = ?
           AND available_at <= ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).bind(
        leaseToken,
        leaseExpiresAt,
        currentStamp,
        currentStamp,
        row.user_id,
        row.idempotency_key,
        row.updated_at,
        currentStamp,
        currentStamp,
      ).run();
      claimed = claim.success && claim.meta.changes === 1;
    } catch {
      claimed = false;
    }
    if (!claimed) continue;

    try {
      const decoded = await readStoredJson(bindings, stored(row));
      const attempts = organizationAttempts(decoded);
      if (!Array.isArray(decoded) || attempts.length !== row.attempt_count) {
        throw new Error("Organization attempt outbox payload is invalid");
      }
      const user: SessionUser = { id: row.user_id, email: row.email };
      const copied = await syncCloudflareOrganizationAttempts(
        user,
        attempts,
        row.idempotency_key,
        bindings,
        row.history_cleared_at,
        nowMs,
      );
      if (!copied) throw new Error("Organization attempt reconciliation failed");
      const outboxObjectKey = row.payload_object_key;
      const removed = await bindings.db.prepare(`
        DELETE FROM organization_attempt_sync_outbox
         WHERE user_id = ? AND lease_token = ?
      `).bind(row.user_id, leaseToken).run();
      if (!removed.success || removed.meta.changes !== 1) {
        // A newer coalesced row replaced our lease while the attempt batch was
        // running. Its pointer remains live and must not be retired here.
        continue;
      }
      succeeded += 1;
      const cleaned = await retireOrganizationAttemptObjects(
        bindings,
        row.user_id,
        [outboxObjectKey],
        nowMs,
      );
      if (!cleaned) {
        console.error(JSON.stringify({
          message: "organization attempt outbox object cleanup deferred",
          userId: row.user_id,
        }));
      }
    } catch {
      failed += 1;
      const attemptsMade = Math.min(20, row.attempts_made + 1);
      await bindings.db.prepare(`
        UPDATE organization_attempt_sync_outbox
           SET attempts_made = ?, available_at = ?, lease_token = NULL,
               lease_expires_at = NULL, last_error_code = 'attempt_sync_failed',
               updated_at = ?
         WHERE user_id = ? AND lease_token = ?
      `).bind(
        attemptsMade,
        retryAt(nowMs, attemptsMade),
        currentStamp,
        row.user_id,
        leaseToken,
      ).run().catch(() => undefined);
    }
  }
  return { selected: due.results.length, succeeded, failed };
}
