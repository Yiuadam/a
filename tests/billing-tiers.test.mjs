/*
  The gate, tested exhaustively, because it is small enough to be.

  `tierAllows` is the whole of "may this tier use this feature?". It is a pure
  function of two values, so every pair can be enumerated — which is worth
  doing, because the failure mode is silent in both directions: a tier that
  wrongly allows something gives away a paid feature, and a tier that wrongly
  refuses one takes away something somebody paid for, and neither throws.

  Also pinned here: that the meter and the pricing page read the same numbers.
  Before lib/usage/limits.ts derived its figures from the catalogue, the page's
  promise and the limit actually enforced were two constants that agreed only
  by attention.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const tiers = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href);
const limits = await import(pathToFileURL(join(process.cwd(), "lib", "usage", "limits.ts")).href);

const {
  FEATURES,
  MONTHLY_AI_CAPS,
  PAID_TIERS,
  PLANS,
  PLAN_IDS,
  SELLABLE_TIERS,
  TIERS,
  formatPrice,
  isPlanId,
  monthlyCap,
  perMonthEquivalent,
  plansForTier,
  tierAllows,
  tierHasAi,
} = tiers;

/* ------------------------------------------------------------------ gate -- */

test("every tier and feature pair has a definite answer", () => {
  for (const tier of Object.keys(TIERS)) {
    for (const feature of FEATURES) {
      assert.equal(
        typeof tierAllows(tier, feature),
        "boolean",
        `${tier} × ${feature} did not produce an answer`,
      );
    }
  }
});

test("AI starts at Plus, and the tiers below it get none of it", () => {
  for (const feature of ["define", "generate", "grade-writing", "grade-speaking", "tutor-chat"]) {
    assert.equal(tierAllows("free", feature), false, `free should not have ${feature}`);
    assert.equal(tierAllows("standard", feature), false, `standard should not have ${feature}`);
    assert.equal(tierAllows("plus", feature), true, `plus is missing ${feature}`);
    assert.equal(tierAllows("pro", feature), true, `pro is missing ${feature}`);
    // The owner's own account is not a plan, but it must not be locked out of
    // the app it exists to exercise.
    assert.equal(tierAllows("admin", feature), true, `admin is missing ${feature}`);
  }
  assert.equal(tierHasAi("free"), false);
  assert.equal(tierHasAi("standard"), false);
  assert.equal(tierHasAi("plus"), true);
  assert.equal(tierHasAi("pro"), true);
});

test("syncing progress costs nothing, so every tier has it", () => {
  for (const tier of Object.keys(TIERS)) {
    assert.equal(tierAllows(tier, "progress-sync"), true, `${tier} lost progress-sync`);
  }
});

test("a paid tier is never worse off than the one below it", () => {
  // The mistake this catches is an allowance raised on one tier and forgotten
  // on the one above — which reads as a subscriber losing something by paying
  // more.
  let below = "free";
  for (const tier of PAID_TIERS) {
    for (const feature of FEATURES) {
      if (!tierAllows(below, feature)) continue;
      assert.equal(tierAllows(tier, feature), true, `${tier} is missing ${feature}`);
    }
    below = tier;
  }
  for (const feature of FEATURES) {
    assert.equal(tierAllows("admin", feature), true, `admin is missing ${feature}`);
  }
});

test("an unknown tier is refused, not waved through", () => {
  // Anything the database could return that this code does not recognise —
  // a tier added to a migration and not here, a typo, an injected string.
  for (const tier of ["", "Pro", "PRO", "premium", "undefined", "null", "__proto__", "toString"]) {
    assert.equal(
      tierAllows(tier, "tutor-chat"),
      false,
      `${JSON.stringify(tier)} was allowed a paid feature`,
    );
    assert.equal(tierAllows(tier, "define"), false);
  }
});

test("a feature name that does not exist is refused by every tier", () => {
  for (const tier of Object.keys(TIERS)) {
    assert.equal(tierAllows(tier, "not-a-feature"), false);
  }
});

/* ------------------------------------------------------- quotas and copy -- */

test("the meter is handed exactly the allowances the catalogue defines", () => {
  const forDatabase = limits.limitsForDatabase();
  for (const tier of [...SELLABLE_TIERS, "admin"]) {
    for (const route of limits.AI_ROUTES) {
      assert.equal(
        forDatabase.monthly[tier][route],
        monthlyCap(tier, route),
        `${tier}.${route} is metered at a different number than the page promises`,
      );
    }
  }
});

