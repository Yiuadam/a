import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { countryFromRequest, currencyForCountry } from "@/lib/billing/currency";
import { stripeWalletConfigured } from "@/lib/billing/env";
import { BILLING_MESSAGES } from "@/lib/billing/messages";
import { logBillingFailure } from "@/lib/billing/faults";
import { createWalletCheckoutSession } from "@/lib/billing/stripe";
import { stripeCustomerFor } from "@/lib/billing/subscriptions";
import { isPlanId } from "@/lib/billing/tiers";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured() || !stripeWalletConfigured()) {
    return safeJsonError(BILLING_MESSAGES.checkoutUnavailable, 503);
  }

  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    logInternal("billing/wallet-checkout/session", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 503);
  }
  if (!user) return safeJsonError(BILLING_MESSAGES.signInFirst, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const plan = (body as { plan?: unknown } | null)?.plan;
  if (!isPlanId(plan)) {
    return NextResponse.json({ error: "That payment choice isn't available." }, { status: 400 });
  }

  /*
    Which wallet is no longer asked for: one Session offers both and the buyer
    chooses on Stripe's page.

    The currency is resolved here, from the address Cloudflare resolved, and
    never from the request body. A caller who could name the currency could
    name the price — pick the cheapest one in the catalogue and pay that — and
    a wallet line item is built by this app rather than read off a Stripe
    Price, so there would be nothing downstream to catch it.
  */
  const currency = currencyForCountry(countryFromRequest(req));

  const origin = new URL(req.url).origin;
  try {
    const customerId = await stripeCustomerFor(user.id);
    const url = await createWalletCheckoutSession({
      plan,
      currency,
      userId: user.id,
      email: user.email,
      customerId,
      successUrl: `${origin}/billing?checkout=done`,
      cancelUrl: `${origin}/pricing?checkout=cancelled`,
    });
    if (!url) throw new Error("Stripe returned a session with no url");
    return NextResponse.json({ url });
  } catch (err) {
    /*
      Same classification as the card route, and it matters more here: the
      wallets are the half of payments most likely to stop working with nothing
      in this repository changing, because Alipay and WeChat Pay can be
      switched off, or left in Stripe's "pending approval", on the account
      itself. That is invisible from here and total for the buyer, so it is
      logged as `PAYMENTS-BROKEN` rather than as one more line.
    */
    logBillingFailure("billing/wallet-checkout", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 502);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
