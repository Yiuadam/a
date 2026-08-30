import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { billingSnapshot } from "@/lib/billing/stripe";
import { stripeConfigured } from "@/lib/billing/env";
import { withCors } from "@/lib/http/cors";
import { logInternal } from "@/lib/auth/errors";
import { domainReadsFromCloudflare } from "@/lib/cloudflare/cutover-domains";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import {
  cloudflareAdminSignupsDaily,
  cloudflareAdminUserCount,
  cloudflareAdminUsageDaily,
  cloudflareAdminUsageBreakdown,
  cloudflareAdminTierCounts,
} from "@/lib/cloudflare/admin-stats";

/*
  The numbers behind the owner's dashboard.

  ---------------------------------------------------------------------------
  Every source is allowed to be missing

  Stripe may not be configured, the stats migration may not have been applied,
  the database may be having a bad minute. Each of those returns null for its
  own section and the page draws the rest — because a dashboard that shows
  nothing when one number is unavailable is a dashboard nobody trusts to tell
  them anything, and the owner most needs this screen on exactly the days when
  something is broken.

  A null is drawn as "unavailable" rather than as zero. Zero subscribers and
  "we could not ask Stripe" are very different mornings.

  ---------------------------------------------------------------------------
  Which figures can move to D1, and which never will

  `users` and `signups` move with native identity. Until the D1 identity
  roster is authoritative they retain the legacy RPC source; afterwards the
  dashboard counts only live `app_users`, exactly the accounts native sign-in
  can resolve. This keeps the dashboard truthful through the final cutover
  rather than presenting an old provider's roster as current.

  `usage`, `usageBreakdown` and `tiers` read `usage_events` and the
  entitlement resolver, neither of which is an identity read, so each has a
  D1 path (lib/cloudflare/admin-stats.ts) used when `admin_statistics` reads
  from Cloudflare. `tiers` counts D1's mirrored accounts, which can lag the
  true Supabase Auth count (`users`) by the mirror's own gap — expect the two
  not to sum identically until the mirror has caught up.
*/

export const dynamic = "force-dynamic";

const DAYS = 30;

interface DayRow {
  day: string;
  count?: number;
  admitted?: number;
  denied?: number;
}

interface UsageBreakdownRow {
  route: string;
  decision: "allowed" | "blocked_quota" | "blocked_rate";
  caller: "signed_in" | "anonymous";
  count: number;
}

async function safe<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    logInternal(`admin/stats:${what}`, err);
    return null;
  }
}

async function handleGET(req: Request) {
  if (!accountsEnabled() || !accountRuntimeEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  /*
    In parallel, because they are independent and the slowest of them decides
    how long the owner stares at a spinner. Stripe is usually the slow one.
  */
  const statisticsFromCloudflare = domainReadsFromCloudflare("admin_statistics");
  const nativeIdentityFromCloudflare = !supabaseConfigured()
    || (nativeAuthCutoverActive() && domainReadsFromCloudflare("admin_user_directory"));
  const [users, signups, usage, usageBreakdown, tiers, billing] = await Promise.all([
    safe("users", () => nativeIdentityFromCloudflare
      ? cloudflareAdminUserCount()
      : rpc<number>("admin_user_count", {})),
    safe<DayRow[]>("signups", () => nativeIdentityFromCloudflare
      ? cloudflareAdminSignupsDaily(DAYS)
      : rpc<DayRow[]>("admin_signups_daily", { p_days: DAYS })),
    safe("usage", (): Promise<DayRow[]> =>
      statisticsFromCloudflare
        ? cloudflareAdminUsageDaily(DAYS, user.id)
        : rpc<DayRow[]>("admin_usage_daily", {
            p_days: DAYS,
            p_admin_user_id: user.id,
          }),
    ),
    safe("usage-breakdown", (): Promise<UsageBreakdownRow[]> =>
      statisticsFromCloudflare
        ? cloudflareAdminUsageBreakdown(DAYS, user.id)
        : rpc<UsageBreakdownRow[]>("admin_usage_breakdown", {
            p_days: DAYS,
            p_admin_user_id: user.id,
          }),
    ),
    safe("tiers", (): Promise<{ tier: string; count: number }[]> =>
      statisticsFromCloudflare
        ? cloudflareAdminTierCounts(user.id)
        : rpc<{ tier: string; count: number }[]>("admin_tier_counts", {
            p_admin_user_id: user.id,
          }),
    ),
    stripeConfigured() ? safe("billing", () => billingSnapshot()) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    days: DAYS,
    users,
    signups,
    usage,
    usageBreakdown,
    tiers,
    billing,
    /*
      Which kind of nothing the billing figures are.

      "Stripe could not be reached" was printed for both causes, and they send
      the owner to completely different places: one is a key that is not on the
      Worker, the other is a key that is and a call that failed. The dashboard
      was telling them to check the network when the answer was that Stripe had
      never been configured on this deployment at all.

      A boolean rather than the reason, because the reason is in the server log
      and a stranger who somehow reached this route should not be handed a map
      of which of our credentials are missing.
    */
    stripeConfigured: stripeConfigured(),
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
