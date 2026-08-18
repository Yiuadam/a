import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { canonicalCloudflareSourceClock, currentCloudflareSourceClock } from "./source-clock";

const MODULE = "lib/cloudflare/admin-stats.ts";
const MAX_DAYS = 366;

/*
  The D1 half of supabase/migrations/0027_admin_usage_truth.sql's
  admin_usage_daily, admin_usage_breakdown and admin_tier_counts — the three
  figures the owner decided genuinely move, because they read `usage_events`
  and the entitlement resolver rather than `auth.users` identity. See the
  cutover-domain registry entry for `admin_statistics` for what deliberately
  does *not* move (admin_user_count, admin_signups_daily): those are
  auth.users reads, and Supabase Auth is not migrating.
*/

function clampDays(days: number): number {
  const value = Number.isFinite(days) ? Math.trunc(days) : 30;
  return Math.min(Math.max(value, 1), MAX_DAYS);
}

/**
 * UTC calendar-day bounds matching the Postgres version's
 * `(now() at time zone 'UTC')::date` boundary exactly: `startInclusive` is
 * midnight UTC `dayCount - 1` days before today, `endExclusive` is midnight
 * UTC tomorrow. Both are rendered through `canonicalCloudflareSourceClock` so
 * a plain text comparison against `usage_events.created_at` (stored in that
 * same nine-digit format) is a precise chronological comparison — a bare
 * `.toISOString()` boundary would compare wrong against a longer fraction
 * with the same leading digits, because ISO's trailing "Z" sorts after every
 * digit character.
 *
 * `allDays` lists every UTC calendar day in the window, oldest first, so a
 * day with zero rows in D1 still appears with a zero count — matching the
 * Postgres version's `generate_series` day fill, done here in JavaScript
 * because D1 has no `generate_series`.
 */
function utcDayWindow(days: number): { startInclusive: string; endExclusive: string; allDays: string[] } {
  const dayCount = clampDays(days);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const allDays: string[] = [];
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - offset);
    allDays.push(day.toISOString().slice(0, 10));
  }

  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (dayCount - 1));
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    startInclusive: canonicalCloudflareSourceClock(start.toISOString()),
    endExclusive: canonicalCloudflareSourceClock(end.toISOString()),
    allDays,
  };
}

export interface CloudflareAdminDayRow {
  day: string;
  admitted: number;
  denied: number;
}

/**
 * Daily admitted/denied counts, learner demand only.
 *
 * `excludeUserId` drops exactly one account's rows — the calling admin's own,
 * matching `admin_usage_daily(p_days, p_admin_user_id)`'s existing behaviour
 * of correcting for the signed-in owner's own diagnostic traffic rather than
 * every ADMIN_EMAILS address globally. Anonymous rows (`user_id IS NULL`)
 * are never excluded by this condition.
 */
