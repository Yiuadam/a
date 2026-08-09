import { NextResponse } from "next/server";
import { hasBillingSecret, verifyAccessToken, type AccessClaims } from "./entitlement";
import { PLAN_IDS, PLANS, type Meter, type PlanId } from "./plans";
import { quotaConfigured, refund, spend } from "./quota";
import { hasStripeKey } from "./stripe";

/*
  The paywall, as the AI routes see it.

  Only the four routes that spend money on Claude are metered — writing
  marking, the speaking examiner, test generation and word lookup. The
  placement test, the bundled papers, the study plan and the glossary stay free
  and stay server-free, which is also what keeps the iOS bundle useful without
  a purchase it is not allowed to offer.

  Two questions get asked here, and they fail differently. Whether someone has
  paid is a signed claim and answering it costs nothing. How much of the plan
  they have left is a counter in a store that can be slow or down — so the
  first question is answered before the second is asked, and the second one
  failing does not lock a paying learner out.
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

export type GateCode = "payment-required" | "token-expired" | "quota-exhausted";

export type Gate =
  | {
      ok: true;
      claims: AccessClaims | null;
      /** Undo the credit this call took, when the work it paid for failed. */
      release: () => Promise<void>;
    }
  | { ok: false; response: NextResponse };

const NOTHING = async () => {};

function refuse(code: GateCode, error: string, extra?: object) {
  // 402 rather than 401: the request is not unauthenticated, it is unpaid, and
  // the client distinguishes the cases by `code` rather than by status.
  return {
    ok: false as const,
    response: NextResponse.json({ error, code, ...extra }, { status: 402 }),
  };
}

/** The next plan up from `plan`, or null at the top. */
function nextPlanUp(plan: PlanId): PlanId | null {
  return PLAN_IDS.find((id) => PLANS[id].rank === PLANS[plan].rank + 1) ?? null;
}

const METER_LABEL: Record<Meter, string> = {
  marking: "markings",
  generation: "generated tests",
  lookup: "word lookups",
};

/**
 * Check the caller's token, then take one unit of `meter` from their plan.
 *
 * Returns `claims: null` when billing is switched off, so a route can treat
 * "not enforcing" and "entitled" identically and never has to ask twice.
 */
export async function requireAccess(req: Request, meter: Meter): Promise<Gate> {
  if (!billingEnforced()) return { ok: true, claims: null, release: NOTHING };

  if (!hasBillingSecret()) {
    // BILLING_ENFORCED=1 with nothing to verify against. Refuse rather than
    // let an unverifiable token through.
    return refuse("payment-required", "Billing is not configured on the server.");
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return refuse("payment-required", "This feature needs a BandUp plan.");
  }

  const { claims, failure } = verifyAccessToken(token);
  if (failure === "expired") {
    return refuse("token-expired", "Your access needs renewing.");
  }
  if (!claims) {
    return refuse("payment-required", "This feature needs a BandUp plan.");
  }

  // Nothing to meter against — a deployment can run plans without a quota
  // store, and the alternative is refusing paying customers over a missing
  // optional dependency.
  if (!quotaConfigured()) {
    return { ok: true, claims, release: NOTHING };
  }

  const result = await spend(claims.plan, claims.ref, claims.ps, meter);

  if (!result.ok && result.reason === "exhausted") {
    const next = nextPlanUp(claims.plan);
    const label = METER_LABEL[meter];
    return refuse(
      "quota-exhausted",
      next
        ? `You have used all ${PLANS[claims.plan].allowance[meter]} ${label} in your ${PLANS[claims.plan].name} plan this period. ${PLANS[next].name} includes ${PLANS[next].allowance[meter]}.`
        : `You have used all ${PLANS[claims.plan].allowance[meter]} ${label} in your ${PLANS[claims.plan].name} plan. They reset when your next billing period starts.`,
      { meter, plan: claims.plan, nextPlan: next, usage: result.usage },
    );
  }

  if (!result.ok) {
    // The store was unreachable. Failing closed here would lock out paying
    // learners over an outage that is not their fault; the exposure is bounded
    // by how long the store stays down, and it is logged in lib/quota.ts.
    console.warn(`[gate] quota store unavailable — allowing ${meter} for ${claims.ref}`);
    return { ok: true, claims, release: NOTHING };
  }

  return {
    ok: true,
    claims,
    release: () => refund(claims.ref, claims.ps, meter),
  };
}
