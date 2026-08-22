/*
  The health check used to pass with prices nobody could buy.

  `stripe_price_ids_present` asked whether six environment variables held a
  string. That is true of an id pointing at a Price on another Stripe account,
  an id left behind when a Price was replaced, and an id for a Price charging
  an amount /pricing never printed. All three are a learner pressing Subscribe
  and either getting nothing or being charged the wrong number — and all three
  reported the deployment healthy.

  These tests hold the replacement to the standard the task set: the deploy now
  verifies the prices themselves, through the very same comparison the checkout
  path runs before every sale, so the two cannot drift into different ideas of
  what "correct" means.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const load = (...parts) => import(pathToFileURL(join(root, ...parts)).href);

const { priceCatalogueFault, verifyCataloguePrices } = await load("lib", "billing", "stripe.ts");
const { PLANS, PLAN_IDS } = await load("lib", "billing", "tiers.ts");

/** A Stripe Price object that agrees with the catalogue in every respect. */
function goodPrice(plan) {
  const expected = PLANS[plan];
  const currency_options = {};
  for (const [code, unit_amount] of Object.entries(expected.prices)) {
    currency_options[code] = { unit_amount };
  }
  return {
    active: true,
    unit_amount: expected.amountMinor,
    currency: expected.currency,
    recurring: { interval: expected.interval },
    currency_options,
  };
}

test("a Price that matches the catalogue reports no fault", () => {
  for (const plan of PLAN_IDS) {
    assert.equal(priceCatalogueFault(plan, "price_x", goodPrice(plan)), null, plan);
  }
});

test("an archived Price is caught, even though every other field is right", () => {
  /*
    The failure that motivated this file. A Stripe Price cannot be edited, only
    replaced, so changing one leaves the old object behind with `active: false`
    and every amount still perfectly correct. Checkout fails at the Session —
    after the learner has pressed the button.
  */
  const price = { ...goodPrice("pro-yearly"), active: false };
  const fault = priceCatalogueFault("pro-yearly", "price_old", price);
  assert.match(fault, /archived/);
  assert.match(fault, /pro-yearly/);
});

test("a wrong base amount is caught and both numbers are named", () => {
  const price = { ...goodPrice("plus-monthly"), unit_amount: 999 };
  const fault = priceCatalogueFault("plus-monthly", "price_x", price);
  assert.match(fault, /999/);
  assert.match(fault, new RegExp(String(PLANS["plus-monthly"].amountMinor)));
});

test("a wrong currency and a wrong interval are each caught", () => {
  assert.match(
    priceCatalogueFault("pro-monthly", "price_x", { ...goodPrice("pro-monthly"), currency: "usd" }),
    /usd/,
  );
  /*
    A monthly Price sold as the yearly plan charges the right number twelve
    times as often, which is worse than charging the wrong number once.
  */
  assert.match(
    priceCatalogueFault("pro-yearly", "price_x", {
      ...goodPrice("pro-yearly"),
      recurring: { interval: "month" },
    }),
    /monthly|monthly/,
  );
});

test("a regional price that disagrees is caught, and so is one that is absent", () => {
  const wrong = goodPrice("standard-monthly");
  wrong.currency_options = { ...wrong.currency_options, gbp: { unit_amount: 1 } };
  assert.match(priceCatalogueFault("standard-monthly", "price_x", wrong), /gbp/);

  // A Price created before regional pricing existed carries no currency_options
  // at all, and a reader quoted £1.29 would be charged the base amount converted.
  const bare = { ...goodPrice("standard-monthly"), currency_options: undefined };
  assert.notEqual(priceCatalogueFault("standard-monthly", "price_x", bare), null);
});

test("the currency comparison is case-insensitive, as Stripe's own casing is not guaranteed", () => {
  const price = { ...goodPrice("plus-yearly"), currency: PLANS["plus-yearly"].currency.toUpperCase() };
  assert.equal(priceCatalogueFault("plus-yearly", "price_x", price), null);
});

/* -------------------------------------------------------------------------- */
/* verifyCataloguePrices, against a Stripe that answers                        */
/* -------------------------------------------------------------------------- */

