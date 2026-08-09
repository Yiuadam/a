import { NextResponse } from "next/server";
import { hasBillingSecret, NO_SECRET_MESSAGE, verifyAccessToken } from "@/lib/entitlement";
import { hasStripeKey, NO_STRIPE_MESSAGE, siteUrl, stripe } from "@/lib/stripe";

/*
  Hand the learner over to Stripe's Customer Portal.

  Everything a subscriber might want to do after paying — change card, see and
  download past invoices, cancel — lives there, which is why this integration
  needs no billing screens of its own and no webhook to keep them accurate.
  What the portal shows is Stripe's own state, so it cannot drift.
*/

export async function POST(req: Request) {
  if (!hasStripeKey()) {
    return NextResponse.json({ error: NO_STRIPE_MESSAGE }, { status: 503 });
  }
  if (!hasBillingSecret()) {
    return NextResponse.json({ error: NO_SECRET_MESSAGE }, { status: 503 });
  }

  let token = "";
  try {
    const body = (await req.json()) as { token?: unknown };
    if (typeof body?.token === "string") token = body.token.trim();
  } catch {
    // Handled by the emptiness check below.
  }

  // An expired token is still proof of who this is, and someone whose card has
  // lapsed is exactly who most needs the portal.
  const { claims } = verifyAccessToken(token, true);
  if (!claims) {
    return NextResponse.json({ error: "Sign in with your access link first." }, { status: 402 });
  }

  try {
    const session = await stripe().billingPortal.sessions.create({
      customer: claims.ref,
      return_url: `${siteUrl(req)}/pricing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not open the billing portal.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
