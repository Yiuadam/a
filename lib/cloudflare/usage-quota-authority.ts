import { assertServerOnly } from "@/lib/auth/server-only";
import type { SessionUser } from "@/lib/auth/session";
import type { AiRoute } from "@/lib/usage/limits";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { ensureCloudflareUser } from "./learner-data";
import { canonicalCloudflareSourceClock } from "./source-clock";
import type { UsageEventOutcome } from "./usage-cost-replica";

const MODULE = "lib/cloudflare/usage-quota-authority.ts";

/*
  The D1-only admission path for the `usage_quota_authority` cutover domain —
  see lib/cloudflare/cutover-domains.ts.

  ---------------------------------------------------------------------------
  Why this cannot be `check_and_record_usage` translated line for line

  Postgres serialises the whole decision behind `pg_advisory_xact_lock`
  (supabase/migrations/0012_route_limits.sql) — every caller for the same
  user (or the same IP, for an anonymous one) queues behind a lock, then reads
  a count and inserts, and nothing else can run in between because nothing
  else holds the lock. D1 has no advisory lock. A transliteration that reads a
  count and then inserts if it was under cap has a gap between those two
  statements — a window request A and request B can both read "9 used, cap
  10" and both insert, and the eleventh call of the month is free.

  The fix is not a lock; it is not needing one. `admitUsageEventOnCloudflare`
  below expresses "insert this row only if the caps still allow it" as a
  single INSERT ... SELECT ... WHERE statement. The WHERE clause is exactly
  the query that would have been the separate read, but because it runs
  inside the same statement as the insert it evaluates against the same
  database state that the insert commits against — there is no gap for a
  second caller to land in, because D1 (like the SQLite it is built on) never
  interleaves the execution of one write statement with another. The caller
  learns whether it admitted by reading `meta.changes`: 1 means the row went
  in, 0 means the WHERE clause was false and nothing was written.

  A denial still has to be recorded — Postgres does the same, and
  migration-readiness / domain-drift both expect a `denied_quota` or
  `denied_rate` row to exist, not just an absent `admitted` one — so the deny
  write rides in the same `batch()` call as the admit attempt. `batch()` runs
  its statements as one D1 transaction, in order, so the deny statement's own
  `WHERE NOT EXISTS (... id = admitId)` sees the *result* of the admit
  attempt that just ran ahead of it in the same batch, not a stale read of it:
  exactly one of the two statements ever inserts a row.

  ---------------------------------------------------------------------------
  Why the ids are minted from a counter rather than random

  usage_events.id is TEXT everywhere but holds a decimal integer, and three
  independent pieces of code — lib/usage/guard.ts's `/^[1-9]\d*$/` validator,
  lib/cloudflare/migration-readiness.ts's `ORDER BY length(id), id`, and
  lib/cloudflare/domain-drift.ts's plain `ORDER BY id` keyset pagination —
  depend on that. A ULID or a UUID would satisfy none of them. See
  `mintUsageEventIds` below for how the counter is seeded and why seeding it
  is a step the owner takes with `wrangler d1 execute`, not something this
  file guesses at.

  ---------------------------------------------------------------------------
  Why the entitlement (tier, role) is a parameter rather than resolved here

  Because it already has one true resolver — `resolveEntitlement` in
  lib/billing/entitlements.ts, which is itself cutover-aware
  (`billing_entitlement_runtime`) and already handles ADMIN_EMAILS. Re-doing
  any part of that here would be a second place the two could disagree. The
  caller (lib/usage/guard.ts) resolves it once and passes the tier's already-
  looked-up per-route caps in.
*/

const USAGE_EVENTS_SEQUENCE = "usage_events";

/** Thrown when the D1 id counter for a sequence has not been seeded. */
export class CloudflareIdSequenceNotSeededError extends Error {
  constructor(sequence: string) {
    super(
      `The D1 id counter for "${sequence}" is not seeded. This is an operator step, not ` +
      "a bug: see the pull request that added lib/cloudflare/usage-quota-authority.ts for " +
      "the exact wrangler d1 execute commands, and run them before setting this domain's " +
      "mode to 'cloudflare'.",
    );
    this.name = "CloudflareIdSequenceNotSeededError";
  }
}

