import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { currentCloudflareSourceClock } from "./source-clock";

const MODULE = "lib/cloudflare/entitlement-runtime.ts";

/**
 * The D1 half of `resolve_entitlement` (supabase/migrations/0026).
 *
 * Deliberately narrower than the Postgres function: it never looks at role.
 * The owner has retired database-granted admin — `ADMIN_EMAILS` is the only
 * authority now, and `lib/billing/entitlements.ts` already checks it before
 * either resolver runs, Supabase's or this one's. Consulting a role column
 * here would be a second place an account could be admin, which is exactly
 * what was retired.
 *
 * Row shape returned matches `RawEntitlement` minus `role`, which the caller
 * always fills in as "user" — correct, because by the time this runs the
 * caller has already ruled out the one way this build grants "admin".
 */
export interface CloudflareRawEntitlement {
  tier: string;
  source: string;
  expires_at: string | null;
}

const DEFAULT: CloudflareRawEntitlement = { tier: "free", source: "default", expires_at: null };

interface SubscriptionRow {
  tier: string;
  provider: string;
  current_period_end: string | null;
}

/*
  Tier rank, current_period_end DESC NULLS FIRST, verified_at DESC, id DESC —
  the exact order 0026's `resolve_entitlement` uses. SQLite has no `NULLS
  FIRST`; `(current_period_end IS NULL) DESC` puts the 1s (true, i.e. null)
  ahead of the 0s, which is the same ordering by another route.

  `current_period_end` and `verified_at` are stored as the nine-digit,
  UTC-normalised text `canonicalCloudflareSourceClock` produces (see
  lib/cloudflare/source-clock.ts, applied to these two columns by
  lib/cloudflare/billing-replica.ts's writers), so a plain text comparison
  against a value in that same format is a precise chronological comparison —
  including at sub-second boundaries, which is where a looser format would
  first go wrong.
*/
const QUERY = `
  SELECT tier, provider, current_period_end
    FROM subscriptions
   WHERE user_id = ?
     AND status IN ('active', 'trialing')
     AND (current_period_end IS NULL OR current_period_end > ?)
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
   LIMIT 1
`;

/**
 * Resolves one account's entitlement from the D1 mirror.
 *
 * Throws if the binding is unavailable or the query fails — the same contract
 * `resolveEntitlement` already has for the Supabase RPC it replaces, so
 * `lib/billing/gate.ts` and `lib/usage`'s fail-open/fail-closed switch keep
 * meaning what they already mean regardless of which backend answered.
 *
 * `now` defaults to the real clock; a caller may pass a fixed canonical
 * clock string instead. This exists for exactly one reason: `new Date()`
 * does not read a test's `Date.now` override (V8 calls its own internal
 * clock rather than the — possibly monkey-patched — `Date.now` property), so
 * a boundary test that needs "current_period_end equal to now, to the exact
 * instant" has no way to hold "now" still without this seam. Every real
 * caller leaves it unset.
 */
export async function resolveEntitlementFromCloudflare(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
  now: string = currentCloudflareSourceClock(),
): Promise<CloudflareRawEntitlement> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(QUERY).bind(userId, now).first<SubscriptionRow>();
  if (!row) return DEFAULT;
  return { tier: row.tier, source: row.provider, expires_at: row.current_period_end };
}
