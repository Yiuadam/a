/*
  The test that keeps the business solvent.

  Every AI feature in BandUp spends real money each time somebody presses the
  button, and a subscription collects the same money whether it is pressed once
  or a thousand times. There is therefore exactly one arithmetic fact that
  decides whether this app can be sold at all:

      what a subscriber can force us to spend  <  what a subscriber pays

  This file checks it, for every plan, on every build. It is not a unit test of
  a function; it is the guarantee written down in a form that fails the build
  when somebody raises an allowance, switches a model, lifts a `max_tokens` or
  removes an input cap without doing the arithmetic again. All five of those
  have exactly the same effect on the bill and none of them looks like a pricing
  change while you are making it.

  ---------------------------------------------------------------------------
  Everything here is the worst case

  Not the average, not the expected, not the p99. Every call at the ceiling:
  the largest input the route will accept, the full `max_tokens` of output, at
  published list price, repeated until the allowance is gone, by every
  subscriber, every month. Real use costs a small fraction of it. A guarantee
  that only holds for typical users is not a guarantee — the users who cost
  money are by definition not typical.

  ---------------------------------------------------------------------------
  The threshold, and why it is one number in Hong Kong dollars

  The prices are cost-plus by the owner's decision: each plan is priced at what
  it can be made to cost, plus a margin of MIN_MONTHLY_MARGIN_HKD a month, then
  rounded up to something that looks like a price. So the check is that same
  rule, stated once and applied to every plan:

      price - worst-case AI - Stripe's cut  >=  HK$3 per subscriber-month

  An earlier version of this file also enforced a ratio — cost as a share of
  revenue. That was the right check for the prices it was written against and
  is the wrong one now: cost-plus pricing makes the ratio large by construction
  on the expensive tiers and zero on the cheap one, so it would fail plans that
  are correct and pass plans that are not. The absolute floor is the rule, so
  the absolute floor is what is tested.

  What that margin does *not* cover is worth saying plainly rather than
  implying: at full usage HK$3 a month per subscriber does not pay for Supabase,
  Cloudflare, the Apple developer programme, refunds or chargebacks. What makes
  the plans work is that nobody uses their whole allowance — a real month costs
  a fraction of the ceiling, so the realised margin is several times this. This
  floor guarantees there is never a loss. It is not the business case.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const models = await import(pathToFileURL(join(process.cwd(), "lib", "ai", "models.ts")).href);
const tiers = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href);

const { COSTED_ROUTES, MODEL_PRICES, ROUTE_BUDGETS, worstCaseCost } = models;
const {
  WEEKLY_AI_CAPS,
  MONTHLY_AI_CAPS,
  PAID_TIERS,
  PLANS,
  PLAN_IDS,
  SELLABLE_TIERS,
  HKD_PER_USD,
  MIN_MONTHLY_MARGIN_HKD,
  monthsCovered,
  netRevenue,
  tierHasAi,
  worstCaseTierCost,
} = tiers;

/*
  Everything here is in Hong Kong dollars now, because that is what the plans
  are sold in and what the owner set the floor in. Only the model bill arrives
  in US dollars, so that is the one number converted — at the peg, which is a
  band the Monetary Authority defends rather than a rate that floats.
*/
const MIN_MONTHLY_PROFIT = tiers.MIN_MONTHLY_MARGIN_HKD;

const hk = (n) => `HK$${n.toFixed(4)}`;

test("every plan makes money even if the subscriber uses every last request", () => {
  const rows = [];

  for (const planId of PLAN_IDS) {
    const plan = PLANS[planId];
    const months = monthsCovered(plan);
    const net = netRevenue(plan);
    const cost = worstCaseTierCost(plan.tier) * months * HKD_PER_USD;
    const profit = net - cost;
    const ratio = cost / net;

    rows.push({ planId, net, cost, profit, perMonth: profit / months, ratio });

    assert.ok(
      profit > 0,
      `${planId} loses money at the cap: ${hk(cost)} of AI against ${hk(net)} of revenue`,
    );
    assert.ok(
      profit / months >= MIN_MONTHLY_PROFIT,
      `${planId} leaves only HK$${(profit / months).toFixed(2)} a month, ` +
        `under the HK$${MIN_MONTHLY_MARGIN_HKD.toFixed(2)} floor`,
    );
  }

  // Printed rather than only asserted: the numbers are the point, and having
  // them in the test log is how a pricing change gets reviewed.
  for (const r of rows) {
    console.log(
      `  ${r.planId.padEnd(18)} net ${hk(r.net).padStart(12)}  ai ${hk(r.cost).padStart(12)}` +
        `  profit ${hk(r.profit).padStart(12)}  (HK$${r.perMonth
          .toFixed(2)
          .padStart(6)}/mo, ${(r.ratio * 100).toFixed(1)}% on AI)`,
    );
  }
});

test("the tiers that promise no AI are given none", () => {
  for (const tier of ["free", "standard"]) {
    assert.equal(tierHasAi(tier), false, `${tier} should have no AI at all`);
    assert.equal(worstCaseTierCost(tier), 0, `${tier} must cost nothing to serve`);
    for (const route of COSTED_ROUTES) {
      assert.equal(MONTHLY_AI_CAPS[tier][route], 0, `${tier}.${route} should be 0`);
    }
  }
});

