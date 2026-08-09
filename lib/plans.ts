/*
  The three plans, and what each one buys.

  Allowances are per billing period, not per calendar month, so a quarterly
  subscriber gets three months' worth at once and spends it however the exam
  timetable demands — cramming in the last fortnight is the normal shape of
  IELTS preparation, not an abuse of the plan.

  The numbers are set from what each call actually costs to run rather than
  from what looks generous: marking an essay and grading a speaking interview
  are the expensive operations, generating a whole test more so, and word
  lookup is cheap individually but adds up because learners do it constantly.
*/

export type PlanId = "standard" | "plus" | "pro";

/** The three things a plan meters, kept separate so the interface can say which ran out. */
export type Meter = "marking" | "generation" | "lookup";

export interface Plan {
  id: PlanId;
  name: string;
  /** Ordering for upgrade prompts — a learner can only move up. */
  rank: number;
  allowance: Record<Meter, number>;
}

export const PLANS: Record<PlanId, Plan> = {
  standard: {
    id: "standard",
    name: "Standard",
    rank: 1,
    allowance: { marking: 10, generation: 3, lookup: 100 },
  },
  plus: {
    id: "plus",
    name: "Plus",
    rank: 2,
    allowance: { marking: 20, generation: 6, lookup: 200 },
  },
  pro: {
    id: "pro",
    name: "Pro",
    rank: 3,
    allowance: { marking: 40, generation: 12, lookup: 400 },
  },
};

export const PLAN_IDS: PlanId[] = ["standard", "plus", "pro"];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

export type Interval = "monthly" | "quarterly";

export function isInterval(value: unknown): value is Interval {
  return value === "monthly" || value === "quarterly";
}

/*
  Which Stripe price sells which plan.

  The mapping lives in configuration rather than in code because prices are
  created in the Stripe dashboard and their ids are account-specific; this is
  also what lets a price change without a deploy. Read in both directions: out
  to start a checkout, back to work out what a subscriber actually bought.
*/
const PRICE_ENV: Record<PlanId, Record<Interval, string>> = {
  standard: {
    monthly: "STRIPE_PRICE_STANDARD_MONTHLY",
    quarterly: "STRIPE_PRICE_STANDARD_QUARTERLY",
  },
  plus: {
    monthly: "STRIPE_PRICE_PLUS_MONTHLY",
    quarterly: "STRIPE_PRICE_PLUS_QUARTERLY",
  },
  pro: {
    monthly: "STRIPE_PRICE_PRO_MONTHLY",
    quarterly: "STRIPE_PRICE_PRO_QUARTERLY",
  },
};

export function priceIdFor(plan: PlanId, interval: Interval): string | null {
  return process.env[PRICE_ENV[plan][interval]] || null;
}

/** The plan a Stripe price id belongs to, or null if it sells nothing we know about. */
export function planForPriceId(priceId: string): PlanId | null {
  for (const plan of PLAN_IDS) {
    for (const interval of ["monthly", "quarterly"] as Interval[]) {
      if (priceIdFor(plan, interval) === priceId) return plan;
    }
  }
  return null;
}

/** Every plan that has at least one price configured — what /pricing may offer. */
export function sellablePlans(): Plan[] {
  return PLAN_IDS.map((id) => PLANS[id]).filter(
    (plan) => priceIdFor(plan.id, "monthly") || priceIdFor(plan.id, "quarterly"),
  );
}