/**
 * Reserves a contiguous block of `count` ids from a named D1 counter and
 * returns them as decimal-digit text, oldest first.
 *
 * One statement, one round trip: `next_value` is advanced by `count` and the
 * pre-advance value is recovered by subtracting back from the new value in
 * the same `RETURNING` clause, so there is no separate read that a concurrent
 * mint could race against. The result is cast to TEXT inside SQL, not in
 * JavaScript, so a counter that someday exceeds 2^53 is never round-tripped
 * through a JS `number` — the same reason every id elsewhere in this system
 * is carried as TEXT rather than as an integer type.
 *
 * Gaps in the sequence (an id minted for an attempt that turned out to be a
 * duplicate, or for a deny path that was not taken) are expected and
 * harmless — nothing here promises a *dense* sequence, only a strictly
 * increasing one whose decimal-text order agrees with its numeric order.
 *
 * `count` is cast to INTEGER inside the SQL rather than trusted as bound. A
 * bound JS number is not guaranteed to arrive with SQLite's INTEGER type —
 * this codebase's own D1 test harness binds it as REAL — and `INTEGER -
 * REAL` promotes to REAL, which would have made `first_id` read `"1000.0"`
 * instead of `"1000"`, silently breaking the `/^[1-9]\d*$/` id shape every
 * other reader of this column depends on. Casting forces INTEGER arithmetic
 * regardless of how the driver bound the parameter.
 */
async function mintIds(
  db: BandUpCloudflareBindings["db"],
  sequence: string,
  count: number,
): Promise<string[]> {
  const row = await db.prepare(`
    UPDATE cloudflare_id_sequences
       SET next_value = next_value + CAST(? AS INTEGER)
     WHERE sequence_name = ?
    RETURNING CAST(next_value - CAST(? AS INTEGER) AS TEXT) AS first_id
  `).bind(count, sequence, count).first<{ first_id: string }>();
  if (!row) throw new CloudflareIdSequenceNotSeededError(sequence);
  const first = BigInt(row.first_id);
  return Array.from({ length: count }, (_, index) => (first + BigInt(index)).toString());
}

export interface UsageAuthorityCaps {
  /** Per-route monthly cap for the resolved tier. `null` is unlimited. */
  monthly: number | null;
  /** Per-route rolling-window cap for the resolved tier. `null` is unlimited. */
  weekly: number | null;
  /** Per-IP-address cap, ignored for an admin caller. `null` is unlimited. */
  ip: number | null;
  /** Cap for an unauthenticated caller, checked instead of monthly/weekly. `null` is unlimited. */
  anonymous: number | null;
}

export interface UsageAuthorityRequest {
  user: SessionUser | null;
  userId: string | null;
  ipHash: string | null;
  route: AiRoute;
  /** The owner's account, per `resolveEntitlement` — exempt from the IP cap. */
  isAdmin: boolean;
  caps: UsageAuthorityCaps;
  monthWindowSeconds: number;
  /** The rolling window `weekly`, `anonymous` and `ip` are all checked over. */
  windowSeconds: number;
  /** Defaults to the real clock; a test may hold it fixed. */
  now?: string;
}

export interface UsageAuthorityDecision {
  allowed: boolean;
  reason: "ok" | "quota_exceeded" | "rate_limited";
  eventId: string;
  eventCreatedAt: string;
  eventOutcome: UsageEventOutcome;
}

interface CapClause {
  sql: string;
  args: unknown[];
}

function underCap(countSql: string, args: unknown[], cap: number | null): CapClause | null {
  if (cap === null) return null;
  return { sql: `(${countSql}) < ?`, args: [...args, cap] };
}

/** ANDs a list of cap clauses. An empty list is "always under cap" — unlimited. */
function andClauses(clauses: CapClause[]): CapClause {
  if (clauses.length === 0) return { sql: "1", args: [] };
  return {
    sql: clauses.map((clause) => `(${clause.sql})`).join(" AND "),
    args: clauses.flatMap((clause) => clause.args),
  };
}

function floorTimestamp(nowMs: number, windowSeconds: number): string {
  return new Date(nowMs - windowSeconds * 1000).toISOString();
}

/**
 * Atomically decides whether one usage event may be admitted, and records
 * exactly one row — `admitted`, `denied_quota` or `denied_rate` — either way.
 *
 * Throws `CloudflareIdSequenceNotSeededError` if the id counter has not been
 * provisioned, and a plain `Error` for any other D1 failure. The caller
 * (lib/usage/guard.ts) decides what each means for the response — see that
 * file for why an unseeded counter is treated differently from an ordinary
 * D1 outage.
 */