test("every sellable tier has an allowance for every route, and admin is unlimited", () => {
  for (const tier of SELLABLE_TIERS) {
    for (const route of COSTED_ROUTES) {
      const monthly = MONTHLY_AI_CAPS[tier][route];
      const daily = WEEKLY_AI_CAPS[tier][route];
      assert.equal(typeof monthly, "number", `${tier}.${route} monthly must be a number`);
      assert.equal(typeof daily, "number", `${tier}.${route} daily must be a number`);
      assert.ok(monthly >= 0 && daily >= 0, `${tier}.${route} must not be negative`);
      /*
        The daily ceiling exists to slow a month down, not to shrink it. One
        above the month would do nothing; one that adds up to less than the
        month over 30 days would silently sell an allowance nobody can reach.
      */
      assert.ok(
        daily <= monthly,
        `${tier}.${route} daily ${daily} is above its own monthly ${monthly}`,
      );
      assert.ok(
        daily * 30 >= monthly,
        `${tier}.${route} daily ${daily} makes the monthly ${monthly} unreachable`,
      );
    }
  }
  for (const route of COSTED_ROUTES) {
    assert.equal(MONTHLY_AI_CAPS.admin[route], null, "admin must be uncapped");
    assert.equal(WEEKLY_AI_CAPS.admin[route], null, "admin must be uncapped");
  }
});

test("paid tiers step up, never down", () => {
  for (const route of COSTED_ROUTES) {
    let previous = -1;
    for (const tier of PAID_TIERS) {
      const cap = MONTHLY_AI_CAPS[tier][route];
      assert.ok(
        cap >= previous,
        `${tier}.${route} (${cap}) is less than the tier below it (${previous})`,
      );
      previous = cap;
    }
  }
});

/*
  The half of the cost that a route controls rather than this file.

  worstCaseCost multiplies a price by two token counts, and the input count is
  only true while the route still enforces the cap it was derived from. Deleting
  one of these constants would not fail a type check and would not fail any other
  test — it would just quietly make every one of the numbers above wrong. So the
  caps are read out of the route sources and checked against the budget.
*/
const INPUT_CAPS = [
  {
    route: "grade/writing",
    file: "app/api/grade/writing/route.ts",
    constants: { MAX_ESSAY_CHARS: 12000 },
  },
  {
    route: "grade/speaking",
    file: "app/api/grade/speaking/route.ts",
    constants: { MAX_TURN_CHARS: 2000, MAX_TRANSCRIPT_CHARS: 20000 },
  },
  {
    route: "chat",
    file: "app/api/chat/route.ts",
    constants: { MAX_HISTORY: 10, MAX_CHARS: 2000, MAX_HISTORY_CHARS: 1000 },
  },
];

test("the routes still enforce the input caps the cost model assumes", () => {
  for (const { file, constants } of INPUT_CAPS) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const [name, expected] of Object.entries(constants)) {
      const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`));
      assert.ok(match, `${file} no longer defines ${name} — the cost model assumed it`);
      assert.equal(
        Number(match[1]),
        expected,
        `${file} changed ${name} to ${match[1]}; lib/ai/models.ts budgets for ${expected}`,
      );
    }
  }
});

test("the largest input a route accepts fits inside its budget", () => {
  const chars = models.tokensForChars;

  // grade/writing: essay + prompt + the band descriptors in the system message.
  assert.ok(
    chars(12000) + 1400 <= ROUTE_BUDGETS["grade/writing"].maxInputTokens,
    "grade/writing input budget is smaller than what the route accepts",
  );
  // grade/speaking: the rendered transcript plus the speaking descriptors.
  assert.ok(
    chars(20000) + 1400 <= ROUTE_BUDGETS["grade/speaking"].maxInputTokens,
    "grade/speaking input budget is smaller than what the route accepts",
  );
  // chat: ten replayed turns, the new question, and the system prompt.
  assert.ok(
    chars(10 * 1000 + 2000) + 900 <= ROUTE_BUDGETS.chat.maxInputTokens,
    "chat input budget is smaller than what the route accepts",
  );
});

/*
  Every price above is set against Stripe's standard 2.9% + 30c. That is only
  what Stripe charges while Managed Payments is off — with it on, Stripe becomes
  the merchant of record, handles sales tax and VAT, and charges more for doing
  it. Plans carrying about HK$3 of margin a month cannot absorb that.

  The switch lives in one line of the checkout call, which means it can be
  deleted in a refactor by somebody who has never read this file. So the line is
  asserted here, next to the arithmetic that depends on it.
*/
test("the fee model the prices assume is the one checkout actually asks for", () => {
  const source = readFileSync(join(process.cwd(), "lib", "billing", "stripe.ts"), "utf8");
  assert.match(
    source,
    /"managed_payments\[enabled\]":\s*"false"/,
    "checkout no longer disables Managed Payments, so Stripe's cut is higher than " +
      "lib/billing/tiers.ts assumes and every price needs recomputing",
  );
});

test("nothing runs on a model this file has not priced", () => {
  for (const route of COSTED_ROUTES) {
    const budget = ROUTE_BUDGETS[route];
    assert.ok(
      Object.prototype.hasOwnProperty.call(MODEL_PRICES, budget.model),
      `${route} runs on ${budget.model}, which has no price here`,
    );
    assert.ok(worstCaseCost(route) > 0, `${route} costs nothing, which cannot be right`);
  }
});

/*
  Haiku rejects `output_config.effort` with a 400 rather than ignoring it, so
  sending one turns every request on that route into an error. lib/anthropic.ts
  drops the parameter for Haiku; this is the check that it still does.
*/
test("effort is never sent to a model that refuses it", () => {
  const source = readFileSync(join(process.cwd(), "lib", "anthropic.ts"), "utf8");
  assert.match(
    source,
    /function acceptsEffort[\s\S]*?claude-haiku/,
    "lib/anthropic.ts no longer excludes Haiku from the effort parameter",
  );
  assert.match(
    source,
    /if \(acceptsEffort\(model\)\) outputConfig\.effort/,
    "lib/anthropic.ts sets effort without checking the model first",
  );
});
