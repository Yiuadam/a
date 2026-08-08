import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { stripeConfigured } from "@/lib/billing/env";
import { createPortalSession } from "@/lib/billing/stripe";
import { stripeCustomerFor } from "@/lib/billing/subscriptions";
import { BILLING_MESSAGES } from "@/lib/billing/messages";
import { withCors } from "@/lib/http/cors";

/*
  Where a subscriber goes to change their card, read an invoice, or cancel.

  Cancelling has to be at least as easy as subscribing. Building our own cancel
  button would mean writing a second path capable of ending a subscription, and
  a second path is a second thing that can be wrong about who is asking.
  Stripe's Billing Portal is one API call and it is the same portal that emails
  the receipts, so there is one place a learner manages what they pay and one
  place this app can be wrong about it.

  ---------------------------------------------------------------------------
  Whose portal

  The customer id is not accepted from the request. It is looked up from the
  subscription rows belonging to the account the bearer token resolved to. A
  route that took a customer id from the caller would be a route that opens
  anybody's billing history to anybody who guesses a `cus_` string — and Stripe
  would open it, because from Stripe's side the request is properly
  authenticated as us.
*/

export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured() || !stripeConfigured()) {
    return safeJsonError(BILLING_MESSAGES.checkoutUnavailable, 503);
  }

  let customerId: string | null;
  try {
    const user = await getSessionUser(req);
    if (!user) return safeJsonError(BILLING_MESSAGES.signInFirst, 401);
    customerId = await stripeCustomerFor(user.id);
  } catch (err) {
    logInternal("billing/portal/lookup", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 503);
  }

  /*
    404 rather than a redirect to somewhere unhelpful. An account with no
    customer id has never completed a checkout, and the honest answer is that
    there is nothing to manage.
  */
  if (!customerId) {
    return NextResponse.json({ error: BILLING_MESSAGES.noSubscription }, { status: 404 });
  }

  let url: string | null;
  try {
    url = await createPortalSession({
      customerId,
      returnUrl: `${new URL(req.url).origin}/pricing`,
    });
  } catch (err) {
    logInternal("billing/portal", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 502);
  }

  if (!url) {
    logInternal("billing/portal", new Error("Stripe returned a portal session with no url"));
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 502);
  }

  return NextResponse.json({ url });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
