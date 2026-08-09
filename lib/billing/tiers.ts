import {
  COSTED_ROUTES,
  worstCaseMonthlyCost,
  type CostedRoute,
} from "@/lib/ai/models";

/*
  What the tiers are: what each one costs, what it unlocks, and exactly how much
  AI it may spend before it is stopped.

  This file is the single definition of all three. Before it existed the numbers
  were in two places — the allowances in lib/usage/limits.ts and the marketing
  copy nowhere at all — and a paywall whose page promises one figure while the
  meter enforces another is a paywall that generates support mail. So the page,
  the meter and the gate all read from here.

  ---------------------------------------------------------------------------
  The rule this file exists to keep

  A subscriber pays a fixed amount once a month and can press the AI buttons as
  often as they like. Those two facts together are how a subscription business
  loses money, and the only defence is a cap that is *lower than what they
  paid*. So every allowance below was chosen by working backwards from the
  price:

      worst-case monthly AI cost  <  price  -  payment fees

  Worst case means every call at the ceiling: the largest input the route
  accepts and the full `max_tokens` of output, at list price, on every call up
  to the cap. Real use costs a fraction of it.

  tests/ai-economics.test.mjs recomputes that inequality for every tier on
  every build and fails if any tier is even close. Raising a cap here without
  raising the price fails the build, which is the point — the guarantee is not
  something anybody has to remember.

  ---------------------------------------------------------------------------
  Why the caps are per route and not one shared pool

  They used to be one pool: twenty requests a day, spend them how you like.
  That reads well and cannot be costed, because the five routes differ in price
  by a factor of thirty. Twenty lookups cost six cents; twenty generated tests
  cost two dollars. A single number cannot bound both, so it bounds neither,
  and the only way to make it safe would be to set it low enough for the most
  expensive route — which would mean rationing word lookups as though each one
  were a whole practice test.

  Per route, each allowance can be as generous as that route is cheap. It also
  reads better on the billing page: five short bars saying what you have used
  each thing for, instead of one bar that says nothing about what to stop
  doing.

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
export const TIER_NAMES = ["free", "standard", "plus", "pro", "admin"] as const;

export type Tier = (typeof TIER_NAMES)[number];

/** The tiers the pricing page shows, in the order it shows them. */
export const SELLABLE_TIERS = ["free", "standard", "plus", "pro"] as const satisfies readonly Tier[];

/** The tiers somebody actually pays for. */
export const PAID_TIERS = ["standard", "plus", "pro"] as const satisfies readonly Tier[];
export type PaidTier = (typeof PAID_TIERS)[number];

export function isPaidTier(tier: Tier): tier is PaidTier {
  return (PAID_TIERS as readonly Tier[]).includes(tier);
}

/*
  The things a tier can unlock.

  Note how few of these there are, and why: almost nothing in BandUp is behind
  a tier at all. The placement test, the study plan, the bundled reading and
  listening tests, the grammar drills and the vocabulary drills are static
  content shipped in the app bundle, cost nothing per use, and are free forever
  for everyone signed in or not. What is listed here is only what costs money
  each time somebody presses the button — plus one thing that costs nothing and
  is named so it can be promised.
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
  /** The conversational tutor — /api/chat. */
  "tutor-chat",
  /** Carrying progress between devices. Free with any account, and stays free. */
  "progress-sync",
] as const;

export type Feature = (typeof FEATURES)[number];

/**
 * Which metered route a feature spends from.
 *
 * `progress-sync` is absent because it spends nothing: it is a database write,
 * and a tier is allowed it simply for being an account. Everything else maps to
 * exactly one route, and that mapping is what makes the caps below the single
 * definition of who may use what — there is no second list of features per tier
 * that could disagree with the allowances.
 */
export const FEATURE_ROUTES: Record<Exclude<Feature, "progress-sync">, CostedRoute> = {
  define: "define",
  generate: "generate",
  "grade-writing": "grade/writing",
  "grade-speaking": "grade/speaking",
  "tutor-chat": "chat",
};

/**
 * How many calls a tier gets per route, per rolling 30 days.
 *
 * Zero means the route is refused outright — that is how "no AI at all" is
 * expressed, and it is the same number the gate reads, so a tier can never be
 * shown a button that its allowance would refuse. `null` is unlimited and only
 * the owner's own account is ever null.
 *
 * The window rolls: there is no reset day, no midnight, nothing that empties at
 * once. Each call expires thirty days after it was made. That is harder to
 * explain than "resets on the 1st" and it is fairer — a subscriber who joins on
 * the 28th does not get three days of allowance for a month of money.
 */