export async function admitUsageEventOnCloudflare(
  request: UsageAuthorityRequest,
  providedBindings?: BandUpCloudflareBindings,
): Promise<UsageAuthorityDecision> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const { userId, ipHash, route, isAdmin, caps } = request;
  /*
    `nowMs` drives the window-floor arithmetic below and is computed from
    `Date.now()` directly rather than by parsing a canonical nine-fraction-
    digit clock string back — `Date.parse` is only asked to round-trip a
    string in the (test-only) case where a caller supplied one. The row's
    `created_at` is still written in the same canonical, sub-second-precise
    form every other D1 writer uses.
  */
  const nowMs = request.now !== undefined ? Date.parse(request.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid usage authority timestamp");
  const now = request.now ?? canonicalCloudflareSourceClock(new Date(nowMs).toISOString());

  if (userId !== null) {
    if (!request.user || request.user.id !== userId) {
      throw new Error("Cloudflare usage authority request user does not match userId");
    }
    await ensureCloudflareUser(request.user, bindings);
  }

  const monthFloor = floorTimestamp(nowMs, request.monthWindowSeconds);
  const windowFloor = floorTimestamp(nowMs, request.windowSeconds);

  // Clauses that mean "you have used this month/period" — reported as
  // `quota_exceeded`, matching check_and_record_usage.
  const quotaClauses: CapClause[] = [];
  // Clauses that mean "come back later" — reported as `rate_limited`.
  const rateClauses: CapClause[] = [];

  if (userId !== null) {
    const monthly = underCap(
      `SELECT COUNT(*) FROM usage_events
        WHERE user_id = ? AND route = ? AND outcome = 'admitted' AND created_at > ?`,
      [userId, route, monthFloor],
      caps.monthly,
    );
    if (monthly) quotaClauses.push(monthly);

    const weekly = underCap(
      `SELECT COUNT(*) FROM usage_events
        WHERE user_id = ? AND route = ? AND outcome = 'admitted' AND created_at > ?`,
      [userId, route, windowFloor],
      caps.weekly,
    );
    if (weekly) rateClauses.push(weekly);
  } else {
    const anonymous = underCap(
      `SELECT COUNT(*) FROM usage_events
        WHERE user_id IS NULL AND ip_hash IS ? AND outcome = 'admitted' AND created_at > ?`,
      [ipHash, windowFloor],
      caps.anonymous,
    );
    if (anonymous) quotaClauses.push(anonymous);
  }

  if (!isAdmin && ipHash !== null) {
    const ip = underCap(
      `SELECT COUNT(*) FROM usage_events
        WHERE ip_hash = ? AND outcome = 'admitted' AND created_at > ?`,
      [ipHash, windowFloor],
      caps.ip,
    );
    if (ip) rateClauses.push(ip);
  }

  const quota = andClauses(quotaClauses);
  const rate = andClauses(rateClauses);

  const [admitId, denyId] = await mintIds(bindings.db, USAGE_EVENTS_SEQUENCE, 2);

  const admitStatement = bindings.db.prepare(`
    WITH caps (quota_ok, rate_ok) AS (SELECT (${quota.sql}), (${rate.sql}))
    INSERT INTO usage_events (id, user_id, route, ip_hash, outcome, created_at)
    SELECT ?, ?, ?, ?, 'admitted', ?
      FROM caps
     WHERE quota_ok AND rate_ok
  `).bind(...quota.args, ...rate.args, admitId, userId, route, ipHash, now);

  const denyStatement = bindings.db.prepare(`
    WITH caps (quota_ok, rate_ok) AS (SELECT (${quota.sql}), (${rate.sql}))
    INSERT INTO usage_events (id, user_id, route, ip_hash, outcome, created_at)
    SELECT ?, ?, ?, ?,
           CASE WHEN NOT quota_ok THEN 'denied_quota' ELSE 'denied_rate' END,
           ?
      FROM caps
     WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE id = ?)
  `).bind(...quota.args, ...rate.args, denyId, userId, route, ipHash, now, admitId);

  const [admitResult, denyResult] = await bindings.db.batch([admitStatement, denyStatement]);
  if (!admitResult?.success || !denyResult?.success) {
    throw new Error("Cloudflare usage authority batch is unavailable");
  }

  if (admitResult.meta.changes === 1) {
    return { allowed: true, reason: "ok", eventId: admitId, eventCreatedAt: now, eventOutcome: "admitted" };
  }
  if (denyResult.meta.changes !== 1) {
    // Neither statement wrote a row. This should not be reachable — the two
    // WHERE clauses are exact logical complements of each other — and is
    // treated as a hard failure rather than silently reporting "denied"
    // without a recorded event, which would make the meter's own count wrong.
    throw new Error("Cloudflare usage authority batch admitted no row and recorded no denial");
  }
  const written = await bindings.db.prepare(`
    SELECT outcome FROM usage_events WHERE id = ?
  `).bind(denyId).first<{ outcome: string }>();
  const eventOutcome: UsageEventOutcome = written?.outcome === "denied_quota"
    ? "denied_quota"
    : "denied_rate";
  return {
    allowed: false,
    reason: eventOutcome === "denied_quota" ? "quota_exceeded" : "rate_limited",
    eventId: denyId,
    eventCreatedAt: now,
    eventOutcome,
  };
}
