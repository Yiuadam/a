import { assertServerOnly } from "@/lib/auth/server-only";
import { PLANS, PLAN_IDS, type PlanId, type Tier } from "./tiers";

/*
  Every environment variable payments read, in one place, server-side only.

  This is lib/auth/env.ts's pattern applied to the billing lane, and it obeys
  the same two rules, for the same reason (ACCOUNTS.md, threat 4):

  1. Every value is read through `process.env[name]` with a *computed* key. A
     computed key is invisible to Next's static replacement of `process.env.FOO`
     in client bundles, so there is no expression in this file that a client
     build could turn into a literal string.

  2. Reading any of them calls `assertServerOnly` first, so a client component
     that imports this module throws immediately rather than quietly receiving
     `undefined` and rendering a checkout button that cannot work.

  Why here rather than in lib/auth/env.ts, which the design calls the one place
  environment variables are read: that file names the variables, and it already
  lists STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET among the names that must
  never reach the browser. What is added here is the *reading* of them plus the
  plan→Price mapping, which is billing policy rather than account plumbing.
  lib/http/cors.ts sets the same precedent for a lane owning its own read. If
  the owner would rather have one file, folding these three functions into
  lib/auth/env.ts is a mechanical move and nothing else has to change.

  ---------------------------------------------------------------------------
  Everything here returns undefined rather than throwing when unset

  Stripe keys do not exist in development and will not exist in production
  until somebody creates them. The rule this lane follows is the one
  lib/anthropic.ts already follows with `hasApiKey`: an absent key makes the
  feature honestly unavailable — the pricing page still renders and says
  checkout is not open yet — and never an error page. A payment system that
  500s when it is merely unconfigured teaches everyone to ignore its errors.
*/

const MODULE = "lib/billing/env.ts";

/**
 * The Stripe secret key. Holding this is holding the ability to move money, so
 * it never leaves the server and never appears in a log line.
 */
export function stripeSecretKey(): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env["STRIPE_SECRET_KEY"];
  return value && value.length > 0 ? value : undefined;
}

/**
 * The webhook signing secret — the `whsec_...` string Stripe shows once, when
 * the endpoint is created.
 *
 * Without it the webhook route refuses every delivery rather than trusting an
 * unverified one. That is not a degraded mode, it is the only safe mode: a
 * webhook that skips the signature check is an HTTP endpoint that grants
 * subscriptions to anyone who can POST to it, which is precisely ACCOUNTS.md
 * threat 3 with extra steps.
 */
export function stripeWebhookSecret(): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env["STRIPE_WEBHOOK_SECRET"];
  return value && value.length > 0 ? value : undefined;
}

/*
  Plan id -> the name of the variable holding that plan's Stripe Price id.

  The indirection is the point. A checkout request names a plan this app
  defined; the server looks up what that plan costs. The alternative — letting
  the request carry a Price id — hands the choice of what to charge to the
  caller, and while Stripe would only accept ids that exist in the account,
  "only the prices we ever created" includes every test price, every archived
  experiment and every one-cent price somebody made while debugging.
*/
const PRICE_VARS: Record<PlanId, string> = {
  "standard-monthly": "STRIPE_PRICE_STANDARD_MONTHLY",
  "standard-yearly": "STRIPE_PRICE_STANDARD_YEARLY",
  "plus-monthly": "STRIPE_PRICE_PLUS_MONTHLY",
  "plus-yearly": "STRIPE_PRICE_PLUS_YEARLY",
  "pro-monthly": "STRIPE_PRICE_PRO_MONTHLY",
  "pro-yearly": "STRIPE_PRICE_PRO_YEARLY",
};

/** The Stripe Price id for a plan, or undefined if it has not been configured. */
export function stripePriceId(plan: PlanId): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env[PRICE_VARS[plan]];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Whether web checkout can run at all: a secret key, and at least one plan with
 * a Price id behind it.
 *
 * Both halves matter. A key with no prices configured produces a button that
 * reaches Stripe and is refused there, which is a worse experience than a page
 * that says plainly that checkout is not open yet.
 */
export function stripeConfigured(): boolean {
  if (!stripeSecretKey()) return false;
  return PLAN_IDS.some((plan) => stripePriceId(plan) !== undefined);
}

/** One-time wallet checkout uses inline catalogue prices, so it needs no Price ids. */
export function stripeWalletConfigured(): boolean {
  return stripeSecretKey() !== undefined;
}

/** The plans that can actually be bought right now, in catalogue order. */
export function purchasablePlans(): PlanId[] {
  if (!stripeSecretKey()) return [];
  return PLAN_IDS.filter((plan) => stripePriceId(plan) !== undefined);
}

/**
 * Which tier a Stripe Price id buys, read backwards through the configuration.
 *
 * The webhook's first choice is the tier this app stamped into the
 * subscription's metadata at checkout. This is the second: it answers for a
 * subscription created in the Stripe dashboard by hand, where there is no
 * metadata to read but the Price is still one we configured. Returns null for
 * a Price this deployment knows nothing about, and the caller then declines to
 * grant anything rather than guessing at the most valuable tier.
 */
export function tierForStripePrice(priceId: string): Tier | null {
  for (const plan of PLAN_IDS) {
    if (stripePriceId(plan) === priceId) return PLANS[plan].tier;
  }
  return null;
}
