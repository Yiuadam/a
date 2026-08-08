import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { purchasablePlans } from "@/lib/billing/env";
import { withCors } from "@/lib/http/cors";

/*
  What the pricing page needs to know before it draws a button.

  It answers one question — can anybody actually buy anything right now? — and
  it is here because the answer depends on environment variables that are
  server-only by design. The browser has no way to learn whether a Stripe key
  exists other than by asking, and the alternative to asking is a button that
  looks live and fails on the first click.

  Note what is *not* returned. Not the Stripe publishable key, not a Price id,
  not a hint about which of the two is missing. A caller learns which plans can
  be started and nothing about how that was decided, so a prober gets the same
  answer as a learner.

  The prices themselves are not here either: they are in lib/billing/tiers.ts,
  which the page imports directly. Display prices are public by definition and
  a round trip to be told what the bundle already contains would be latency in
  exchange for nothing.
*/

export const dynamic = "force-dynamic";

async function handleGET() {
  /*
    Checkout needs somewhere to write the subscription just as much as it needs
    a payment provider, so both halves are checked. With accounts off there is
    no account to attach a subscription to, and selling one would be selling
    something that could not be delivered.
  */
  const plans = accountsEnabled() && supabaseConfigured() ? purchasablePlans() : [];

  return NextResponse.json({
    checkout: plans.length > 0,
    plans,
  });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
