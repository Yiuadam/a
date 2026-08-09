import { NextResponse } from "next/server";
import { hasBillingSecret, verifyAccessToken, type AccessClaims } from "./entitlement";
import { hasStripeKey } from "./stripe";

/*
  The paywall, as the AI routes see it.

  Only the four routes that spend money on Claude are gated — writing marking,
  the speaking examiner, test generation and word lookup. The placement test,
  the bundled papers, the study plan and the glossary stay free and stay
  server-free, which is also what keeps the iOS bundle useful without a
  purchase it is not allowed to offer.
*/

/**
 * Whether to enforce at all.
 *
 * A checkout cannot exist without Stripe keys, so an unconfigured install —
 * a contributor running `npm run dev` with only ANTHROPIC_API_KEY — would be
 * left with an app whose AI features nothing could ever unlock. Enforcement
 * therefore switches on with the billing configuration, and a deployment that
 * wants the guarantee regardless can set BILLING_ENFORCED=1 so a missing key
 * fails closed instead of quietly giving the paid features away.
 */
export function billingEnforced(): boolean {
  if (process.env.BILLING_ENFORCED === "1") return true;
  if (process.env.BILLING_ENFORCED === "0") return false;
  return hasStripeKey() && hasBillingSecret();
}

/** Distinguishes "you never had access" from "your token just needs renewing". */
export type GateCode = "payment-required" | "token-expired";

export type Gate =
  | { ok: true; claims: AccessClaims | null }
  | { ok: false; response: NextResponse };

function refuse(code: GateCode, error: string): { ok: false; response: NextResponse } {
  // 402 rather than 401: the request is not unauthenticated, it is unpaid, and
  // the client distinguishes the two cases by `code` rather than by status.
  return { ok: false, response: NextResponse.json({ error, code }, { status: 402 }) };
}

/**
 * Read and check the caller's access token.
 *
 * Returns `claims: null` when billing is switched off, so a route can treat
 * "not enforcing" and "entitled" identically and never has to ask twice.
 */
export function requireAccess(req: Request): Gate {
  if (!billingEnforced()) return { ok: true, claims: null };

  if (!hasBillingSecret()) {
    // BILLING_ENFORCED=1 with nothing to verify against. Refuse rather than
    // let an unverifiable token through.
    return refuse("payment-required", "Billing is not configured on the server.");
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return refuse("payment-required", "This feature is part of BandUp Plus.");
  }

  const { claims, failure } = verifyAccessToken(token);
  if (failure === "expired") {
    return refuse("token-expired", "Your access needs renewing.");
  }
  if (!claims) {
    return refuse("payment-required", "This feature is part of BandUp Plus.");
  }
  return { ok: true, claims };
}
