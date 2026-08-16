import {
  COSTED_ROUTES,
  worstCaseMonthlyCost,
  type CostedRoute,
} from "@/lib/ai/models";
import { hkdPerUnit, minorPerUnit, toMajor, walletTakes } from "./currency";

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
    Enough AI for a normal month of preparation: an essay marked most weeks, a
    speaking test a fortnight, a couple of questions a day, and a fresh paper.

    Halved from the original allowance, and that was the price cut. The owner
    wanted plans cheap enough to bring people in, and the arithmetic said the
    only lever that could do it was this one: at the old caps, giving up every
    cent of profit still could not price Plus below $2.71, because the profit
    was never what made the price — the AI was. Halving the allowance took Plus
    to $1.69 *and* left real money on it. Ten marked essays a month is still an
    essay every three days.
  */
  plus: { define: 100, chat: 50, "grade/writing": 10, "grade/speaking": 6, generate: 2 },
  /*
    Three times Plus on the routes that matter, for the weeks before the exam.
    It is the most expensive tier to serve and therefore the one with the
    thinnest margin, which is why its caps are the ones to check first when
    anything about the cost model changes.
  */
  pro: { define: 175, chat: 100, "grade/writing": 30, "grade/speaking": 20, generate: 5 },
  /*
    The owner's account. An admin flag that still enforced a limit would be a
    flag that did nothing.
  */
  admin: { define: null, chat: null, "grade/writing": null, "grade/speaking": null, generate: null },
};

/**
 * What a plan gives you back each week, per rolling 7 days.
 *
 * The monthly cap is the ceiling on the money; this is the rhythm the plan is
 * actually used on. A subscriber gets a week's worth of marking, it refills
 * seven days later, and they can plan a week of study around it — which is what
 * the owner asked for, and is a better shape for exam preparation than a lump
 * that arrives once a month and is gone by the tenth.
 *
 * Every figure here is a seventh of a thirtieth of the month, rounded up. That
 * rounding matters and is the right direction: four and a bit weeks of it still
 * exceeds the monthly cap, so the *month* is what a heavy user runs into first.
 * The monthly cap therefore remains the only number the cost model needs, and
 * tests/ai-economics.test.mjs goes on proving the margin from it alone.
 *
 * It also still does the job the old 24-hour ceiling did: a month's requests
 * cannot arrive in one afternoon and collide with the upstream API's own rate
 * limits, taking the app down for everybody else while one account drains its
 * allowance.
 */
