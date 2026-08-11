import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { billingSnapshot } from "@/lib/billing/stripe";
import { stripeConfigured } from "@/lib/billing/env";
import { withCors } from "@/lib/http/cors";
import { logInternal } from "@/lib/auth/errors";

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
*/

export const dynamic = "force-dynamic";

const DAYS = 30;

interface DayRow {
  day: string;
  count?: number;
  admitted?: number;
  denied?: number;
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
  if (!accountsEnabled() || !supabaseConfigured()) {
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
  const [users, signups, usage, tiers, billing] = await Promise.all([
    safe("users", () => rpc<number>("admin_user_count", {})),
    safe("signups", () => rpc<DayRow[]>("admin_signups_daily", { p_days: DAYS })),
    safe("usage", () => rpc<DayRow[]>("admin_usage_daily", { p_days: DAYS })),
    safe("tiers", () => rpc<{ tier: string; count: number }[]>("admin_tier_counts", {})),
    stripeConfigured() ? safe("billing", () => billingSnapshot()) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    days: DAYS,
    users,
    signups,
    usage,
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
