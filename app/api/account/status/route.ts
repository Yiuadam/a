import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured, rpc, enabledOAuthProviders } from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { resolveEntitlement, ANONYMOUS_ENTITLEMENT } from "@/lib/billing/entitlements";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { USAGE_LIMITS, USAGE_WINDOW_SECONDS } from "@/lib/usage/limits";
import { OAUTH_PROVIDERS } from "@/lib/auth/oauth";
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
    const entitlement = user ? await resolveEntitlement(user.id) : ANONYMOUS_ENTITLEMENT;

    const quota = user
      ? USAGE_LIMITS[entitlement.tier]
      : USAGE_LIMITS.anonymous;

    /*
      usage_detail rather than usage_summary: the billing screen needs to say
      when some allowance comes back, and the window rolls, so the answer is
      "your oldest request drops off 24 hours after you made it" — which needs
      that timestamp. by_route is what turns "18 of 20" into something a
      learner can act on. See supabase/migrations/0010_usage_detail.sql.

      Falls back to the old summary if 0010 has not been applied yet, because
      an un-run migration should cost this screen its extra detail and not the
      whole account status — every signed-in page depends on this route.
    */
    let used = 0;
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
          p_window_seconds: USAGE_WINDOW_SECONDS,
        });
        used = detail?.used ?? 0;
        oldestAt = detail?.oldest_at ?? null;
        byRoute = detail?.by_route ?? {};
      } catch {
        used = await rpc<number>("usage_summary", {
          p_user_id: user.id,
          p_window_seconds: USAGE_WINDOW_SECONDS,
        });
      }
    }

    /*
      Only the providers this app offers *and* the project has configured. The
      intersection matters in both directions: a provider enabled in Supabase
      that this app has no button for is not offered, and a button this app
      could render for a provider that was never set up is not shown.
    */
    const configured = await enabledOAuthProviders();
    const providers =
      configured === null ? [] : OAUTH_PROVIDERS.filter((p) => configured.includes(p));

    return NextResponse.json({
      enabled: true,
      providers,
      signedIn: Boolean(user),
      tier: entitlement.tier,
      // The UI needs to know an admin has no cap so it can stop rendering a
      // counter, but the reason is not its business.
      unlimited: quota === null,
      usage: {
        used,
        quota,
        windowSeconds: USAGE_WINDOW_SECONDS,
        remaining: quota === null ? null : Math.max(0, quota - used),
        /*
          When the oldest request in the window expires — not a reset hour,
          because there isn't one. Null when nothing is in the window, which
          means there is nothing waiting to come back.
        */
        oldestAt,
        byRoute,
      },
      expiresAt: entitlement.expiresAt,
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
