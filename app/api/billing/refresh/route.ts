import { NextResponse } from "next/server";
import {
  hasBillingSecret,
  mintAccessToken,
  NO_SECRET_MESSAGE,
  resolveEntitlement,
  TTL_SECONDS,
  verifyAccessToken,
} from "@/lib/entitlement";
import { PLANS } from "@/lib/plans";
import { readUsage } from "@/lib/quota";
import { hasStripeKey, NO_STRIPE_MESSAGE } from "@/lib/stripe";

/*
  Renew an expired token.

  This is the one place a cancellation actually bites. The old token's
  signature still proves this server minted it, so the Stripe id inside can be
  trusted; what is not trusted is that the subscription behind it is still
  live, or still on the same plan. Both are re-read here, which is also how an
  upgrade or a new billing period reaches the learner's device.
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
  if (!token) {
    return NextResponse.json({ error: "Missing token." }, { status: 400 });
  }

  const { claims, failure } = verifyAccessToken(token, true);
  if (!claims) {
    const error =
      failure === "stale"
        ? "This device has been signed out for too long. Restore access from your receipt email."
        : "That access token is not valid.";
    return NextResponse.json({ error, code: "payment-required" }, { status: 402 });
  }

  try {
    const entitlement = await resolveEntitlement(claims.ref);
    if (!entitlement) {
      return NextResponse.json(
        { error: "Your subscription is no longer active.", code: "payment-required" },
        { status: 402 },
      );
    }
    return NextResponse.json({
      token: mintAccessToken(claims.ref, entitlement.plan, entitlement.periodStart),
      expiresIn: TTL_SECONDS,
      plan: entitlement.plan,
      planName: PLANS[entitlement.plan].name,
      usage: await readUsage(entitlement.plan, claims.ref, entitlement.periodStart),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not renew access.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
