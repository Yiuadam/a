import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import {
  supabaseConfigured,
  rpc,
  currentAccessGrants,
  enabledOAuthProviders,
} from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { entitlementRenews } from "@/lib/billing/access";
import { resolveEntitlement, ANONYMOUS_ENTITLEMENT } from "@/lib/billing/entitlements";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { MONTH_WINDOW_SECONDS } from "@/lib/usage/limits";
import { COSTED_ROUTES, ROUTE_BUDGETS } from "@/lib/ai/models";
import { monthlyCap } from "@/lib/billing/tiers";
import { OAUTH_PROVIDERS, providersReachableFrom } from "@/lib/auth/oauth";
import { withCors } from "@/lib/http/cors";

/*
  What the UI is allowed to know about the current account.

  This is the seam phase 2's account screen and paywall read from. It exists so
  that the client never has to work anything out for itself: it asks, and the
  server — which is the only party that can check — answers.

  Note what is not in the response: no role name beyond the flag the UI needs,
  no email, no subscription ids, no provider payloads, nothing about how the
  answer was reached. A screen that needs to know whether to show a paywall
  needs `tier` and `remaining`, and that is what it gets.
*/

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  // With the flag off this is the entire response: a flat "there are no
  // accounts here". Nothing is looked up, and the answer is the same for
  // everyone, so the endpoint tells an unauthenticated prober nothing.
  if (!accountsEnabled()) {
    return NextResponse.json({ enabled: false });
  }

  if (!supabaseConfigured()) {
    logInternal("account/status", new Error("ACCOUNTS_ENABLED=1 but Supabase is not configured"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  try {
    const user = await getSessionUser(req);
    const entitlement = user ? await resolveEntitlement(user.id, user.email) : ANONYMOUS_ENTITLEMENT;

    /*
      One allowance per route, counted over a rolling 30 days.

      usage_detail rather than usage_summary, because the billing screen needs
      two things a single total cannot give it. `by_route` is what turns "18 of
      20" into something a learner can act on — it names which allowance is
      nearly gone. `oldest_at` is when some of it comes back: the window rolls,
      so there is no reset day, and the honest answer is "your oldest request
      drops off 30 days after you made it". See
      supabase/migrations/0010_usage_detail.sql.

      If 0010 has not been applied this falls back to no detail at all rather
      than failing, because an un-run migration should cost this screen its
      usage bars and not the whole account status — every signed-in page depends
      on this route.
    */
    let oldestAt: string | null = null;
    let byRoute: Record<string, number> = {};
    if (user) {
      try {
        const detail = await rpc<{
          used: number;
          oldest_at: string | null;
          by_route: Record<string, number>;
        }>("usage_detail", {
          p_user_id: user.id,
          p_window_seconds: MONTH_WINDOW_SECONDS,
        });
        oldestAt = detail?.oldest_at ?? null;
        byRoute = detail?.by_route ?? {};
      } catch (err) {
        logInternal("account/status/usage_detail", err);
      }
    }

    /*
      Every route, always, in a fixed order — including the ones this tier has
      no allowance for. A tier with a zero allowance is a fact the screen should
      state ("Writing marked — not on your plan") rather than a row it quietly
      omits, because an omitted row reads as a missing feature rather than as an
      upgrade.
    */
    const routes = COSTED_ROUTES.map((route) => {
      const quota = user ? monthlyCap(entitlement.tier, route) : 0;
      const used = byRoute[route] ?? 0;
      return {
        route,
        label: ROUTE_BUDGETS[route].label,
        used,
        quota,
        remaining: quota === null ? null : Math.max(0, quota - used),
      };
    });
    const unlimited = routes.every((r) => r.quota === null);

    /*
      Only the providers this app offers *and* the project has configured. The
      intersection matters in both directions: a provider enabled in Supabase
      that this app has no button for is not offered, and a button this app
      could render for a provider that was never set up is not shown.
    */
    const configured = await enabledOAuthProviders();
    const providers = providersReachableFrom(
      req.headers.get("cf-ipcountry"),
      configured === null ? [] : OAUTH_PROVIDERS.filter((p) => configured.includes(p)),
    );

    /*
      Whether the date below is a renewal or an ending.

      `expiresAt` alone does not say. A card subscription renews on that date; an
      Alipay or WeChat Pay pass ends on it and the account drops back to Free.
      Every screen printed "Renews on" for both, which for a pass holder is false
      in the way that costs somebody their access with no warning — so the answer
      is established here, where the database is, rather than guessed in a
      browser.

      Asked only when there is a date to explain, which excludes every free
      account, the owner's own, and the free Pro trial (whose grant has no end).
      So the extra read costs nothing on the great majority of requests to this
      route, which is on nearly every page.

      Null when it cannot be established — an unreachable read, or no row matching
      the entitlement — and the screens then print the date with no claim about
      what happens on it. That is also what a Cloudflare-authoritative deployment
      would see, since this read is Supabase's.
    */
    let renews: boolean | null = null;
    if (user && entitlement.expiresAt !== null) {
      try {
        renews = entitlementRenews(entitlement, await currentAccessGrants(user.id));
      } catch (err) {
        logInternal("account/status/access_grants", err);
      }
    }

    return NextResponse.json({
      enabled: true,
      providers,
      signedIn: Boolean(user),
      tier: entitlement.tier,
      // The UI needs to know an admin has no cap so it can stop rendering a
      // counter, but the reason is not its business.
      unlimited,
      usage: {
        windowSeconds: MONTH_WINDOW_SECONDS,
        /*
          When the oldest request in the window expires — not a reset day,
          because there isn't one. Null when nothing is in the window, which
          means there is nothing waiting to come back.
        */
        oldestAt,
        routes,
      },
      expiresAt: entitlement.expiresAt,
      /*
        True for a subscription that will charge again, false for a pass that will
        simply end, null when there is no date or it could not be established. Not
        "why", and not which provider — a screen needs to know which sentence to
        print, and that is all this says.
      */
      renews,
    });
  } catch (err) {
    logInternal("account/status", err);
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }
}


/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
