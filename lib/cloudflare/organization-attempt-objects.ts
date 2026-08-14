import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

const REFERENCE_CHUNK = 40;
const CLEANUP_LIMIT = 100;
const MAX_BACKOFF_EXPONENT = 8;

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function retryAt(nowMs: number, attemptsMade: number): string {
  const seconds = Math.min(60 * 60, 15 * (2 ** Math.min(attemptsMade, MAX_BACKOFF_EXPONENT)));
  return new Date(nowMs + seconds * 1000).toISOString();
}

function safeAttemptObjectKey(value: string, userId: string): boolean {
  const safeOwner = userId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return value.startsWith(`private/attempts/${safeOwner}/`) && value.length <= 1024;
}

async function referencedKeys(
  bindings: BandUpCloudflareBindings,
  candidates: readonly string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += REFERENCE_CHUNK) {
    const page = candidates.slice(offset, offset + REFERENCE_CHUNK);
    const markers = page.map(() => "?").join(",");
    const rows = await bindings.db.prepare(`
      SELECT result_object_key AS object_key FROM practice_attempts
       WHERE result_object_key IN (${markers})
      UNION
      SELECT payload_object_key AS object_key FROM organization_attempt_sync_outbox
       WHERE payload_object_key IN (${markers})
    `).bind(...page, ...page).all<{ object_key: string }>();
    for (const row of rows.results) referenced.add(row.object_key);
  }
  return referenced;
}

async function forgetCleanupRows(
  bindings: BandUpCloudflareBindings,
  keys: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += REFERENCE_CHUNK) {
    const page = keys.slice(offset, offset + REFERENCE_CHUNK);
    if (page.length === 0) continue;
    const markers = page.map(() => "?").join(",");
    await bindings.db.prepare(`
      DELETE FROM organization_attempt_object_cleanup WHERE object_key IN (${markers})
    `).bind(...page).run();
  }
}

async function queueCleanupRows(
  bindings: BandUpCloudflareBindings,
  userId: string,
  keys: readonly string[],
  nowMs: number,
): Promise<void> {
  const createdAt = stamp(nowMs);
  for (let offset = 0; offset < keys.length; offset += REFERENCE_CHUNK) {
    const page = keys.slice(offset, offset + REFERENCE_CHUNK);
    if (page.length === 0) continue;
    await bindings.db.batch(page.map((key) => bindings.db.prepare(`
      INSERT INTO organization_attempt_object_cleanup (
        object_key, user_id, attempts_made, available_at, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(object_key) DO UPDATE SET
        attempts_made = min(20, organization_attempt_object_cleanup.attempts_made + 1),
        available_at = ?,
        updated_at = ?
    `).bind(
      key,
      userId,
      retryAt(nowMs, 1),
      createdAt,
      createdAt,
      retryAt(nowMs, 2),
      createdAt,
    )));
  }
}

/**
 * Delete only objects which no live attempt or outbox row still names.
 * Pointer correctness is authoritative; an R2 failure becomes durable cleanup
 * work rather than rolling a successful D1 mutation back.
 */
export async function retireOrganizationAttemptObjects(
  bindings: BandUpCloudflareBindings,
  userId: string,
  values: readonly (string | null | undefined)[],
  nowMs: number = Date.now(),
): Promise<boolean> {
  const candidates = [...new Set(values.filter(
    (value): value is string =>
      typeof value === "string" && safeAttemptObjectKey(value, userId),
  ))];
  if (candidates.length === 0) return true;

  let referenced: Set<string>;
  try {
    referenced = await referencedKeys(bindings, candidates);
  } catch {
    await queueCleanupRows(bindings, userId, candidates, nowMs).catch(() => undefined);
    return false;
  }

  const live = candidates.filter((key) => referenced.has(key));
  const orphaned = candidates.filter((key) => !referenced.has(key));
  await forgetCleanupRows(bindings, live).catch(() => undefined);
  if (orphaned.length === 0) return true;

  try {
    await bindings.files.delete(orphaned);
    await forgetCleanupRows(bindings, orphaned).catch(() => undefined);
    return true;
  } catch {
    await queueCleanupRows(bindings, userId, orphaned, nowMs).catch(() => undefined);
    return false;
  }
}

/** Retry a bounded page of prior pointer-safe R2 cleanup failures. */
export async function reconcileOrganizationAttemptObjects(
  providedBindings?: BandUpCloudflareBindings,
  options: { limit?: number; nowMs?: number } = {},
): Promise<{ selected: number; remainingFailures: number }> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(CLEANUP_LIMIT, Math.trunc(options.limit ?? 20)));
  const due = await bindings.db.prepare(`
    SELECT object_key, user_id FROM organization_attempt_object_cleanup
     WHERE available_at <= ? ORDER BY available_at, object_key LIMIT ?
  `).bind(stamp(nowMs), limit).all<{ object_key: string; user_id: string }>();
  let remainingFailures = 0;
  for (const row of due.results) {
    if (!(await retireOrganizationAttemptObjects(
      bindings,
      row.user_id,
      [row.object_key],
      nowMs,
    ))) remainingFailures += 1;
  }
  return { selected: due.results.length, remainingFailures };
}
