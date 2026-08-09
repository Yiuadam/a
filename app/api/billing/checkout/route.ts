import { NextResponse } from "next/server";
import { isInterval, isPlanId, priceIdFor } from "@/lib/plans";
import { hasStripeKey, NO_STRIPE_MESSAGE, siteUrl, stripe } from "@/lib/stripe";

/*
  Start a subscription on a chosen plan.

  Stripe Checkout hosts the payment page, which is the whole point: card
  details never reach this app, so the compliance surface stays with Stripe and
  a learner gets a page in their own language with the payment methods they
  recognise.

  The plan and interval arrive as names rather than price ids so the client
  never has to know them — the ids live in configuration, and a price changed
  in the dashboard needs no deploy here.
*/

export async function POST(req: Request) {
  if (!hasStripeKey()) {
    return NextResponse.json({ error: NO_STRIPE_MESSAGE }, { status: 503 });
  }

  let plan: unknown;
  let interval: unknown = "monthly";
  let email: string | undefined;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    plan = body.plan;
    if (body.interval !== undefined) interval = body.interval;
    if (typeof body.email === "string" && body.email.includes("@")) email = body.email;
  } catch {
    // Handled by the validation below.
  }

  if (!isPlanId(plan)) {
    return NextResponse.json({ error: "Choose a plan first." }, { status: 400 });
  }
  if (!isInterval(interval)) {
    return NextResponse.json({ error: "Choose monthly or quarterly." }, { status: 400 });
  }

  const price = priceIdFor(plan, interval);
  if (!price) {
    return NextResponse.json(
      { error: "That plan is not on sale yet. See .env.example for the price to configure." },
      { status: 503 },
    );
  }

  const site = siteUrl(req);

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
      // Hong Kong has no VAT or GST, so a domestic-only seller needs nothing.
      automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "1" },
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
