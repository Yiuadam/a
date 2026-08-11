import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const decimal = await load("lib", "admin", "finance-decimal.ts");
const periodModule = await load("lib", "admin", "finance-period.ts");
const finance = await load("lib", "admin", "finance.ts");
const financeFormat = await load("lib", "admin", "finance-format.ts");
const financeView = await load("lib", "admin", "finance-view.ts");
const anthropic = await load("lib", "admin", "anthropic-cost.ts");
const stripeFinance = await load("lib", "billing", "finance.ts");

const NOW = new Date("2026-08-12T12:34:56.000Z");
const PERIOD = periodModule.financePeriod(NOW);
const utc = (value) => Math.floor(Date.parse(value) / 1000);

test("provider decimals add and subtract without rounding fractional cents", () => {
  assert.equal(decimal.addDecimal("0.1", "0.02", "-0.003"), "0.117");
  assert.equal(decimal.addDecimal("123.45", "0.55"), "124");
  assert.equal(decimal.subtractDecimal("95", "10.55"), "84.45");
  assert.equal(decimal.normaliseDecimal("-000.1200"), "-0.12");
});

test("provider-reported fractional cents stay visible above one dollar", () => {
  assert.equal(
    financeFormat.formatExactMoney({ currency: "USD", minorUnits: "123.45" }),
    "$1.2345",
  );
  assert.equal(
    financeFormat.formatExactMoney({ currency: "USD", minorUnits: "0.0001" }),
    "$0.000001",
  );
});

test("the dashboard period is 30 named UTC days including today", () => {
  assert.equal(PERIOD.startingAt, "2026-07-14T00:00:00.000Z");
  assert.equal(PERIOD.endingAt, NOW.toISOString());
  const days = periodModule.utcDays(PERIOD);
  assert.equal(days.length, 30);
  assert.equal(days[0], "2026-07-14");
  assert.equal(days.at(-1), "2026-08-12");
});

