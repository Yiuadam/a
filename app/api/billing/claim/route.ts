import { NextResponse } from "next/server";
import {
  hasBillingSecret,
  mintAccessToken,
  NO_SECRET_MESSAGE,
  resolveEntitlement,
  TTL_SECONDS,
} from "@/lib/entitlement";
import { PLANS } from "@/lib/plans";
import { readUsage } from "@/lib/quota";
import { hasStripeKey, NO_STRIPE_MESSAGE, stripe } from "@/lib/stripe";

/*
  Turn a finished checkout into an access token.

  The learner arrives back from Stripe with a session id in the URL. That id is
  not itself proof of anything — it is visible in the address bar and in any
  referrer — so it is spent here exactly once, for a token that is proof: the
  session is looked up server-side, the customer read off it, and the
  subscription checked against Stripe before anything is minted.
*/

export async function POST(req: Request) {
  if (!hasStripeKey()) {
    return NextResponse.json({ error: NO_STRIPE_MESSAGE }, { status: 503 });
  }
  if (!hasBillingSecret()) {
    return NextResponse.json({ error: NO_SECRET_MESSAGE }, { status: 503 });
  }

  let sessionId = "";
  try {
    const body = (await req.json()) as { sessionId?: unknown };
    if (typeof body?.sessionId === "string") sessionId = body.sessionId.trim();
  } catch {
    // Handled by the emptiness check below.
  }
  if (!sessionId.startsWith("cs_")) {
    return NextResponse.json({ error: "Missing checkout session." }, { status: 400 });
  }

  try {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    if (session.status !== "complete") {
      return NextResponse.json(
        { error: "That payment has not completed yet. If you have just paid, try again shortly." },
        { status: 409 },
      );
    }

    const customer =
      typeof session.customer === "string" ? session.customer : (session.customer?.id ?? "");
    if (!customer) {
      return NextResponse.json({ error: "That checkout has no customer." }, { status: 409 });
    }

    // A complete session is not the same as a live subscription — it can have
    // been cancelled between paying and landing here.
    const entitlement = await resolveEntitlement(customer);
    if (!entitlement) {
      return NextResponse.json(
        { error: "That subscription is not active. Check your email from Stripe for details." },
        { status: 402 },
      );
    }

    return NextResponse.json({
      token: mintAccessToken(customer, entitlement.plan, entitlement.periodStart),
      expiresIn: TTL_SECONDS,
      plan: entitlement.plan,
      planName: PLANS[entitlement.plan].name,
      usage: await readUsage(entitlement.plan, customer, entitlement.periodStart),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not confirm that payment.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
