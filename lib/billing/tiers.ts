/*
  What the tiers are: what each one costs, what it unlocks, and how much AI it
  may spend in a day.

  This file is the single definition of all three. Before it existed the numbers
  were in two places — the allowances in lib/usage/limits.ts and the marketing
  copy nowhere at all — and a paywall whose page promises one figure while the
  meter enforces another is a paywall that generates support mail. So the page,
  the meter and the gate all read from here.

  ---------------------------------------------------------------------------
  Why this module is deliberately pure

  It is imported by a client component (the pricing page) as well as by server
  code, so it must contain no secret, no environment read and no import that
  reaches one. In particular it must not import lib/billing/entitlements.ts:
  that pulls in lib/auth/supabase.ts, which pulls in lib/auth/env.ts, whose
  source contains the literal string "SUPABASE_SERVICE_ROLE_KEY". Nothing
  secret would leak — the value is never inlined — but the *name* would land in
  a file under .next/static and tests/no-secret-leak.test.mjs would fail, which
  is exactly the alarm it is there to raise. The dependency therefore runs the
  other way: entitlements.ts imports `Tier` from here.

  ---------------------------------------------------------------------------
  Prices, and what is true about them

  The amounts below are what the pricing page shows. Stripe holds the amounts
  that are actually charged, in its own Price objects, and Stripe is the
  authority: if the two disagree the learner is charged what Stripe says. That
  is a real hazard of keeping display copy in the repository, and the honest
  mitigation is to state it — DEPLOY.md tells whoever creates the Prices that
  they must match these figures, and a mismatch is a bug in the deployment
  rather than something this file can detect.

  No crossed-out "was" prices, no countdowns, no "most popular" badge on the
  plan we would rather sell. The yearly figure is shown as a total and as the
  monthly equivalent it works out to, which is arithmetic the reader can check,
  not a discount claim they have to trust.
*/

/**
 * The tiers a learner can be in.
 *
 * `admin` is not a plan and is not for sale — it is the owner's account, set by
 * a database column, and it appears here only so that a tier→feature question
 * has an answer for every value `resolve_entitlement` can return.
 */
export type Tier = "free" | "pro" | "admin";

/** The tiers the pricing page shows, in the order it shows them. */
export const SELLABLE_TIERS = ["free", "pro"] as const satisfies readonly Tier[];

/*
  The things a tier can unlock.

  Note how few of these there are, and why: almost nothing in BandUp is behind
  a tier at all. The placement test, the study plan, the bundled reading and
  listening tests, the grammar drills and the vocabulary drills are static
  content shipped in the app bundle, cost nothing per use, and are free forever
  for everyone signed in or not. What is listed here is only what costs money
  each time somebody presses the button.
*/
export const FEATURES = [
  /** Word lookup — /api/define. */
  "define",
  /** Generating a fresh reading or listening test — /api/generate. */
  "generate",
  /** Examiner feedback on an essay — /api/grade/writing. */
  "grade-writing",
  /** Examiner feedback on a mock speaking test — /api/grade/speaking. */
  "grade-speaking",
  /*
    The conversational tutor. This is the one feature that is genuinely a paid
    feature rather than a bigger allowance of a free one: a chat turn costs a
    model call every few seconds rather than once per essay, so a free tier that
    included it would be an uncapped bill wearing a friendly face.

    The chat route itself is being built separately. It is named here so that
    the gate exists before the feature does, rather than being retrofitted to a
    route that shipped open.
  */
  "tutor-chat",
  /** Carrying progress between devices. Free with any account, and stays free. */
  "progress-sync",
] as const;

export type Feature = (typeof FEATURES)[number];

export interface TierDefinition {
  id: Tier;
  /** What the learner sees this called. */
  name: string;
  /** One line, in the second person, saying who the tier is for. */
  blurb: string;
  /**
   * AI calls per rolling 24 hours across every metered route. `null` is
   * unlimited, which only the owner's own account ever is.
   */
  dailyAiCalls: number | null;
  /** Everything this tier may use. Absence from this list is the whole gate. */
  features: readonly Feature[];
  /** Bullets for the pricing page. Written to be read, not to be skimmed past. */
  includes: readonly string[];
}

const EVERYTHING_METERED: readonly Feature[] = [
  "define",
  "generate",
  "grade-writing",
  "grade-speaking",
  "progress-sync",
];

