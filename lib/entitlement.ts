import { createHmac } from "node:crypto";
import { planForPriceId, PLANS, type PlanId } from "./plans";
import { stripe } from "./stripe";

/*
  Who is allowed to spend our Claude budget, decided without a database.

  The app has no accounts and ROADMAP.md defers building them, so Stripe is the
  record of who has paid. Asking Stripe on every graded essay would be slow and
  would tie the examiner to Stripe's uptime, so a successful checkout mints a
  short-lived token that the learner's browser keeps and presents.

  The token is a signed claim, not a secret to be looked up: verifying it is one
  HMAC and no network call. It carries a Stripe customer id, which plan was
  bought, and when the current billing period began — the last of these is what
  `lib/quota.ts` keys allowances on, so a period rolling over resets them with
  no reset job to run.

  What the token deliberately does not carry is how much of the plan is left.
  A counter the client holds is a counter the client can wind back by
  presenting an older copy of it; usage is server-side for that reason alone.

  The cost of holding no state here is that a cancellation is not felt until
  the token expires. TTL_SECONDS is the whole of that exposure: twelve hours of
  access already paid for, in exchange for never having a subscription table to
  keep in step with Stripe.
*/

export interface AccessClaims {
  /** Bumped to 2 when plans arrived; v1 tokens carried no plan and are refused. */
  v: 2;
  /** Stripe customer id. */
  ref: string;
  plan: PlanId;
  /** Start of the current billing period, epoch seconds — the quota window. */
  ps: number;
  /** Expiry, epoch seconds. */
  e: number;
}

/** How long a minted token is trusted without re-asking Stripe. */
export const TTL_SECONDS = 12 * 60 * 60;

/**
 * How long after expiry a token may still be exchanged for a fresh one.
 *
 * Refresh re-checks Stripe, so a lapsed subscription is caught either way; the
 * bound just stops an abandoned token being a permanent handle on the account.
 */
export const REFRESH_GRACE_SECONDS = 60 * 24 * 60 * 60;

/**
 * Subscription states that still open the AI features.
 *
 * `past_due` is included on purpose: Stripe retries a failed card over several
 * days, and locking a paying learner out on the first hiccup — mid-essay, most
 * likely — costs more goodwill than the few days of access it saves.
 */
const ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"]);

export const NO_SECRET_MESSAGE =
  "Billing is not configured. Add BILLING_TOKEN_SECRET to .env.local (see .env.example) and restart the server.";

export function hasBillingSecret(): boolean {
  return Boolean(process.env.BILLING_TOKEN_SECRET);
}

function secret(): string {
  const s = process.env.BILLING_TOKEN_SECRET;
  if (!s) throw new Error(NO_SECRET_MESSAGE);
  return s;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function unb64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`access.${payload}`).digest("base64url");
}

/**
 * Compare without leaking, through timing, how much of the tag was right.
 *
 * Written by hand rather than with `crypto.timingSafeEqual` because that throws
 * on a length mismatch — which for an attacker-supplied string is itself the
 * answer to a question — and because it is not uniformly available on the
 * Workers runtime this repo can also deploy to.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** A token proving the bearer holds `plan`, valid for TTL_SECONDS. */
export function mintAccessToken(ref: string, plan: PlanId, periodStart: number): string {
  const claims: AccessClaims = { v: 2, ref, plan, ps: periodStart, e: now() + TTL_SECONDS };
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}

export type VerifyFailure = "invalid" | "expired" | "stale";

export interface VerifyResult {
  claims?: AccessClaims;
  failure?: VerifyFailure;
}

/**
 * Check a token's signature, and its expiry unless the caller is refreshing.
 *
 * `allowExpired` is what /api/billing/refresh uses: the signature still proves
 * the token was minted here, so the Stripe id inside it can be trusted enough
 * to go and ask Stripe whether the subscription is still live.
 */
export function verifyAccessToken(token: string, allowExpired = false): VerifyResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { failure: "invalid" };
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload))) return { failure: "invalid" };

  let claims: AccessClaims;
  try {
    claims = JSON.parse(unb64url(payload)) as AccessClaims;
  } catch {
    return { failure: "invalid" };
  }

  if (claims?.v !== 2) return { failure: "invalid" };
  if (typeof claims.ref !== "string" || !claims.ref) return { failure: "invalid" };
  if (!(claims.plan in PLANS)) return { failure: "invalid" };
  if (typeof claims.ps !== "number" || typeof claims.e !== "number") return { failure: "invalid" };

  const age = now() - claims.e;
  if (age > 0) {
    if (!allowExpired) return { failure: "expired" };
    if (age > REFRESH_GRACE_SECONDS) return { failure: "stale" };
  }
  return { claims };
}

export interface Entitlement {
  plan: PlanId;
  periodStart: number;
}

/**
 * Ask Stripe what this customer currently holds.
 *
 * Returns the best live subscription rather than the first: someone who
 * upgraded mid-period briefly has two, and the one they just paid more for is
 * the one they should get. `current_period_start` is read off the subscription
 * item — Stripe moved it there from the subscription itself, and reading the
 * old location silently yields undefined rather than an error.
 */
export async function resolveEntitlement(customerId: string): Promise<Entitlement | null> {
  const subs = await stripe().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });

  let best: Entitlement | null = null;
  for (const sub of subs.data) {
    if (!ENTITLING_STATUSES.has(sub.status)) continue;
    for (const item of sub.items.data) {
      const priceId = typeof item.price === "string" ? item.price : item.price?.id;
      if (!priceId) continue;
      const plan = planForPriceId(priceId);
      if (!plan) continue;
      const periodStart = item.current_period_start;
      if (typeof periodStart !== "number") continue;
      if (!best || PLANS[plan].rank > PLANS[best.plan].rank) {
        best = { plan, periodStart };
      }
    }
  }
  return best;
}
