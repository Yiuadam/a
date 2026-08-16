import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { stripeConfigured } from "@/lib/billing/env";
import { logBillingFailure } from "@/lib/billing/faults";
import { createCheckoutSession } from "@/lib/billing/stripe";
import { BILLING_MESSAGES } from "@/lib/billing/messages";
import { isPlanId, PLANS } from "@/lib/billing/tiers";
import { withCors } from "@/lib/http/cors";

/*
  Starts a Stripe Checkout Session and hands back the URL to send the learner
  to.

  ---------------------------------------------------------------------------
  What the request is allowed to choose, and what it is not

  It chooses a plan id — one of the names this app defined, checked against
  that list. It does not choose a price, a currency, an amount, a trial length
  or a customer. Those come from the server's own configuration, keyed by the
  plan id. The distinction is the whole security posture of this route: a
  request that could name a Stripe Price would be a request that could name the
  one-cent Price somebody made while testing, and Stripe would honour it
  because it is a real Price in the account.

  ---------------------------------------------------------------------------
  Why sign-in is required rather than optional

  A subscription has to attach to an account, and the account is what
  `resolve_entitlement` reads. Checkout as a guest would produce a paid Stripe
  customer with no BandUp account to grant anything to — a person who has been
  charged and has nothing, which is the worst outcome this route can produce.
  So the account comes first, and the account is free.
*/

export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured() || !stripeConfigured()) {
    /*
      Not an error, and not logged as one. This is how the app is deployed
      until somebody sets up Stripe, and the answer says so plainly instead of
      pretending something broke.
    */
    return safeJsonError(BILLING_MESSAGES.checkoutUnavailable, 503);
  }

  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    logInternal("billing/checkout/session", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 503);
  }
  /*
    Not signed in is not a fault, and nothing is logged for it.

    Worth saying out loud, because this route now shouts about failures and the
    worth of shouting depends entirely on what it stays quiet about. A
    signed-out visitor pressing Subscribe is the flow working: they are told to
    sign in, they sign in, they buy. Recording that beside "Stripe will not
    accept our key" is how the second one gets missed, which is precisely what
    happened. See lib/billing/faults.ts.
  */
  if (!user) return safeJsonError(BILLING_MESSAGES.signInFirst, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const plan = (body as { plan?: unknown } | null)?.plan;

  /*
    An unknown plan is a 400 that does not echo what was sent and does not list
    what would have worked. Reflecting the value would put caller-controlled
    text in a response; listing the valid ones would turn a refusal into a
    catalogue endpoint.
  */
  if (!isPlanId(plan)) {
    return NextResponse.json({ error: "That plan doesn't exist." }, { status: 400 });
  }

  /*
    Where Stripe sends the learner afterwards. `url.origin` is reconstructed
    from the Host header, which on Workers means it follows the host the
    request actually arrived on — so somebody who started on the .workers.dev
    address comes back to it and somebody on bandup.life comes back there,
    without either being configured. A forged Host would only change where the
    forger's own browser lands.

    They point at different pages, and the difference is what the learner wants
    next. Somebody who has just paid wants to see what they bought — their plan,
    the date it renews, the allowances that came with it — and that is /billing.
    Sending them back to the price list they had already decided on reads as
    though the payment did not register.

    Somebody who backed out wants the prices, because backing out is usually
    reconsidering which plan rather than whether. So they land where they were.

    Both pages read the query parameter and say something true about what just
    happened — see components/billing/CheckoutNotice.tsx.
  */
  const origin = new URL(req.url).origin;

  let url: string | null;
  try {
    url = await createCheckoutSession({
      plan,
      tier: PLANS[plan].tier,
      userId: user.id,
      email: user.email,
      successUrl: `${origin}/billing?checkout=done`,
      cancelUrl: `${origin}/pricing?checkout=cancelled`,
    });
  } catch (err) {
    /*
      Stripe's own error text names the account and the key's mode. It is read
      into the log and never returned. ACCOUNTS.md, threat 7.

      What changed after 16 August is only how loudly it is written down. A
      refusal no learner could have caused — an expired key, a Price id that
      names nothing, a payment method the account is not approved for — is
      logged with the `PAYMENTS-BROKEN` marker, and the owner console's
      checkout probe is what makes finding that marker unnecessary. The learner
      reads the same seven words either way.
    */
    logBillingFailure("billing/checkout", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 502);
  }

  if (!url) {
    /* Stripe answered 200 and sent no url. Nobody has seen this happen; if it
       ever does it is ours, and the marker says so. */
    logBillingFailure("billing/checkout", new Error("Stripe returned a session with no url"));
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 502);
  }

  /*
    The URL is returned rather than sent as a 302. The caller is `fetch` from a
    client component, and a redirect answered to fetch is followed by fetch —
    which would pull Stripe's checkout page into a cross-origin response the
    page then has to do something with. Handing back the URL lets the browser
    navigate to it properly, and it is the same shape the iOS build needs.
  */
  return NextResponse.json({ url });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