const PRICE_VARS = {
  "standard-monthly": "STRIPE_PRICE_STANDARD_MONTHLY",
  "standard-yearly": "STRIPE_PRICE_STANDARD_YEARLY",
  "plus-monthly": "STRIPE_PRICE_PLUS_MONTHLY",
  "plus-yearly": "STRIPE_PRICE_PLUS_YEARLY",
  "pro-monthly": "STRIPE_PRICE_PRO_MONTHLY",
  "pro-yearly": "STRIPE_PRICE_PRO_YEARLY",
};

/** Runs `fn` with six Price ids set and a Stripe that serves `priceFor(planId)`. */
async function withStripe(priceFor, fn) {
  const savedFetch = globalThis.fetch;
  const saved = { key: process.env.STRIPE_SECRET_KEY };
  process.env.STRIPE_SECRET_KEY = "sk_test_price_verification";
  for (const [plan, name] of Object.entries(PRICE_VARS)) {
    saved[name] = process.env[name];
    process.env[name] = `price_${plan}`;
  }
  // The id in the URL is what says which plan is being asked about, so the
  // stub can answer differently per plan without any other coordination.
  globalThis.fetch = async (url) => {
    const id = decodeURIComponent(String(url).split("/prices/")[1].split("?")[0]);
    const plan = id.replace(/^price_/, "");
    const body = priceFor(plan);
    if (!body) {
      return new Response(
        JSON.stringify({ error: { code: "resource_missing", message: `No such price: ${id}` } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.key;
    for (const name of Object.values(PRICE_VARS)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("every plan verifies when Stripe holds the catalogue's own prices", () =>
  withStripe(goodPrice, async () => {
    const results = await verifyCataloguePrices();
    assert.equal(results.length, PLAN_IDS.length);
    for (const result of results) assert.equal(result.ok, true, `${result.plan}: ${result.detail}`);
  }));

test("one archived Price fails only its own plan, and names it", () =>
  withStripe(
    (plan) => (plan === "pro-yearly" ? { ...goodPrice(plan), active: false } : goodPrice(plan)),
    async () => {
      const results = await verifyCataloguePrices();
      const failed = results.filter((r) => !r.ok);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].plan, "pro-yearly");
      assert.match(failed[0].detail, /archived/);
    },
  ));

test("an id pointing at nothing reports Stripe's own reason rather than a bare false", () =>
  withStripe(
    (plan) => (plan === "plus-monthly" ? null : goodPrice(plan)),
    async () => {
      const results = await verifyCataloguePrices();
      const failed = results.find((r) => !r.ok);
      assert.equal(failed.plan, "plus-monthly");
      // `resource_missing` for an id from another account reads very
      // differently from `api_key_expired`, and that difference is the value.
      assert.match(failed.detail, /resource_missing|No such price/);
    },
  ));

test("a missing Price id is reported as a failure, not skipped", () =>
  withStripe(goodPrice, async () => {
    const saved = process.env.STRIPE_PRICE_PRO_MONTHLY;
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    try {
      const results = await verifyCataloguePrices();
      const failed = results.find((r) => r.plan === "pro-monthly");
      assert.equal(failed.ok, false);
      assert.match(failed.detail, /no Price id/);
    } finally {
      process.env.STRIPE_PRICE_PRO_MONTHLY = saved;
    }
  }));

test("checkout and the health check share one comparison, rather than two copies", () => {
  /*
    The whole point of extracting `priceCatalogueFault`. If the checkout path
    ever grows its own private comparison again, the deploy could pass on a
    rule checkout would refuse — which is the failure mode this task exists to
    close, reintroduced one level down.
  */
  const source = readFileSync(join(root, "lib", "billing", "stripe.ts"), "utf8");
  const uses = source.match(/priceCatalogueFault\(/g) ?? [];
  // The definition, the checkout preflight, and verifyCataloguePrices.
  assert.ok(uses.length >= 3, `expected both callers to use it, saw ${uses.length}`);
  assert.match(source, /async function assertPriceMatchesCatalogue[\s\S]{0,240}priceCatalogueFault\(/);
});
