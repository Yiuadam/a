/*
  The HKMA exchange-rate feed fails more often than it succeeds in production
  right now, and this sandbox cannot even reach api.hkma.gov.hk to check —
  see hkmaFxSnapshot's `fetcher` parameter, which exists so callers (this
  file included) can simulate the feed instead of dialling out to it.

  These tests cover the fallback added to lib/admin/finance-fx.ts and
  lib/admin/finance.ts: a fixed, clearly labelled reference table stands in
  for the live rate on any FinanceFxError, rather than every HKD-denominated
  figure on the dashboard disappearing along with the merged chart.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const decimal = await load("lib", "admin", "finance-decimal.ts");
const periodModule = await load("lib", "admin", "finance-period.ts");
const finance = await load("lib", "admin", "finance.ts");
const financeFx = await load("lib", "admin", "finance-fx.ts");
const anthropic = await load("lib", "admin", "anthropic-cost.ts");
const stripeFinance = await load("lib", "billing", "finance.ts");

const NOW = new Date("2026-08-12T12:34:56.000Z");
const PERIOD = periodModule.financePeriod(NOW);
const utc = (value) => Math.floor(Date.parse(value) / 1000);

/* The exact table the owner asked for: HKD-per-major-unit, kept in one place
   here so the coverage test below can be a straight comparison rather than
   a re-derivation of lib/admin/finance-fx.ts's own constant. */
const REFERENCE_RATES = {
  USD: "7.8", EUR: "8.5", GBP: "9.9", CNY: "1.08", JPY: "0.052",
  AUD: "5.1", CAD: "5.7", SGD: "5.8", NZD: "4.7", CHF: "8.8", HKD: "1",
};

test("parseHkmaFx still parses a valid HKMA payload into a non-approximate snapshot", () => {
  const fx = financeFx.parseHkmaFx(
    { result: { records: [{ end_of_day: "2026-07-31", usd: 7.842, eur: 9.03 }] } },
    NOW,
  );
  assert.equal(fx.approximate, false);
  assert.equal(fx.source, "Hong Kong Monetary Authority");
  assert.equal(fx.asOf, "2026-07-31");
  assert.equal(fx.rates.USD, "7.842");
});

test("every FinanceFxError code falls back to a non-null, approximate estimate", async () => {
  const stripe = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "hkd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 }],
    [],
    PERIOD,
  );
  const ai = anthropic.summariseAnthropicCost(
    [{
      startingAt: "2026-08-06T00:00:00Z",
      endingAt: "2026-08-07T00:00:00Z",
      results: [{ amount: "10.55", currency: "USD", costType: "tokens" }],
    }],
    PERIOD,
    false,
  );

  /* One injected failure per FinanceFxError code, exercised through
     hkmaFxSnapshot's fetcher parameter rather than a real request. */
  const failures = {
    provider_unavailable: async () => { throw new Error("simulated network failure"); },
    invalid_response: async () => Response.json({ result: { records: [] } }),
    stale_data: async () =>
      Response.json({ result: { records: [{ end_of_day: "2026-01-01", usd: 7.8 }] } }),
  };

  for (const [code, fetcher] of Object.entries(failures)) {
    let caught = null;
    try {
      await financeFx.hkmaFxSnapshot(fetcher, NOW);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof financeFx.FinanceFxError, `${code}: hkmaFxSnapshot did not throw a FinanceFxError`);
    assert.equal(caught.code, code);

    /*
      app/api/admin/finance/route.ts catches exactly this error, whichever
      of the three codes it is, and passes fx through as null — that is the
      contract this fix changes, so it is what the fallback is exercised
      against here rather than a hypothetical new entry point.
    */
    const estimate = finance.estimatedHkdFinance(stripe, ai, null);
    assert.notEqual(estimate, null, `${code}: estimatedHkdFinance returned null instead of falling back`);
    assert.equal(estimate.basis, "estimated");
    assert.equal(estimate.fx.approximate, true);
    assert.equal(estimate.fx.source, "Approximate reference rate");
  }
});

test("the reference table covers every listed currency with a positive rate in the live-rate decimal form", () => {
  const ref = financeFx.referenceHkdFxSnapshot(NOW);
  assert.equal(ref.approximate, true);
  assert.equal(ref.source, "Approximate reference rate");
  assert.deepEqual(Object.keys(ref.rates).sort(), Object.keys(REFERENCE_RATES).sort());

  for (const [currency, expected] of Object.entries(REFERENCE_RATES)) {
    const rate = ref.rates[currency];
    assert.equal(rate, expected, `${currency} reference rate does not match the table the owner asked for`);
    assert.match(rate, /^\d+(\.\d+)?$/, `${currency} rate ${rate} is not a plain positive decimal string`);
    assert.ok(Number(rate) > 0, `${currency} rate ${rate} is not positive`);
    /* Same decimal-string form parseHkmaFx's live rates use (built through
       the same rateDecimal/normaliseDecimal helpers), so normalising it a
       second time must be a no-op rather than reshaping it. */
    assert.equal(decimal.normaliseDecimal(rate), rate);
  }
});

test("a currency absent from the reference table still yields no conversion, not zero", () => {
  const ref = financeFx.referenceHkdFxSnapshot(NOW);
  assert.equal(ref.rates.INR, undefined);
  assert.equal(finance.estimateMoneyInHkd({ currency: "INR", minorUnits: "10000" }, ref), null);

  const stripe = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "inr", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 }],
    [],
    PERIOD,
  );
  const ai = anthropic.summariseAnthropicCost([], PERIOD, false);
  /* fx: null forces the reference-table fallback; the whole estimate must
     still refuse rather than quietly pricing the INR receipts at HK$0 —
     the same refusal lib/admin/finance.ts already gave a live snapshot
     missing a currency, unchanged by this fix. */
  assert.equal(finance.estimatedHkdFinance(stripe, ai, null), null);
});

test("the finance page labels the approximate HKD estimate at a glance", () => {
  const source = readFileSync(join(process.cwd(), "app", "admin", "finance", "page.tsx"), "utf8");
  // \s+ rather than a literal space: source formatting may wrap the words
  // in the JSX onto separate lines without changing what is actually shown.
  assert.match(source, /reference\s+rate/i, "the page never names the reference rate");
  assert.match(source, /indicative/i, "the page never marks the approximate figures as indicative");
});