test("an un-migrated database refuses AI rather than uncapping it", () => {
  /*
    The flat per-tier keys are the pre-0012 shape. A database that has not had
    supabase/migrations/0012_route_limits.sql applied reads only those, so they
    must all be zero: a missing key reads as unlimited on the old function, and
    a real number there would enforce the wrong cap silently. Admin stays null
    so the owner's account still works and can diagnose it.
  */
  const forDatabase = limits.limitsForDatabase();
  for (const tier of SELLABLE_TIERS) {
    assert.equal(forDatabase[tier], 0, `${tier} would be metered wrongly by an old database`);
  }
  assert.equal(forDatabase.admin, null);
  assert.equal(forDatabase.anonymous, 0);
  assert.equal(forDatabase.schema, limits.LIMITS_SCHEMA_VERSION);
});

test("the database is handed every bucket the meter knows how to read", () => {
  const forDatabase = limits.limitsForDatabase();
  assert.deepEqual(Object.keys(forDatabase).sort(), [
    "admin",
    "anonymous",
    "daily",
    "free",
    "ip",
    "monthly",
    "month_seconds",
    "plus",
    "pro",
    "schema",
    "standard",
  ].sort());
  // A copy, not the live object: the meter must not be able to edit policy.
  forDatabase.monthly.plus.chat = 9999;
  assert.equal(MONTHLY_AI_CAPS.plus.chat, monthlyCap("plus", "chat"));
  assert.notEqual(monthlyCap("plus", "chat"), 9999);
});

test("every tier shown on the pricing page has something to say for itself", () => {
  for (const id of SELLABLE_TIERS) {
    const tier = TIERS[id];
    assert.ok(tier.name.length > 0, `${id} has no name`);
    assert.ok(tier.blurb.length > 0, `${id} has no blurb`);
    assert.ok(tier.includes.length > 0, `${id} lists nothing it includes`);
  }
});

/* ------------------------------------------------------------------ plans -- */

test("only plan ids this app defined are accepted", () => {
  for (const id of PLAN_IDS) assert.equal(isPlanId(id), true);
  // The shape of the attack this refuses: a caller naming a Stripe Price, or
  // a plan that used to exist and was withdrawn.
  for (const bad of ["price_1234", "pro", "", null, undefined, 7, {}, ["pro-monthly"]]) {
    assert.equal(isPlanId(bad), false, `${JSON.stringify(bad)} was accepted as a plan`);
  }
});

test("no plan sells the free tier or the owner's account", () => {
  for (const id of PLAN_IDS) {
    assert.notEqual(PLANS[id].tier, "free");
    assert.notEqual(PLANS[id].tier, "admin");
  }
  assert.deepEqual(plansForTier("free"), []);
  assert.deepEqual(plansForTier("admin"), []);
  // Every paid tier is sold monthly and yearly, and between them they account
  // for every plan id.
  let total = 0;
  for (const tier of PAID_TIERS) {
    const plans = plansForTier(tier);
    assert.equal(plans.length, 2, `${tier} should be sold monthly and yearly`);
    assert.deepEqual(
      plans.map((p) => p.interval).sort(),
      ["month", "year"],
      `${tier} is missing an interval`,
    );
    total += plans.length;
  }
  assert.equal(total, PLAN_IDS.length);
});

test("the ladder goes up, and every step is a real price", () => {
  let below = 0;
  for (const tier of PAID_TIERS) {
    const monthly = plansForTier(tier).find((p) => p.interval === "month");
    assert.ok(monthly.amountMinor > below, `${tier} does not cost more than the tier below it`);
    below = monthly.amountMinor;
  }
});

test("the yearly plan costs less per month than the monthly one", () => {
  // Not a marketing claim in a string: the two numbers, compared.
  for (const tier of PAID_TIERS) {
    const monthly = plansForTier(tier).find((p) => p.interval === "month");
    const yearly = plansForTier(tier).find((p) => p.interval === "year");
    assert.ok(
      perMonthEquivalent(yearly) < monthly.amountMinor,
      `${tier} yearly is not cheaper per month than ${tier} monthly`,
    );
    assert.equal(perMonthEquivalent(monthly), monthly.amountMinor);
    assert.equal(perMonthEquivalent(yearly), Math.round(yearly.amountMinor / 12));
  }
  assert.ok(PLANS["pro-monthly"].amountMinor > 0);
});

test("prices are formatted as money, without inventing pennies", () => {
  assert.equal(formatPrice(900, "usd"), "$9");
  assert.equal(formatPrice(7200, "usd"), "$72");
  assert.equal(formatPrice(600, "usd"), "$6");
  assert.equal(formatPrice(799, "usd"), "$7.99");
  assert.equal(formatPrice(0, "usd"), "$0");
});
