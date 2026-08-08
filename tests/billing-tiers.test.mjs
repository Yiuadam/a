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
  PLANS,
  PLAN_IDS,
  SELLABLE_TIERS,
  TIERS,
  dailyAiCalls,
  formatPrice,
  isPlanId,
  perMonthEquivalent,
  plansForTier,
  tierAllows,
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

test("the tutor chat is the paid feature, and only the paid tiers have it", () => {
  assert.equal(tierAllows("free", "tutor-chat"), false);
  assert.equal(tierAllows("pro", "tutor-chat"), true);
  // The owner's own account is not a plan, but it must not be locked out of
  // the app it exists to exercise.
  assert.equal(tierAllows("admin", "tutor-chat"), true);
});

test("everything that is free stays free on the free tier", () => {
  for (const feature of ["define", "generate", "grade-writing", "grade-speaking", "progress-sync"]) {
    assert.equal(tierAllows("free", feature), true, `free lost ${feature}`);
  }
});

test("a paid tier is never worse off than the free one", () => {
  // The mistake this catches is a feature added to `free` and forgotten on
  // `pro` — which reads as a subscriber losing something by paying.
  for (const feature of TIERS.free.features) {
    assert.equal(tierAllows("pro", feature), true, `pro is missing ${feature}`);
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

test("the meter enforces the number the pricing page promises", () => {
  assert.equal(limits.USAGE_LIMITS.free, TIERS.free.dailyAiCalls);
  assert.equal(limits.USAGE_LIMITS.pro, TIERS.pro.dailyAiCalls);
  assert.equal(limits.USAGE_LIMITS.admin, TIERS.admin.dailyAiCalls);
  assert.equal(dailyAiCalls("pro"), limits.USAGE_LIMITS.pro);
});

test("the paid tier buys more than the free one, and the owner has no cap", () => {
  assert.ok(TIERS.pro.dailyAiCalls > TIERS.free.dailyAiCalls);
  assert.equal(TIERS.admin.dailyAiCalls, null);
  // A null here would mean an unlimited free tier, which is an uncapped bill.
  assert.equal(typeof TIERS.free.dailyAiCalls, "number");
});

test("the database is handed every bucket the meter knows how to read", () => {
  const forDatabase = limits.limitsForDatabase();
  assert.deepEqual(Object.keys(forDatabase).sort(), [
    "admin",
    "anonymous",
    "free",
    "ip",
    "pro",
  ]);
  // A copy, not the live object: the meter must not be able to edit policy.
  forDatabase.free = 9999;
  assert.equal(limits.USAGE_LIMITS.free, TIERS.free.dailyAiCalls);
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
  assert.equal(plansForTier("pro").length, PLAN_IDS.length);
});

test("the yearly plan costs less per month than the monthly one", () => {
  // Not a marketing claim in a string: the two numbers, compared.
  const monthly = PLANS["pro-monthly"];
  const yearly = PLANS["pro-yearly"];
  assert.ok(perMonthEquivalent(yearly) < monthly.amountMinor);
  assert.equal(perMonthEquivalent(monthly), monthly.amountMinor);
  assert.equal(perMonthEquivalent(yearly), Math.round(yearly.amountMinor / 12));
});

test("prices are formatted as money, without inventing pennies", () => {
  assert.equal(formatPrice(900, "usd"), "$9");
  assert.equal(formatPrice(7200, "usd"), "$72");
  assert.equal(formatPrice(600, "usd"), "$6");
  assert.equal(formatPrice(799, "usd"), "$7.99");
  assert.equal(formatPrice(0, "usd"), "$0");
});
