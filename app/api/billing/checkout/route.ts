import { NextResponse } from "next/server";
import { hasStripeKey, NO_STRIPE_MESSAGE, siteUrl, stripe } from "@/lib/stripe";

/*
  Start a subscription.

  Stripe Checkout hosts the payment page, which is the whole point: card
  details never reach this app, so the compliance surface stays with Stripe and
  a learner in any of Stripe's supported countries gets a page in their own
  language with the payment methods they recognise.
*/

export async function POST(req: Request) {
  if (!hasStripeKey()) {
    return NextResponse.json({ error: NO_STRIPE_MESSAGE }, { status: 503 });
  }
  const price = process.env.STRIPE_PRICE_ID;
  if (!price) {
    return NextResponse.json(
      { error: "No plan is configured. Set STRIPE_PRICE_ID (see .env.example)." },
      { status: 503 },
    );
  }

  let email: string | undefined;
  try {
    const body = (await req.json()) as { email?: unknown };
    if (typeof body?.email === "string" && body.email.includes("@")) email = body.email;
  } catch {
    // An empty body is fine — Checkout will ask for the email itself.
  }

  const site = siteUrl(req);
  const trialDays = Number(process.env.STRIPE_TRIAL_DAYS ?? "");

  try {
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      // The session id is exchanged for an access token on the way back, so it
      // has to survive the redirect. Stripe substitutes it into this template.
      success_url: `${site}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/pricing`,
      customer_email: email,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      // Automatic tax is off unless the account has Stripe Tax set up; asking
      // for it without an origin address configured fails the whole session.
      automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "1" },
      subscription_data:
        Number.isFinite(trialDays) && trialDays > 0 ? { trial_period_days: trialDays } : undefined,
    });

    if (!session.url) {
      return NextResponse.json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not start checkout.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
