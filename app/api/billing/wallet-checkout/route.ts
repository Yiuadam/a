import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { stripeWalletConfigured } from "@/lib/billing/env";
import { BILLING_MESSAGES } from "@/lib/billing/messages";
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
    Neither the wallet nor the currency is asked for.

    The wallet: one Session lists whichever ones this Stripe account is
    approved for, and the buyer chooses on Stripe's own page.

    The currency: the base one, always. It was briefly resolved from the
    reader's address, and Stripe refused the Session — which wallet accepts
    which currency depends on the merchant's account, not only on the published
    tables. See walletCurrency in lib/billing/tiers.ts. Either way it is never
    taken from the request body: a caller who could name the currency could
    name the price, and a wallet line item is built by this app rather than
    read off a Stripe Price, so nothing downstream would catch it.
  */
  const origin = new URL(req.url).origin;
  try {
    const customerId = await stripeCustomerFor(user.id);
    const url = await createWalletCheckoutSession({
      plan,
      userId: user.id,
      email: user.email,
      customerId,
      successUrl: `${origin}/billing?checkout=done`,
      cancelUrl: `${origin}/pricing?checkout=cancelled`,
    });
    if (!url) throw new Error("Stripe returned a session with no url");
    return NextResponse.json({ url });
  } catch (err) {
    logInternal("billing/wallet-checkout", err);
    return safeJsonError(BILLING_MESSAGES.checkoutFailed, 502);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