export const MONTHLY_AI_CAPS: Record<Tier, Record<CostedRoute, number | null>> = {
  /*
    Nothing. A free account is a real account with progress sync, the placement
    test, the study plan, every drill and two reading and two listening papers a
    week — all of which are marked from an answer key that ships in the bundle
    and cost nothing to serve. What it is not is a free sample of the API.

    Free AI was tried and it does not survive contact with arithmetic: twenty
    requests a day is up to six hundred a month, from an account that costs
    nothing to create, of which somebody can create as many as they like.
  */
  free: { define: 0, chat: 0, "grade/writing": 0, "grade/speaking": 0, generate: 0 },
  /*
    Also nothing, and that is what Standard is: the whole library, unlocked, with
    no AI. It exists because most of what BandUp does needs no model — a reading
    paper is marked against its answer key, and the mark is exactly as accurate
    as the expensive kind. Somebody who wants unlimited practice and does not
    want an essay marked should not be made to pay for marking.
  */
  standard: { define: 0, chat: 0, "grade/writing": 0, "grade/speaking": 0, generate: 0 },
  /*
    Enough AI for a normal month of preparation: an essay marked every weekday
    or two, a speaking test a fortnight, a few questions a day, and a couple of
    fresh papers.
  */
  plus: { define: 200, chat: 100, "grade/writing": 20, "grade/speaking": 12, generate: 4 },
  /*
    Two to three times Plus on every route, for the weeks before the exam. It
    is the most expensive tier to serve and therefore the one with the thinnest
    margin, which is why its caps are the ones to check first when anything
    about the cost model changes.
  */
  pro: { define: 350, chat: 200, "grade/writing": 60, "grade/speaking": 40, generate: 10 },
  /*
    The owner's account. An admin flag that still enforced a limit would be a
    flag that did nothing.
  */
  admin: { define: null, chat: null, "grade/writing": null, "grade/speaking": null, generate: null },
};

/**
 * A ceiling on how fast a monthly allowance can be spent, per rolling 24 hours.
 *
 * This is not a cost control — the monthly cap already bounds the money, and
 * this one cannot make the bill smaller. It bounds the *rate*, so that a
 * month's worth of requests cannot arrive in an afternoon and collide with the
 * upstream API's own rate limits, taking the app down for everybody else while
 * one account drains its allowance.
 *
 * Set at roughly a fifth of the month on the cheap routes and a sixth on the
 * expensive ones, so nobody meets it during a normal day's work.
 */
export const DAILY_AI_CAPS: Record<Tier, Record<CostedRoute, number | null>> = {
  free: { define: 0, chat: 0, "grade/writing": 0, "grade/speaking": 0, generate: 0 },
  standard: { define: 0, chat: 0, "grade/writing": 0, "grade/speaking": 0, generate: 0 },
  plus: { define: 40, chat: 25, "grade/writing": 5, "grade/speaking": 4, generate: 2 },
  pro: { define: 70, chat: 40, "grade/writing": 12, "grade/speaking": 8, generate: 3 },
  admin: { define: null, chat: null, "grade/writing": null, "grade/speaking": null, generate: null },
};

export interface TierDefinition {
  id: Tier;
  /** What the learner sees this called. */
  name: string;
  /** One line, in the second person, saying who the tier is for. */
  blurb: string;
  /** Bullets for the pricing page. Written to be read, not to be skimmed past. */
  includes: readonly string[];
}