export const TIERS: Record<Tier, TierDefinition> = {
  free: {
    id: "free",
    name: "Free",
    blurb: "A real account, with a daily allowance of AI feedback.",
    dailyAiCalls: 20,
    features: EVERYTHING_METERED,
    /*
      Short lines, deliberately. A bullet that wraps to three lines is a
      paragraph wearing a dot, and five of those turned this card into most of
      a screen. Each of these says one thing and stops.
    */
    includes: [
      "Placement test, study plan and all drills — unlimited",
      "2 listening and 2 reading papers a week",
      "1 writing and 1 speaking session a week, 1 question in the speaking",
      "20 AI requests a day, in any mix",
      "Progress synced across your devices",
    ],
  },
  pro: {
    id: "pro",
    name: "Standard",
    blurb: "For the weeks before the exam, when one paper a week is not enough.",
    dailyAiCalls: 500,
    features: [...EVERYTHING_METERED, "tutor-chat"],
    /*
      Both halves, in the order they matter.

      Standard does not ration sessions — that is what it unlocks — and it
      does cap the model, at 500 a day rather than 20. An early draft said
      only "no weekly limits", which reads as no limit at all and is the
      sentence a subscriber would remember; a later one said "many more
      sessions", which undersold the thing that is actually unlimited. Saying
      both, plainly, costs one line and is the only version that is true.
    */
    includes: [
      "No weekly limit on practice sessions, in any skill",
      "The full mock exam — all four skills, timed",
      "The AI tutor chat, whenever you are stuck",
      "500 AI requests a day instead of 20",
      "Cancel any time, one button",
    ],
  },
  /*
    Not sold, not shown, and listed only so that every tier the database can
    return has a definition here. An admin flag that still enforced a limit
    would be a flag that did nothing.
  */
  admin: {
    id: "admin",
    /*
      Named rather than titled. There is exactly one of these accounts and it
      belongs to a person, so "Adam" reads as what it is; "Owner" read like a
      tier somebody might be sold.
    */
    name: "Adam",
    blurb: "Your own account. No limits on anything.",
    dailyAiCalls: null,
    features: [...EVERYTHING_METERED, "tutor-chat"],
    includes: [],
  },
};

/**
 * May a tier use a feature?
 *
 * The whole of the gate, and deliberately a pure function of two values so it
 * can be unit-tested exhaustively and read in one sitting. What makes it a
 * *server-side* gate is where the tier comes from — the database, through
 * `resolveEntitlement` — never from anything the caller said about itself. See
 * lib/billing/gate.ts, and ACCOUNTS.md threats 1 and 3.
 *
 * An unrecognised tier is refused rather than allowed. A typo in this file
 * should cost a user a feature, never hand out one they have not paid for.
 */
export function tierAllows(tier: string, feature: Feature): boolean {
  /*
    `hasOwnProperty` rather than a truthiness test on the lookup, and the
    difference is not pedantry. `TIERS["toString"]` finds Object.prototype's
    method, which is truthy, so a plain `if (!definition) return false` sails
    past it and then throws on `.features`. The tier is a string that reached
    here from the database, and the failure it produced was a 500 rather than a
    refusal — which is a worse answer to an unrecognised tier than "no".
  */
  if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) return false;
  const definition = TIERS[tier as Tier];
  return definition.features.includes(feature);
}

/** The daily AI allowance for a tier, `null` meaning unlimited. */
export function dailyAiCalls(tier: Tier): number | null {
  return TIERS[tier].dailyAiCalls;
}

/*
  ---------------------------------------------------------------------------
  Plans — a tier plus a billing interval, which is what a learner actually buys
  ---------------------------------------------------------------------------

  A plan id is a name this app chose, not a Stripe id. The mapping from plan id
  to Stripe Price id lives server-side in lib/billing/env.ts and is never sent
  to the browser, so a checkout request names a plan and the server decides
  what that costs. Letting the client name a Price id instead would mean the
  price charged is chosen by the caller, which is a category of bug worth
  designing out rather than validating against.
*/

export type BillingInterval = "month" | "year";

export const PLAN_IDS = ["pro-monthly", "pro-yearly"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  id: PlanId;
  tier: Exclude<Tier, "free" | "admin">;
  interval: BillingInterval;
  /** Minor units, as Stripe stores them: 650 is $6.50. */
  amountMinor: number;
  /** ISO 4217, lower case, as Stripe writes it. */
  currency: string;
}

export const PLANS: Record<PlanId, Plan> = {
  "pro-monthly": {
    id: "pro-monthly",
    tier: "pro",
    interval: "month",
    /*
      $6.50, which is the owner's "about $1.50 a week" turned into a billing
      interval that works. Weekly billing is possible and a bad idea: a card is
      authorised every seven days, a subscriber collects 52 receipts a year,
      and every extra renewal attempt is another chance for one to fail.
      $1.50 x 52 / 12 is $6.50, so what a learner pays across a year is exactly
      the number the owner named.
    */
    amountMinor: 650,
    currency: "usd",
  },
  "pro-yearly": {
    id: "pro-yearly",
    tier: "pro",
    interval: "year",
    // Ten months' money for twelve months' access. Shown as a total and as the
    // monthly figure it divides into, so the saving is something the reader
    // works out rather than something we assert.
    amountMinor: 6500,
    currency: "usd",
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

/** Every plan that buys a given tier. */
export function plansForTier(tier: Tier): Plan[] {
  return PLAN_IDS.map((id) => PLANS[id]).filter((plan) => plan.tier === tier);
}

/**
 * A price as a person reads it: "$9" rather than "$9.00", because a trailing
 * ".00" on a round number reads as a form field rather than a price, and
 * "$7.99" keeps its pennies because dropping them would be a lie.
 */
export function formatPrice(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

/**
 * What a yearly plan works out to per month, rounded to the cent.
 *
 * Rounding down would overstate the saving and rounding up would understate
 * it; `Math.round` is the one that is neither. The page prints this next to the
 * total it was derived from, so the arithmetic is checkable.
 */
export function perMonthEquivalent(plan: Plan): number {
  return plan.interval === "year" ? Math.round(plan.amountMinor / 12) : plan.amountMinor;
}
