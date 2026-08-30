import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { currentCloudflareSourceClock } from "./source-clock";

const MODULE = "lib/cloudflare/admin-directory.ts";
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 500_000;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface CloudflareAdminDirectoryUser {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  accountKind: string | null;
  registeredAt: string;
  plan: string;
  accessSource: string;
  organizationSeatCount: number;
  usage30d: number;
  totalCount: number;
}

export interface CloudflareAdminDirectoryPage {
  users: CloudflareAdminDirectoryUser[];
  total: number;
}

export interface CloudflareAdminUsageRow {
  route: string;
  admitted: number;
  refused: number;
}

export interface CloudflareAdminDirectoryDetail extends CloudflareAdminDirectoryUser {
  usage: CloudflareAdminUsageRow[];
}

interface DirectoryRow {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  account_kind: string | null;
  registered_at: string;
  plan: string | null;
  access_source: string | null;
  organization_seat_count: number | string | null;
  usage_30d: number | string | null;
  total_count: number | string | null;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function usageWindowStart(now = Date.now()): string {
  return currentCloudflareSourceClock(new Date(now - USAGE_WINDOW_MS).toISOString());
}

function mapDirectoryRow(row: DirectoryRow): CloudflareAdminDirectoryUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    accountKind: row.account_kind,
    registeredAt: row.registered_at,
    plan: row.plan ?? "free",
    accessSource: row.access_source ?? "default",
    organizationSeatCount: Number(row.organization_seat_count ?? 0),
    usage30d: Number(row.usage_30d ?? 0),
    totalCount: Number(row.total_count ?? 0),
  };
}

/*
  All personal fields in this query are D1's own app_users/profile/username
  records.  It intentionally never calls Supabase Auth: once native identity
  is active, the owner console must show exactly the same account roster the
  application itself can authenticate and clean up.

  The three correlated counts stay in one statement so an admin page cannot
  combine one account roster from before a write with usage or organisation
  numbers from a later round trip. Every value is bound; the searchable text
  is data, never a fragment of SQL.
*/
const DIRECTORY_SELECT = `
  WITH ranked_subscriptions AS (
    SELECT user_id, tier, provider,
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
      ) AS rank
    FROM subscriptions
    WHERE status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR current_period_end > ?)
  )
  SELECT
    u.id,
    u.email,
    username.username,
    profile.display_name,
    profile.account_kind,
    u.created_at AS registered_at,
    COALESCE(subscription.tier, 'free') AS plan,
    COALESCE(subscription.provider, 'default') AS access_source,
    (
      SELECT count(*)
        FROM organization_seat_allocations allocation
        JOIN organization_seat_pools pool
          ON pool.id = allocation.seat_pool_id
         AND pool.organization_id = allocation.organization_id
       WHERE allocation.user_id = u.id
         AND allocation.status IN ('reserved', 'active')
         AND allocation.starts_at <= ?
         AND (allocation.ends_at IS NULL OR allocation.ends_at > ?)
         AND pool.status = 'active'
         AND (pool.starts_at IS NULL OR pool.starts_at <= ?)
         AND (pool.ends_at IS NULL OR pool.ends_at > ?)
    ) AS organization_seat_count,
    (
      SELECT count(*)
        FROM usage_events usage
       WHERE usage.user_id = u.id AND usage.created_at >= ?
    ) AS usage_30d,
    count(*) OVER () AS total_count
  FROM app_users u
  LEFT JOIN learner_profiles profile ON profile.user_id = u.id
  LEFT JOIN usernames username ON username.user_id = u.id
  LEFT JOIN ranked_subscriptions subscription
    ON subscription.user_id = u.id AND subscription.rank = 1
`;

const SEARCH_PREDICATE = `
  u.deleted_at IS NULL
  AND (
    ? = ''
    OR lower(COALESCE(u.email, '')) LIKE '%' || lower(?) || '%'
    OR lower(COALESCE(username.username, '')) LIKE '%' || lower(?) || '%'
    OR lower(COALESCE(profile.display_name, '')) LIKE '%' || lower(?) || '%'
  )
`;

function commonParameters(query: string, now: string, usageStart: string): unknown[] {
  return [now, now, now, now, now, usageStart, query, query, query, query];
}

/** Returns a bounded, D1-authoritative owner directory page. */
export async function cloudflareAdminDirectoryPage(
  options: { query: string; limit: number; offset: number },
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAdminDirectoryPage> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const query = options.query.trim().slice(0, 120);
  const limit = bounded(options.limit, 1, MAX_PAGE_SIZE);
  const offset = bounded(options.offset, 0, MAX_OFFSET);
  const now = currentCloudflareSourceClock();
  const rows = await bindings.db.prepare(`
    ${DIRECTORY_SELECT}
    WHERE ${SEARCH_PREDICATE}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ? OFFSET ?
  `).bind(...commonParameters(query, now, usageWindowStart()), limit, offset)
    .all<DirectoryRow>();
  const users = rows.results.map(mapDirectoryRow);
  return { users, total: users[0]?.totalCount ?? 0 };
}

/** Finds one live D1 account and its last-30-day meter decisions. */
export async function cloudflareAdminDirectoryDetail(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAdminDirectoryDetail | null> {
  assertServerOnly(MODULE);
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const now = currentCloudflareSourceClock();
  const user = await bindings.db.prepare(`
    ${DIRECTORY_SELECT}
    WHERE u.deleted_at IS NULL AND u.id = ?
    LIMIT 1
  `).bind(now, now, now, now, now, usageWindowStart(), userId)
    .first<DirectoryRow>();
  if (!user) return null;

  const usage = await bindings.db.prepare(`
    SELECT route,
           SUM(CASE WHEN outcome = 'admitted' THEN 1 ELSE 0 END) AS admitted,
           SUM(CASE WHEN outcome <> 'admitted' THEN 1 ELSE 0 END) AS refused
      FROM usage_events
     WHERE user_id = ? AND created_at >= ?
     GROUP BY route
     ORDER BY route
  `).bind(userId, usageWindowStart()).all<CloudflareAdminUsageRow>();

  return { ...mapDirectoryRow(user), usage: usage.results.map((row) => ({
    route: row.route,
    admitted: Number(row.admitted),
    refused: Number(row.refused),
  })) };
}
