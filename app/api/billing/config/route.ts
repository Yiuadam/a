import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { countryFromRequest, currencyForCountry } from "@/lib/billing/currency";
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

  What *is* here is which of those prices to show, because only the server
  knows where the reader is. Cloudflare resolves the address to a country and
  puts it in CF-IPCountry in front of the Worker; a prerendered page cannot see
  that header, and guessing from the browser's locale would show a Hongkonger
  living in London the wrong currency. The page is charged in this currency too
  — Stripe Checkout picks by the same address — so page and card agree by
  construction rather than by coincidence.
*/

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  /*
    Checkout needs somewhere to write the subscription just as much as it needs
    a payment provider, so both halves are checked. With accounts off there is
    no account to attach a subscription to, and selling one would be selling
    something that could not be delivered.
  */
  const plans = accountsEnabled() && supabaseConfigured() ? purchasablePlans() : [];
  const currency = currencyForCountry(countryFromRequest(req));

  return NextResponse.json({
    checkout: plans.length > 0,
    plans,
    /*
      Always sent, whether or not anything can be bought. The page prints
      prices even when checkout is closed — that is the point of the honest
      empty state — and printing them in the wrong currency would be a worse
      lie than not offering the button.
    */
    currency,
  });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
