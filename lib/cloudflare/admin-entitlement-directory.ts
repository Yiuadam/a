import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { currentCloudflareSourceClock } from "./source-clock";

const MODULE = "lib/cloudflare/admin-entitlement-directory.ts";
const MAX_USERS = 100;

export interface AdminDirectoryEntitlement {
  /**
   * False means this id has no `app_users` row at all — not "resolved to
   * free", genuinely absent from the D1 mirror. See the pull request that
   * added this for why that distinction has to survive to the caller: an
   * account Auth knows about that D1 has never heard of previously vanished
   * from a D1-backed directory with no error and no gap, which is exactly how
   * one profile and one username went missing unnoticed for three days.
   */
  mirrored: boolean;
  tier: string;
  source: string;
}

function distinctUserIds(userIds: readonly string[]): string[] {
  return [...new Set(userIds.filter((value) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, MAX_USERS);
}

/**
 * The D1 half of the directory's per-account plan, batched for a page of the
 * (Supabase) roster.
 *
 * Ranking is the exact tie-break order `lib/cloudflare/entitlement-runtime.ts`
 * uses for one account at a time — tier rank, `current_period_end` DESC NULLS
 * FIRST (via `(current_period_end IS NULL) DESC`, SQLite has no NULLS FIRST),
 * `verified_at` DESC, `id` DESC — expressed as a window function so a whole
 * page resolves in one round trip instead of one D1 query per row. See that
 * file's comment for why each clause is there; keep the two in agreement if
 * either changes.
 *
 * Deliberately never reads `role`: admin is ADMIN_EMAILS-only, exactly as in
 * `resolveEntitlementFromCloudflare`, and the caller here applies that
 * override the same way `resolveEntitlement` does before either backend runs.
 */
export async function cloudflareAdminDirectoryEntitlements(
  userIds: readonly string[],
  providedBindings?: BandUpCloudflareBindings,
): Promise<Map<string, AdminDirectoryEntitlement>> {
  assertServerOnly(MODULE);
  const ids = distinctUserIds(userIds);
  const result = new Map<string, AdminDirectoryEntitlement>(
    ids.map((id) => [id, { mirrored: false, tier: "free", source: "default" }]),
  );
  if (ids.length === 0) return result;

  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  // The ids CTE used to be one `SELECT ? AS id` per row joined with
  // UNION ALL — bound once, as the comment here used to explain, but a
  // UNION ALL branch per id is a compound SELECT with as many terms as
  // there are ids. D1 enforces a lower SQLITE_LIMIT_COMPOUND_SELECT than
  // SQLite's own default (the same limit #163 hit in
  // lib/cloudflare/replica-outbox.ts's objectIsReferenced, there with only
  // seven fixed branches), and this call's branch count grows with the
  // account roster — it broke in production once the directory passed nine
  // accounts. json_each reads the same ids from a single bound JSON array
  // instead, so this is one parameter regardless of roster size and never a
  // compound SELECT at all.
  const now = currentCloudflareSourceClock();
  const query = await db.prepare(`
    WITH ids(id) AS (SELECT value FROM json_each(?)),
    ranked AS (
      SELECT s.user_id, s.tier, s.provider,
        ROW_NUMBER() OVER (
          PARTITION BY s.user_id
          ORDER BY
            CASE s.tier
              WHEN 'pro' THEN 3
              WHEN 'plus' THEN 2
              WHEN 'standard' THEN 1
              WHEN 'free' THEN 0
              ELSE -1
            END DESC,
            (s.current_period_end IS NULL) DESC,
            s.current_period_end DESC,
            s.verified_at DESC,
            s.id DESC
        ) AS rn
        FROM subscriptions s
        JOIN ids ON ids.id = s.user_id
       WHERE s.status IN ('active', 'trialing')
         AND (s.current_period_end IS NULL OR s.current_period_end > ?)
    )
    SELECT u.id AS user_id, r.tier, r.provider
      FROM app_users u
      JOIN ids ON ids.id = u.id
      LEFT JOIN ranked r ON r.user_id = u.id AND r.rn = 1
     WHERE u.deleted_at IS NULL
  `).bind(JSON.stringify(ids), now).all<{ user_id: string; tier: string | null; provider: string | null }>();

  for (const row of query.results) {
    result.set(row.user_id, {
      mirrored: true,
      tier: row.tier ?? "free",
      source: row.provider ?? "default",
    });
  }
  return result;
}