export const TIERS: Record<Tier, TierDefinition> = {
  free: {
    id: "free",
    name: "Free",
    blurb: "A real account, with the placement test, your plan and every drill.",
    /*
      Short lines, deliberately. A bullet that wraps to three lines is a
      paragraph wearing a dot, and five of those turned this card into most of
      a screen. Each of these says one thing and stops.
    */
    includes: [
      "Placement test, study plan and all drills — unlimited",
      "2 listening and 2 reading papers a week",
      "Progress synced across your devices",
      "No AI marking or tutor — those start on Plus",
    ],
  },
  standard: {
    id: "standard",
    name: "Standard",
    blurb: "The whole library, unlocked. Every paper, as often as you like.",
    includes: [
      "Every reading and listening paper, no weekly limit",
      "Writing and speaking practice with the exam timer",
      "The full mock exam — all four skills, timed",
      "Marked from the answer key, not by AI",
      "Cancel any time, one button",
    ],
  },
  plus: {
    id: "plus",
    name: "Plus",
    blurb: "Everything in Standard, plus an examiner for your writing and speaking.",
    includes: [
      "Everything in Standard",
      "20 essays and 12 speaking tests marked a month",
      "100 tutor questions and 200 word lookups a month",
      "4 fresh AI-written papers a month",
      "Cancel any time, one button",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    blurb: "For the weeks before the exam, when you are practising every day.",
    includes: [
      "Everything in Plus, two to three times over",
      "60 essays and 40 speaking tests marked a month",
      "200 tutor questions and 350 word lookups a month",
      "10 fresh AI-written papers a month",
      "Cancel any time, one button",
    ],
  },
  /*
    Not sold, not shown, and listed only so that every tier the database can
    return has a definition here.
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
    includes: [],
  },
};

/**
 * The monthly allowance for one route, `null` meaning unlimited.
 *
 * An unrecognised tier gets zero rather than unlimited. A typo should cost
 * somebody a feature, never hand out one they have not paid for.
 */
export function monthlyCap(tier: string, route: CostedRoute): number | null {
  if (!Object.prototype.hasOwnProperty.call(MONTHLY_AI_CAPS, tier)) return 0;
  return MONTHLY_AI_CAPS[tier as Tier][route];
}

/** The 24-hour ceiling for one route, `null` meaning unlimited. */
export function dailyCap(tier: string, route: CostedRoute): number | null {
  if (!Object.prototype.hasOwnProperty.call(DAILY_AI_CAPS, tier)) return 0;
  return DAILY_AI_CAPS[tier as Tier][route];
}

/**
 * May a tier use a feature?
 *
 * The whole of the gate, and deliberately a pure function of two values so it
 * can be unit-tested exhaustively and read in one sitting. What makes it a
 * *server-side* gate is where the tier comes from — the database, through
 * `resolveEntitlement` — never from anything the caller said about itself. See
 * lib/billing/gate.ts, and ACCOUNTS.md threats 1 and 3.
 *
 * There is no separate list of which features a tier has. The answer is read
 * off the allowance: an allowance of zero *is* the refusal, so the gate and
 * the meter can never disagree about whether somebody may press a button.
 */
export function tierAllows(tier: string, feature: Feature): boolean {
  if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) return false;
  // Costs nothing to serve, so every account has it.
  if (feature === "progress-sync") return true;
  const cap = monthlyCap(tier, FEATURE_ROUTES[feature]);
  return cap === null || cap > 0;
}

/** Whether a tier may use any AI at all — what the pricing page reads. */
export function tierHasAi(tier: Tier): boolean {
  return COSTED_ROUTES.some((route) => {
    const cap = monthlyCap(tier, route);
    return cap === null || cap > 0;
  });
}

/**
 * The worst this tier's AI can cost in a month, in US dollars.
 *
 * Unlimited counts as zero here rather than as infinity, because the only
 * unlimited tier is the owner's own account: it is not sold, so there is no
 * revenue for it to lose against, and including it would make the number
 * meaningless rather than alarming.
 */
export function worstCaseTierCost(tier: Tier): number {
  const caps = MONTHLY_AI_CAPS[tier];
  const finite: Partial<Record<CostedRoute, number>> = {};
  for (const route of COSTED_ROUTES) {
    const cap = caps[route];
    if (cap !== null) finite[route] = cap;
  }
  return worstCaseMonthlyCost(finite);
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

export const PLAN_IDS = [
  "standard-monthly",
  "standard-yearly",
  "plus-monthly",
  "plus-yearly",
  "pro-monthly",
  "pro-yearly",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  id: PlanId;
  tier: PaidTier;
  interval: BillingInterval;
  /** Minor units, as Stripe stores them: 299 is $2.99. */
  amountMinor: number;
  /** ISO 4217, lower case, as Stripe writes it. */
  currency: string;
}

/*
  The ladder: $2.99, $5.99, $9.99.

  Each step is roughly double the last, which is what makes the middle one
  read as the sensible choice rather than as a compromise, and each step buys
  something a learner can name — the library, then an examiner, then an
  examiner they can use every day.

  The yearly prices are ten months' money for twelve months' access, rounded to
  the nearest of the prices people expect to see: $29, $59, $99.
*/
export const PLANS: Record<PlanId, Plan> = {
  "standard-monthly": {
    id: "standard-monthly",
    tier: "standard",
    interval: "month",
    amountMinor: 299,
    currency: "usd",
  },
  "standard-yearly": {
    id: "standard-yearly",
    tier: "standard",
    interval: "year",
    amountMinor: 2900,
    currency: "usd",
  },
  "plus-monthly": {
    id: "plus-monthly",
    tier: "plus",
    interval: "month",
    amountMinor: 599,
    currency: "usd",
  },
  "plus-yearly": {
    id: "plus-yearly",
    tier: "plus",
    interval: "year",
    amountMinor: 5900,
    currency: "usd",
  },
  "pro-monthly": {
    id: "pro-monthly",
    tier: "pro",
    interval: "month",
    amountMinor: 999,
    currency: "usd",
  },
  "pro-yearly": {
    id: "pro-yearly",
    tier: "pro",
    interval: "year",
    amountMinor: 9900,
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

/*
  What the card processor keeps.

  Stripe's standard rate is 2.9% plus 30 cents on a successful card charge. It
  is written here rather than in the test because it is part of what a plan
  earns, and the margin check is meaningless without it — on a $2.99 charge the
  fixed 30 cents alone is a tenth of the price.

  Deliberately no allowance for the higher international-card rate, chargebacks,
  refunds or currency conversion. Those exist and they make the real margin
  thinner than this, so the headroom the economics test insists on is what
  covers them.
*/
export const STRIPE_PERCENT_FEE = 0.029;
export const STRIPE_FIXED_FEE_MINOR = 30;

/** What actually lands, in US dollars, after the processor takes its cut. */
export function netRevenue(plan: Plan): number {
  const fee = plan.amountMinor * STRIPE_PERCENT_FEE + STRIPE_FIXED_FEE_MINOR;
  return (plan.amountMinor - fee) / 100;
}

/** How many months of allowance one payment has to cover. */
export function monthsCovered(plan: Plan): number {
  return plan.interval === "year" ? 12 : 1;
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