export async function cloudflareAdminUsageDaily(
  days: number,
  excludeUserId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAdminDayRow[]> {
  assertServerOnly(MODULE);
  const { startInclusive, endExclusive, allDays } = utcDayWindow(days);
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const query = await db.prepare(`
    SELECT substr(created_at, 1, 10) AS day,
           SUM(CASE WHEN outcome = 'admitted' THEN 1 ELSE 0 END) AS admitted,
           SUM(CASE WHEN outcome <> 'admitted' THEN 1 ELSE 0 END) AS denied
      FROM usage_events
     WHERE created_at >= ? AND created_at < ?
       AND (user_id IS NULL OR user_id <> ?)
     GROUP BY day
  `).bind(startInclusive, endExclusive, excludeUserId)
    .all<{ day: string; admitted: number; denied: number }>();

  const byDay = new Map(query.results.map((row) => [row.day, row]));
  return allDays.map((day) => ({
    day,
    admitted: Number(byDay.get(day)?.admitted ?? 0),
    denied: Number(byDay.get(day)?.denied ?? 0),
  }));
}

export interface CloudflareAdminUsageBreakdownRow {
  route: string;
  decision: "allowed" | "blocked_quota" | "blocked_rate";
  caller: "signed_in" | "anonymous";
  count: number;
}

const DECISION_BY_OUTCOME: Record<string, CloudflareAdminUsageBreakdownRow["decision"]> = {
  admitted: "allowed",
  denied_quota: "blocked_quota",
  denied_rate: "blocked_rate",
};

/** Identity-free route/decision/caller breakdown — same shape and exclusion as `cloudflareAdminUsageDaily`. */
export async function cloudflareAdminUsageBreakdown(
  days: number,
  excludeUserId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAdminUsageBreakdownRow[]> {
  assertServerOnly(MODULE);
  const { startInclusive, endExclusive } = utcDayWindow(days);
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const query = await db.prepare(`
    SELECT route, outcome, (user_id IS NULL) AS anonymous, COUNT(*) AS count
      FROM usage_events
     WHERE created_at >= ? AND created_at < ?
       AND (user_id IS NULL OR user_id <> ?)
     GROUP BY route, outcome, anonymous
  `).bind(startInclusive, endExclusive, excludeUserId)
    .all<{ route: string; outcome: string; anonymous: number; count: number }>();

  const rows: CloudflareAdminUsageBreakdownRow[] = [];
  for (const row of query.results) {
    const decision = DECISION_BY_OUTCOME[row.outcome];
    if (!decision) continue; // The CHECK constraint on `outcome` makes this unreachable; kept defensive.
    rows.push({
      route: row.route,
      decision,
      caller: row.anonymous ? "anonymous" : "signed_in",
      count: Number(row.count),
    });
  }
  return rows.sort((a, b) =>
    a.route.localeCompare(b.route)
    || a.decision.localeCompare(b.decision)
    || a.caller.localeCompare(b.caller));
}

export interface CloudflareAdminTierCount {
  tier: string;
  count: number;
}

/**
 * Accounts grouped by effective tier, using the same window-function ranking
 * as `cloudflareAdminDirectoryEntitlements` (see that file for the tie-break
 * order), counted over every mirrored account rather than a specific page.
 *
 * Counted over D1's `app_users` mirror, not the Supabase Auth roster —
 * `admin_user_count` is the one true account count and stays on Supabase by
 * the owner's decision; this total can lag it by exactly the D1 mirror's own
 * gap. That is a known, documented limitation (see the pull request), not a
 * bug to chase here.
 *
 * `adminUserId` is folded to `'admin'` the same single-account way
 * `admin_tier_counts(p_admin_user_id)` already does: it corrects the calling
 * admin's own row, not every ADMIN_EMAILS address at once.
 */
export async function cloudflareAdminTierCounts(
  adminUserId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAdminTierCount[]> {
  assertServerOnly(MODULE);
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const now = currentCloudflareSourceClock();
  const query = await db.prepare(`
    WITH ranked AS (
      SELECT user_id, tier,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY
            CASE tier
              WHEN 'pro' THEN 3
              WHEN 'plus' THEN 2
              WHEN 'standard' THEN 1
              WHEN 'free' THEN 0
              ELSE -1
            END DESC,
            (current_period_end IS NULL) DESC,
            current_period_end DESC,
            verified_at DESC,
            id DESC
        ) AS rn
        FROM subscriptions
       WHERE status IN ('active', 'trialing')
         AND (current_period_end IS NULL OR current_period_end > ?)
    )
    SELECT
      CASE WHEN u.id = ? THEN 'admin' ELSE COALESCE(r.tier, 'free') END AS tier,
      COUNT(*) AS count
      FROM app_users u
      LEFT JOIN ranked r ON r.user_id = u.id AND r.rn = 1
     WHERE u.deleted_at IS NULL
     GROUP BY tier
     ORDER BY tier
  `).bind(now, adminUserId).all<{ tier: string; count: number }>();

  return query.results.map((row) => ({ tier: row.tier, count: Number(row.count) }));
}