export const WEEKLY_AI_CAPS: Record<Tier, Record<CostedRoute, number | null>> = {
  free: { define: 0, chat: 0, "grade/writing": 0, "grade/speaking": 0, generate: 0 },
  standard: { define: 0, chat: 0, "grade/writing": 0, "grade/speaking": 0, generate: 0 },
  plus: { define: 24, chat: 12, "grade/writing": 3, "grade/speaking": 2, generate: 1 },
  pro: { define: 41, chat: 24, "grade/writing": 7, "grade/speaking": 5, generate: 2 },
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
      "10 essays and 6 speaking tests marked a month",
      "50 tutor questions and 100 word lookups a month",
      "2 fresh AI-written papers a month",
      "Cancel any time, one button",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    blurb: "For the weeks before the exam, when you are practising every day.",
    includes: [
      "Everything in Plus, two to three times over",
      "30 essays and 20 speaking tests marked a month",
      "100 tutor questions and 175 word lookups a month",
      "5 fresh AI-written papers a month",
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

/** The rolling-7-day ceiling for one route, `null` meaning unlimited. */
export function weeklyCap(tier: string, route: CostedRoute): number | null {
  if (!Object.prototype.hasOwnProperty.call(WEEKLY_AI_CAPS, tier)) return 0;
  return WEEKLY_AI_CAPS[tier as Tier][route];
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

/** Wallet methods sold as prepaid passes rather than renewable subscriptions. */
export const WALLET_PAYMENT_METHODS = ["alipay", "wechat_pay"] as const;
export type WalletPaymentMethod = (typeof WALLET_PAYMENT_METHODS)[number];

export function isWalletPaymentMethod(value: unknown): value is WalletPaymentMethod {
  return (
    typeof value === "string" &&
    (WALLET_PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

export interface Plan {
  id: PlanId;
  tier: PaidTier;
  interval: BillingInterval;
  /** Minor units of the base currency, as Stripe stores them: 490 is HK$4.90. */
  amountMinor: number;
  /** ISO 4217, lower case, as Stripe writes it. Always the base currency. */
  currency: string;
  /**
   * What this plan costs in each currency the app prices in, in that
   * currency's minor units — so `jpy` is whole yen, because Stripe counts it
   * that way (lib/billing/currency.ts).
   *
   * These become the Price's `currency_options` in Stripe, which is what lets
   * one Price id charge a Londoner in pounds and a Tokyo candidate in yen with
   * no second Price and no second environment variable. Checkout picks by the
   * customer's address; anything not named here is converted by Stripe from
   * the base amount.
   */
  prices: Record<string, number>;
}

/*
  The ladder: $0.49, $1.69, $3.29.

  These are cost-plus prices, and that is the owner's decision rather than an
  accident of rounding. Each one is the worst a subscriber on that tier can
  cost — every AI request taken at its ceiling, plus Stripe's cut — with a
  margin of at least HK$1 a month on top, then rounded up to a price that looks
  like a price. tests/ai-economics.test.mjs is what holds that floor.

  They were about twice this, and the halving came from the allowances rather
  than from the margin. That is worth recording because the intuition runs the
  other way: at the old caps, giving up every cent of profit still could not
  price Pro below $5.94, because $5.39 of its $6.99 was AI. What a plan costs
  to serve is what sets its price here, so the way to make a plan cheaper is to
  put less in it.

  The margin is deliberately thin and it is worth being clear-eyed about what
  that means: at full usage these plans cover the AI and the card fee and very
  little else. What makes them work is that nobody uses their whole allowance —
  a typical month costs a fraction of the ceiling, so the real margin is several
  times the floor. The floor is what guarantees there is never a loss; it is not
  what the business runs on.

  The yearly prices are ten months' money for twelve months' access, rounded to
  the nearest of the prices people expect to see.

  ---------------------------------------------------------------------------
  The renminbi, and why it is not simply the Hong Kong price converted

  CNY is the currency WeChat Pay and Alipay settle in, so a mainland candidate
  paying with either was until now quoted in a currency they do not hold. The
  figures below are chosen the same way every other local price was — a price
  that looks like a price where it is read (¥12, ¥120, ¥268), then checked back
  against the cost in tests/currency.test.mjs — rather than HK$ divided by 1.08.

  One thing about adding a currency here that is not obvious and costs money to
  learn: `assertPriceMatchesCatalogue` in lib/billing/stripe.ts refuses a
  checkout whenever this catalogue names a currency the Stripe Price does not
  carry. So Stripe has to be given the new amounts *before* this file ships, not
  after — `node scripts/stripe-setup.mjs` is what does it, and it now patches
  currency_options onto the existing Prices rather than minting new ids.
*/
export const PLANS: Record<PlanId, Plan> = {
  "standard-monthly": {
    id: "standard-monthly",
    tier: "standard",
    interval: "month",
    amountMinor: 490,
    currency: "hkd",
    prices: { hkd: 490, usd: 69, eur: 69, gbp: 49, aud: 99, cad: 99, sgd: 99, jpy: 100, inr: 5900, cny: 490 },
  },
  "standard-yearly": {
    id: "standard-yearly",
    tier: "standard",
    interval: "year",
    amountMinor: 3900,
    currency: "hkd",
    prices: { hkd: 3900, usd: 499, eur: 499, gbp: 399, aud: 799, cad: 699, sgd: 699, jpy: 790, inr: 44900, cny: 3900 },
  },
  "plus-monthly": {
    id: "plus-monthly",
    tier: "plus",
    interval: "month",
    amountMinor: 1290,
    currency: "hkd",
    prices: { hkd: 1290, usd: 169, eur: 149, gbp: 129, aud: 259, cad: 229, sgd: 219, jpy: 250, inr: 15900, cny: 1200 },
  },
  "plus-yearly": {
    id: "plus-yearly",
    tier: "plus",
    interval: "year",
    amountMinor: 12900,
    currency: "hkd",
    prices: { hkd: 12900, usd: 1699, eur: 1499, gbp: 1299, aud: 2599, cad: 2299, sgd: 2199, jpy: 2500, inr: 159900, cny: 12000 },
  },
  "pro-monthly": {
    id: "pro-monthly",
    tier: "pro",
    interval: "month",
    amountMinor: 2590,
    currency: "hkd",
    prices: { hkd: 2590, usd: 329, eur: 299, gbp: 249, aud: 529, cad: 459, sgd: 429, jpy: 520, inr: 31900, cny: 2500 },
  },
  "pro-yearly": {
    id: "pro-yearly",
    tier: "pro",
    interval: "year",
    amountMinor: 27900,
    currency: "hkd",
    prices: { hkd: 27900, usd: 3599, eur: 3199, gbp: 2699, aud: 5699, cad: 4999, sgd: 4699, jpy: 5600, inr: 349900, cny: 26800 },
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

  These were 2.9% + 30 cents, described here as "Stripe's standard rate". It is
  standard in the United States. This account is registered in Hong Kong, where
  Stripe's published rate is 3.4% + HK$2.35 on a domestic card and 3.9% +
  HK$2.35 on an international one — and for an app selling IELTS preparation,
  the international card is not the edge case, it is the typical customer.

  So the worst of the published rates is the one the margin is proved against.
  A profit guarantee computed at somebody else's fee is not a guarantee, and
  this one is load-bearing: the owner's instruction was that every plan must
  make money at full AI usage, with no deficits.

  Still no allowance for chargebacks, refunds, or the currency conversion that
  applies when USD prices settle into a HKD account. Those exist and make the
  real margin thinner, and the headroom tests/ai-economics.test.mjs insists on
  is what covers them.

  https://stripe.com/en-hk/pricing
*/
export const STRIPE_PERCENT_FEE = 0.039;

/**
 * HK$2.35 per successful charge, in Hong Kong cents.
 *
 * The prices are set in HKD now, so this is simply the fee as Stripe bills it
 * — no conversion, and none of the rounding a converted constant carried.
 * Selling in the currency the account settles in is also what removed Stripe's
 * ~2% conversion charge from every sale, which was worth more than it sounds:
 * it was taking about a fifth of the margin on Plus and pushing Pro below the
 * floor entirely.
 */
export const STRIPE_FIXED_FEE_MINOR = 235;

/**
 * The margin every plan must clear, per subscriber per month, in Hong Kong
 * dollars — the owner's own currency, and the number they set.
 *
 * Written in HKD rather than converted once and forgotten, so that revisiting
 * the decision means changing the number that was actually decided.
 */
export const MIN_MONTHLY_MARGIN_HKD = 1;

/**
 * HKD per USD. The Hong Kong dollar is pegged to a 7.75-7.85 band, so this is
 * a real constant rather than a rate that has to be fetched; 7.8 is the middle
 * of the band the Monetary Authority defends.
 */
export const HKD_PER_USD = 7.8;

/**
 * What actually lands, in Hong Kong dollars, after the processor takes its cut.
 *
 * `currency` names which of the plan's prices is being sold. The fee is the
 * same rate everywhere, but the *amount* is not: a price chosen for India and
 * a price chosen for Australia are different sums of money, and only one of
 * them is what a given subscriber pays. Converting back to HKD is what lets
 * the margin be compared against a cost that is incurred in one currency
 * wherever the subscriber happens to live.
 */
export function netRevenue(plan: Plan, currency: string = plan.currency): number {
  const amountMinor = amountIn(plan, currency);
  const feeMinor = amountMinor * STRIPE_PERCENT_FEE + fixedFeeMinor(currency);
  return toMajor(amountMinor - feeMinor, currency) * hkdPerUnit(currency);
}

/**
 * Stripe's flat fee, in the minor units of whatever is being charged.
 *
 * It is one fee — about US$0.30 — expressed locally, so it has to be converted
 * like any other amount rather than assumed to be 235 everywhere. A ¥ price
 * charged a fee of "235" would be charged ¥235 instead of the ¥46 it is.
 */
export function fixedFeeMinor(currency: string): number {
  const hkd = 2.35;
  return Math.round((hkd / hkdPerUnit(currency)) * minorPerUnit(currency));
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
  /*
    Through toMajor rather than a bare /100, because not every currency has
    cents. Stripe stores ¥100 as 100, so dividing by a hundred would print ¥1
    for a plan that charges a hundred — a hundredfold understatement on the
    page and the right amount on the card, which is the one direction of error
    that ends in a chargeback.
  */
  const major = toMajor(amountMinor, currency);
  const decimals = 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(major);
}

/**
 * What a plan costs in a given currency, in that currency's minor units.
 *
 * Falls back to the base amount for a currency the catalogue does not price.
 * That is the honest answer for the page — Stripe converts from the base at
 * checkout for exactly those currencies — and callers that care pair it with
 * `pricesIn` to know whether the figure is a chosen price or a base one.
 */
export function amountIn(plan: Plan, currency: string): number {
  return plan.prices[currency.toLowerCase()] ?? plan.amountMinor;
}

/** Whether this currency has a price somebody chose, rather than a fallback. */
export function pricesIn(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    PLANS["plus-monthly"].prices,
    currency.toLowerCase(),
  );
}

/** Every currency the catalogue prices in, base first. */
export const PRICED_CURRENCIES: string[] = Object.keys(PLANS["plus-monthly"].prices);

/**
 * The currency a wallet payment can actually be presented in.
 *
 * A subscription reads its amount off a Stripe Price, so Stripe picks the
 * currency from the buyer's address and this app never has to. A wallet
 * payment does not: the line item is built here, so the currency is chosen
 * here — and choosing one the wallets refuse means a Checkout Session that
 * fails after the buyer has pressed the button.
 *
 * Two things must hold: the catalogue has to carry a price somebody chose in
 * it, and both Alipay and WeChat Pay have to accept it. Either failing falls
 * back to the base currency, which satisfies both by definition. The rupee is
 * the case that actually arises — neither wallet takes INR.
 *
 * The page calls this too, so what it quotes for the wallet is what the wallet
 * will charge, fallback included.
 */
export function walletCurrency(plan: Plan, requested: string): string {
  const wanted = requested.toLowerCase();
  if (!pricesIn(wanted) || !walletTakes(wanted)) return plan.currency;
  return wanted;
}

/**
 * What a yearly plan works out to per month, rounded to the cent.
 *
 * Rounding down would overstate the saving and rounding up would understate
 * it; `Math.round` is the one that is neither. The page prints this next to the
 * total it was derived from, so the arithmetic is checkable.
 */
export function perMonthEquivalent(plan: Plan, currency?: string): number {
  const amount = currency ? amountIn(plan, currency) : plan.amountMinor;
  return plan.interval === "year" ? Math.round(amount / 12) : amount;
}
