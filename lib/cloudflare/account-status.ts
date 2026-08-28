import { assertServerOnly } from "@/lib/auth/server-only";
import type { AccessGrant } from "@/lib/billing/access";
import type { CostedRoute } from "@/lib/ai/models";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

/*
  The account-status page is not a meter: it only describes the D1 usage and
  access records that the real meter and entitlement resolver already use.
  Keeping this read here prevents a native Cloudflare session from silently
  reaching Supabase just to draw its allowance or "renews" label.
*/

const MODULE = "lib/cloudflare/account-status.ts";

export interface CloudflareUsageDetail {
  oldestAt: string | null;
  byRoute: Partial<Record<CostedRoute, number>>;
}

interface UsageRow {
  route: string;
  used: number;
}

interface OldestUsageRow {
  oldest_at: string | null;
}

interface GrantRow {
  provider: string;
  tier: string;
  external_price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
}

function windowFloor(windowSeconds: number, now = Date.now()): string {
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("usage window must be a positive integer");
  }
  return new Date(now - windowSeconds * 1000).toISOString();
}

/** Same aggregate semantics as Supabase's service-role-only `usage_detail`. */
export async function cloudflareUsageDetail(
  userId: string,
  windowSeconds: number,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<CloudflareUsageDetail> {
  assertServerOnly(MODULE);
  if (!userId || userId.length > 80) return { oldestAt: null, byRoute: {} };
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const floor = windowFloor(windowSeconds, now);
  const [oldest, grouped] = await bindings.db.batch([
    bindings.db.prepare(`
      SELECT MIN(created_at) AS oldest_at
        FROM usage_events
       WHERE user_id = ? AND outcome = 'admitted' AND created_at > ?
    `).bind(userId, floor),
    bindings.db.prepare(`
      SELECT route, COUNT(*) AS used
        FROM usage_events
       WHERE user_id = ? AND outcome = 'admitted' AND created_at > ?
       GROUP BY route
    `).bind(userId, floor),
  ]);
  if (!oldest?.success || !grouped?.success) throw new Error("Cloudflare usage detail is unavailable");
  const oldestRow = (oldest.results[0] ?? null) as OldestUsageRow | null;
  const byRoute: Partial<Record<CostedRoute, number>> = {};
  for (const row of grouped.results as UsageRow[]) {
    if (typeof row.route === "string" && Number.isSafeInteger(row.used) && row.used >= 0) {
      byRoute[row.route as CostedRoute] = row.used;
    }
  }
  return {
    oldestAt: typeof oldestRow?.oldest_at === "string" ? oldestRow.oldest_at : null,
    byRoute,
  };
}

/** The D1 equivalent of the fixed `currentAccessGrants` Supabase read. */
export async function currentCloudflareAccessGrants(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<AccessGrant[]> {
  assertServerOnly(MODULE);
  if (!userId || userId.length > 80) return [];
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const rows = await bindings.db.prepare(`
    SELECT provider, tier, external_price_id, current_period_end, cancel_at_period_end
      FROM subscriptions
     WHERE user_id = ? AND status IN ('active', 'trialing')
     LIMIT 50
  `).bind(userId).all<GrantRow>();
  return rows.results.map((row) => ({
    provider: row.provider,
    tier: row.tier,
    priceId: row.external_price_id,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  }));
}