test("Stripe keeps currencies apart, excludes money movement, and surfaces unknown categories", () => {
  const snapshot = stripeFinance.summariseStripeFinance(
    [
      { created: utc("2026-01-02T00:00:00Z"), currency: "hkd", reportingCategory: "charge", amountMinor: 10_000, feeMinor: 500, netMinor: 9_500 },
      { created: utc("2026-08-01T00:00:00Z"), currency: "hkd", reportingCategory: "charge", amountMinor: 2_000, feeMinor: 100, netMinor: 1_900 },
      { created: utc("2026-08-02T00:00:00Z"), currency: "hkd", reportingCategory: "refund", amountMinor: -500, feeMinor: 0, netMinor: -500 },
      { created: utc("2026-08-03T00:00:00Z"), currency: "hkd", reportingCategory: "payout", amountMinor: -8_000, feeMinor: 0, netMinor: -8_000 },
      { created: utc("2026-08-04T00:00:00Z"), currency: "hkd", reportingCategory: "transfer", amountMinor: -200, feeMinor: 0, netMinor: -200 },
      { created: utc("2026-08-05T00:00:00Z"), currency: "hkd", reportingCategory: "new_adjustment", amountMinor: 17, feeMinor: 0, netMinor: 17 },
      { created: utc("2026-08-06T00:00:00Z"), currency: "usd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 },
    ],
    [
      { arrivalDate: utc("2026-02-01T00:00:00Z"), currency: "hkd", amountMinor: 6_000 },
      { arrivalDate: utc("2026-08-08T00:00:00Z"), currency: "hkd", amountMinor: 1_000 },
      { arrivalDate: utc("2026-08-08T00:00:00Z"), currency: "usd", amountMinor: 50 },
    ],
    PERIOD,
  );

  assert.deepEqual(snapshot.currencies.map((row) => row.currency), ["HKD", "USD"]);
  const hkd = snapshot.currencies[0];
  assert.equal(hkd.lifetime.net.minorUnits, "10900");
  assert.equal(hkd.period.net.minorUnits, "1400");
  assert.equal(hkd.period.unknownNet.minorUnits, "17");
  assert.equal(hkd.lifetimePaidPayouts.amount.minorUnits, "7000");
  assert.equal(hkd.periodPaidPayouts.amount.minorUnits, "1000");
  assert.equal(hkd.daily.length, 30);
  assert.equal(hkd.categories.find((row) => row.category === "payout").classification, "money_movement");
  assert.equal(hkd.categories.find((row) => row.category === "new_adjustment").classification, "unknown");
});

test("gross customer payments exclude failed and uncaptured charge amounts", () => {
  const snapshot = stripeFinance.summariseStripeFinance(
    [
      { created: utc("2026-08-01T00:00:00Z"), currency: "usd", reportingCategory: "charge", amountMinor: 10_000, feeMinor: 300, netMinor: 9_700 },
      { created: utc("2026-08-02T00:00:00Z"), currency: "usd", reportingCategory: "charge_failure", amountMinor: -2_000, feeMinor: 0, netMinor: -2_000 },
      { created: utc("2026-08-03T00:00:00Z"), currency: "usd", reportingCategory: "partial_capture_reversal", amountMinor: -1_000, feeMinor: 0, netMinor: -1_000 },
      { created: utc("2026-08-04T00:00:00Z"), currency: "usd", reportingCategory: "refund", amountMinor: -500, feeMinor: 0, netMinor: -500 },
    ],
    [],
    PERIOD,
  );

  assert.equal(
    financeView.grossCustomerPayments(snapshot.currencies[0], "lifetime").minorUnits,
    "7000",
  );
});

test("Anthropic aggregates fractional cents, all costs, and token-only costs", () => {
  const snapshot = anthropic.summariseAnthropicCost(
    [
      {
        startingAt: "2026-01-02T00:00:00Z",
        endingAt: "2026-01-03T00:00:00Z",
        results: [{ amount: "123.45", currency: "USD", costType: "tokens" }],
      },
      {
        startingAt: "2026-08-06T00:00:00Z",
        endingAt: "2026-08-07T00:00:00Z",
        results: [
          { amount: "0.55", currency: "USD", costType: "tokens" },
          { amount: "10", currency: "USD", costType: "web_search" },
        ],
      },
    ],
    PERIOD,
    true,
  );

  assert.equal(snapshot.lifetime.cost.minorUnits, "134");
  assert.equal(snapshot.lifetime.tokenCost.minorUnits, "124");
  assert.equal(snapshot.period.cost.minorUnits, "10.55");
  assert.equal(snapshot.period.tokenCost.minorUnits, "0.55");
  assert.equal(snapshot.daily.length, 30);
  assert.equal(snapshot.workspaceFiltered, true);
});

test("contribution is exact only for one USD Stripe currency", () => {
  const stripe = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "usd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 }],
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
  const contribution = finance.financeContribution(stripe, ai);
  assert.equal(contribution.period.contribution.minorUnits, "84.45");

  const hkd = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "hkd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 }],
    [],
    PERIOD,
  );
  assert.equal(finance.financeContribution(hkd, ai), null);
});

test("Stripe finance pagination uses created activity and paid arrival dates", async () => {
  const stripe = await load("lib", "billing", "stripe.ts");
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousFetch = globalThis.fetch;
  const urls = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_finance";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("/balance_transactions")) {
      if (!url.searchParams.has("starting_after")) {
        return Response.json({
          data: [{ id: "txn_2", created: utc("2026-08-01T00:00:00Z"), currency: "usd", reporting_category: "charge", amount: 100, fee: 5, net: 95 }],
          has_more: true,
        });
      }
      assert.equal(url.searchParams.get("starting_after"), "txn_2");
      return Response.json({ data: [], has_more: false });
    }
    if (url.pathname.endsWith("/payouts")) {
      return Response.json({
        data: [{ id: "po_1", arrival_date: utc("2026-08-08T00:00:00Z"), currency: "usd", amount: 80 }],
        has_more: false,
      });
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const snapshot = await stripe.financialSnapshot(PERIOD, periodModule.FINANCE_LIFETIME_START);
    assert.equal(snapshot.currencies[0].lifetime.net.minorUnits, "95");
    assert.equal(snapshot.currencies[0].periodPaidPayouts.amount.minorUnits, "80");
    const balanceUrl = urls.find((url) => url.pathname.endsWith("/balance_transactions"));
    const payoutUrl = urls.find((url) => url.pathname.endsWith("/payouts"));
    assert.ok(balanceUrl.searchParams.has("created[gte]"));
    assert.ok(balanceUrl.searchParams.has("created[lt]"));
    assert.equal(payoutUrl.searchParams.get("status"), "paid");
    assert.ok(payoutUrl.searchParams.has("arrival_date[gte]"));
    assert.ok(payoutUrl.searchParams.has("arrival_date[lt]"));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
  }
});
