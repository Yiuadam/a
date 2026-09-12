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
const financeFx = await load("lib", "admin", "finance-fx.ts");
const localCost = await load("lib", "admin", "finance-local-cost.ts");
const financeFormat = await load("lib", "admin", "finance-format.ts");
const financeView = await load("lib", "admin", "finance-view.ts");
const anthropic = await load("lib", "admin", "anthropic-cost.ts");
const stripeFinance = await load("lib", "billing", "finance.ts");
const stripe = await load("lib", "billing", "stripe.ts");
const tiers = await load("lib", "billing", "tiers.ts");

const NOW = new Date("2026-08-12T12:34:56.000Z");
const PERIOD = periodModule.financePeriod(NOW);
const utc = (value) => Math.floor(Date.parse(value) / 1000);

test("provider decimals add and subtract without rounding fractional cents", () => {
  assert.equal(decimal.addDecimal("0.1", "0.02", "-0.003"), "0.117");
  assert.equal(decimal.addDecimal("123.45", "0.55"), "124");
  assert.equal(decimal.subtractDecimal("95", "10.55"), "84.45");
  assert.equal(decimal.normaliseDecimal("-000.1200"), "-0.12");
  assert.equal(decimal.multiplyDecimal("10.55", "7.842"), "82.7331");
});

test("HKMA floating JSON is normalised into a dated official rate snapshot", () => {
  const fx = financeFx.parseHkmaFx(
    {
      result: {
        records: [
          { end_of_day: "2026-07-31", usd: 7.8420000000000005, eur: 9.03, neeri_2020_trade_wgt: 101.1 },
        ],
      },
    },
    NOW,
  );
  assert.equal(fx.source, "Hong Kong Monetary Authority");
  assert.equal(fx.asOf, "2026-07-31");
  assert.equal(fx.rates.HKD, "1");
  assert.equal(fx.rates.USD, "7.842");
  assert.equal(fx.rates.EUR, "9.03");
  assert.equal(fx.rates.NEERI_2020_TRADE_WGT, undefined);
});

test("stale HKMA data is refused rather than used silently", () => {
  assert.throws(
    () =>
      financeFx.parseHkmaFx(
        { result: { records: [{ end_of_day: "2026-01-01", usd: 7.8 }] } },
        NOW,
      ),
    (error) => error instanceof financeFx.FinanceFxError && error.code === "stale_data",
  );
});

test("money displays are consistently rounded to two decimal places", () => {
  assert.equal(
    financeFormat.formatExactMoney({ currency: "USD", minorUnits: "123.45" }),
    "$1.23",
  );
  assert.equal(
    financeFormat.formatExactMoney({ currency: "USD", minorUnits: "0.0001" }),
    "$0.00",
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

test("Anthropic Cost API failures have safe, actionable availability codes", async () => {
  const previousKey = process.env.ANTHROPIC_ADMIN_KEY;
  const previousWorkspace = process.env.ANTHROPIC_WORKSPACE_ID;
  try {
    delete process.env.ANTHROPIC_ADMIN_KEY;
    await assert.rejects(
      () => anthropic.anthropicCostSnapshot(PERIOD, periodModule.FINANCE_LIFETIME_START),
      (error) => error instanceof anthropic.AnthropicCostError && error.code === "not_configured",
    );

    process.env.ANTHROPIC_ADMIN_KEY = "admin-test-key";
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    await assert.rejects(
      () => anthropic.anthropicCostSnapshot(
        PERIOD,
        periodModule.FINANCE_LIFETIME_START,
        async () => Response.json({ error: { type: "permission_error" } }, { status: 403 }),
      ),
      (error) => error instanceof anthropic.AnthropicCostError && error.code === "permission_denied",
    );

    process.env.ANTHROPIC_WORKSPACE_ID = "workspace-test";
    await assert.rejects(
      () => anthropic.anthropicCostSnapshot(
        PERIOD,
        periodModule.FINANCE_LIFETIME_START,
        async () => Response.json({ error: { type: "not_found_error" } }, { status: 404 }),
      ),
      (error) => error instanceof anthropic.AnthropicCostError && error.code === "workspace_rejected",
    );
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_ADMIN_KEY;
    else process.env.ANTHROPIC_ADMIN_KEY = previousKey;
    if (previousWorkspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID;
    else process.env.ANTHROPIC_WORKSPACE_ID = previousWorkspace;
  }
});

test("local actual-token and provider-backfill costs retain their provenance", () => {
  const totals = (cost, calculated, backfill) => ({
    costMinorUnits: cost,
    calculatedCostMinorUnits: calculated,
    providerBackfillCostMinorUnits: backfill,
    inputTokens: "1200",
    outputTokens: "300",
    cacheCreationInputTokens: "0",
    cacheReadInputTokens: "25",
    requestCount: "2",
    backfillRowCount: backfill === "0" ? "0" : "1",
  });
  const snapshot = localCost.parseLocalAiCost(
    {
      source: "local_cost_ledger",
      currency: "USD",
      asOf: "2026-08-12T12:35:00.000Z",
      periodDays: 30,
      coverage: {
        source: "provider_console",
        startsAt: "2026-07-01T00:00:00.000Z",
        historicalComplete: true,
        includesProviderBackfill: true,
      },
      lifetime: totals("12.345", "2.345", "10"),
      period: totals("2.345", "2.345", "0"),
      daily: [
        {
          date: "2026-08-12",
          ...totals("2.345", "2.345", "0"),
        },
      ],
    },
    PERIOD,
  );

  assert.equal(snapshot.source, "local_cost_ledger");
  assert.deepEqual(snapshot.coverage, {
    source: "provider_console",
    startsAt: "2026-07-01T00:00:00.000Z",
    historicalComplete: true,
    includesProviderBackfill: true,
  });
  assert.equal(snapshot.lifetime.cost.minorUnits, "12.345");
  assert.equal(snapshot.lifetime.tokenCost.minorUnits, "2.345");
  assert.equal(snapshot.daily.length, 30);
  assert.equal(snapshot.daily.at(-1).cost.minorUnits, "2.345");
  assert.equal(
    snapshot.byCostType.find((row) => row.costType === "provider_backfill").lifetimeCost.minorUnits,
    "10",
  );
});

test("local AI cost is refused when its provenance totals do not reconcile", () => {
  const invalidTotals = {
    costMinorUnits: "3",
    calculatedCostMinorUnits: "1",
    providerBackfillCostMinorUnits: "1",
    inputTokens: "1",
    outputTokens: "1",
    cacheCreationInputTokens: "0",
    cacheReadInputTokens: "0",
    requestCount: "1",
    backfillRowCount: "1",
  };
  assert.throws(
    () => localCost.parseLocalAiCost(
      {
        source: "local_cost_ledger",
        currency: "USD",
        asOf: "2026-08-12T12:35:00.000Z",
        periodDays: 30,
        coverage: {
          source: null,
          startsAt: null,
          historicalComplete: false,
          includesProviderBackfill: false,
        },
        lifetime: invalidTotals,
        period: invalidTotals,
        daily: [],
      },
      PERIOD,
    ),
    (error) => error instanceof localCost.LocalAiCostError && error.code === "invalid_response",
  );
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
  assert.equal(contribution.basis, "exact");
  assert.equal(contribution.period.contribution.minorUnits, "84.45");

  const locallyCalculated = {
    ...ai,
    source: "local_cost_ledger",
    coverage: {
      source: "local_tracking",
      startsAt: "2026-08-01T00:00:00.000Z",
      historicalComplete: false,
      includesProviderBackfill: false,
    },
  };
  assert.equal(finance.financeContribution(stripe, locallyCalculated), null);

  const hkd = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "hkd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 }],
    [],
    PERIOD,
  );
  assert.equal(finance.financeContribution(hkd, ai), null);
});

test("HKD receipts and USD AI cost produce an explicitly estimated HKMA view", () => {
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
  const fx = financeFx.parseHkmaFx(
    { result: { records: [{ end_of_day: "2026-07-31", usd: 7.842 }] } },
    NOW,
  );
  const estimate = finance.estimatedHkdFinance(stripe, ai, fx);

  assert.equal(estimate.basis, "estimated");
  assert.equal(estimate.fx.asOf, "2026-07-31");
  assert.equal(estimate.lifetime.customerPaid.minorUnits, "100");
  assert.equal(estimate.lifetime.stripeFees.minorUnits, "5");
  assert.equal(estimate.lifetime.received.minorUnits, "95");
  assert.equal(estimate.lifetime.aiCost.minorUnits, "82.7331");
  assert.equal(estimate.lifetime.afterAi.minorUnits, "12.2669");
});

test("an HKMA estimate refuses any settlement currency whose rate is absent", () => {
  const stripe = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "nzd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 }],
    [],
    PERIOD,
  );
  const ai = anthropic.summariseAnthropicCost([], PERIOD, false);
  const fx = financeFx.parseHkmaFx(
    { result: { records: [{ end_of_day: "2026-07-31", usd: 7.842 }] } },
    NOW,
  );
  assert.equal(finance.estimatedHkdFinance(stripe, ai, fx), null);
});

test("AI cost remains visible as a loss before the first Stripe receipt", () => {
  const stripe = stripeFinance.summariseStripeFinance([], [], PERIOD);
  const ai = anthropic.summariseAnthropicCost(
    [{
      startingAt: "2026-08-06T00:00:00Z",
      endingAt: "2026-08-07T00:00:00Z",
      results: [{ amount: "1.25", currency: "USD", costType: "tokens" }],
    }],
    PERIOD,
    false,
  );
  const fx = financeFx.parseHkmaFx(
    { result: { records: [{ end_of_day: "2026-07-31", usd: 7.842 }] } },
    NOW,
  );
  const estimate = finance.estimatedHkdFinance(stripe, ai, fx);
  assert.equal(estimate.period.received.minorUnits, "0");
  assert.equal(estimate.period.aiCost.minorUnits, "9.8025");
  assert.equal(estimate.period.afterAi.minorUnits, "-9.8025");
});

test("stripeCategoryClass recognises every operating and money-movement category, not just the common ones", () => {
  const operating = [
    "charge", "charge_failure", "dispute", "dispute_reversal", "fee",
    "network_cost", "partial_capture_reversal", "platform_earning",
    "platform_earning_refund", "refund", "refund_failure", "revenue_share", "tax",
  ];
  for (const category of operating) {
    assert.equal(stripeFinance.stripeCategoryClass(category), "operating", category);
  }
  const moneyMovement = ["payout", "payout_reversal", "transfer", "transfer_reversal"];
  for (const category of moneyMovement) {
    assert.equal(stripeFinance.stripeCategoryClass(category), "money_movement", category);
  }
  assert.equal(stripeFinance.stripeCategoryClass("something_new"), "unknown");
});

test("a transaction with no reporting category is filed as \"unreported\", not blank", () => {
  const snapshot = stripeFinance.summariseStripeFinance(
    [{ created: utc("2026-08-06T00:00:00Z"), currency: "usd", reportingCategory: "", amountMinor: 5, feeMinor: 0, netMinor: 5 }],
    [],
    PERIOD,
  );
  assert.deepEqual(snapshot.currencies[0].categories.map((c) => c.category), ["unreported"]);
});

test("the finance period is inclusive of its first instant and exclusive of its last", () => {
  const period = {
    days: 2,
    startingAt: "2026-01-10T00:00:00.000Z",
    endingAt: "2026-01-12T00:00:00.000Z",
    timezone: "UTC",
  };
  const startBoundary = Math.floor(Date.parse(period.startingAt) / 1000);
  const endBoundary = Math.floor(Date.parse(period.endingAt) / 1000);
  const snapshot = stripeFinance.summariseStripeFinance(
    [
      // Exactly at the start: must count (inclusive).
      { created: startBoundary, currency: "usd", reportingCategory: "charge", amountMinor: 111, feeMinor: 0, netMinor: 111 },
      // Exactly at the end: must NOT count (exclusive) — this is the instant
      // the *next* period owns.
      { created: endBoundary, currency: "usd", reportingCategory: "charge", amountMinor: 222, feeMinor: 0, netMinor: 222 },
      // Comfortably past the end: must not count either.
      { created: endBoundary + 3600, currency: "usd", reportingCategory: "charge", amountMinor: 444, feeMinor: 0, netMinor: 444 },
    ],
    [],
    period,
  );
  const usd = snapshot.currencies[0];
  assert.equal(usd.period.net.minorUnits, "111", "only the start-boundary transaction is inside the period");
  assert.equal(usd.lifetime.net.minorUnits, "777", "lifetime must still see all three regardless of the window");
});

test("currency and category totals accumulate every transaction, sorted by name rather than by arrival order", () => {
  const snapshot = stripeFinance.summariseStripeFinance(
    [
      // usd arrives before aud, but AUD must sort first.
      { created: utc("2026-08-01T00:00:00Z"), currency: "usd", reportingCategory: "charge", amountMinor: 100, feeMinor: 9, netMinor: 91 },
      // Within AUD: "refund" is encountered before "charge" ever is, but
      // "charge" must still sort first — proving the categories are actually
      // sorted rather than merely listed in the order they were first seen.
      { created: utc("2026-08-02T00:00:00Z"), currency: "aud", reportingCategory: "refund", amountMinor: -10, feeMinor: 0, netMinor: -10 },
      { created: utc("2026-08-03T00:00:00Z"), currency: "aud", reportingCategory: "charge", amountMinor: 50, feeMinor: 2, netMinor: 48 },
      { created: utc("2026-08-04T00:00:00Z"), currency: "aud", reportingCategory: "charge", amountMinor: 20, feeMinor: 1, netMinor: 19 },
    ],
    [],
    PERIOD,
  );

  assert.deepEqual(snapshot.currencies.map((c) => c.currency), ["AUD", "USD"], "currencies must sort alphabetically, not by first appearance");
  const aud = snapshot.currencies[0];
  assert.equal(aud.lifetime.amount.minorUnits, "60", "the currency-level amount must accumulate (-10 + 50 + 20), not overwrite");
  assert.deepEqual(
    aud.categories.map((c) => c.category),
    ["charge", "refund"],
    "categories must sort alphabetically, not by the order they were first seen",
  );
  const chargeCategory = aud.categories.find((c) => c.category === "charge");
  // Two "charge" transactions in the same currency: count, fees and net must
  // each accumulate across both rather than the second silently resetting
  // the first.
  assert.equal(chargeCategory.lifetime.count, 2);
  assert.equal(chargeCategory.lifetime.fees.minorUnits, "3");
  assert.equal(chargeCategory.lifetime.net.minorUnits, "67");
});

test("a transaction inside the period updates its category's period total and its own calendar day", () => {
  const period = {
    days: 3,
    startingAt: "2026-03-01T00:00:00.000Z",
    endingAt: "2026-03-04T00:00:00.000Z",
    timezone: "UTC",
  };
  const snapshot = stripeFinance.summariseStripeFinance(
    [
      { created: utc("2026-03-02T15:00:00Z"), currency: "usd", reportingCategory: "charge", amountMinor: 300, feeMinor: 10, netMinor: 290 },
      { created: utc("2026-03-02T18:00:00Z"), currency: "usd", reportingCategory: "charge", amountMinor: 100, feeMinor: 5, netMinor: 95 },
    ],
    [],
    period,
  );
  const usd = snapshot.currencies[0];
  const charge = usd.categories.find((c) => c.category === "charge");
  assert.equal(charge.period.count, 2, "both in-period transactions must reach the category's period bucket");
  assert.equal(charge.period.amount.minorUnits, "400");

  const day = usd.daily.find((d) => d.day === "2026-03-02");
  assert.ok(day, "2026-03-02 must be one of the period's named days");
  assert.equal(day.operatingAmount.minorUnits, "400", "both transactions on the day must reach the daily bucket");
  assert.equal(day.operatingNet.minorUnits, "385");
  // Every other named day stays untouched.
  const otherDay = usd.daily.find((d) => d.day === "2026-03-01");
  assert.equal(otherDay.operatingAmount.minorUnits, "0");
});

test("paid payouts accumulate their count as well as their amount, split by whether they fall in the period", () => {
  const period = {
    days: 2,
    startingAt: "2026-05-01T00:00:00.000Z",
    endingAt: "2026-05-03T00:00:00.000Z",
    timezone: "UTC",
  };
  const snapshot = stripeFinance.summariseStripeFinance(
    [],
    [
      { arrivalDate: utc("2026-05-01T12:00:00Z"), currency: "usd", amountMinor: 1000 },
      { arrivalDate: utc("2026-05-02T12:00:00Z"), currency: "usd", amountMinor: 2000 },
      // Outside the period, but still lifetime.
      { arrivalDate: utc("2026-01-01T00:00:00Z"), currency: "usd", amountMinor: 500 },
    ],
    period,
  );
  const usd = snapshot.currencies[0];
  assert.equal(usd.lifetimePaidPayouts.count, 3);
  assert.equal(usd.lifetimePaidPayouts.amount.minorUnits, "3500");
  assert.equal(usd.periodPaidPayouts.count, 2, "only the two payouts inside the period must be counted here");
  assert.equal(usd.periodPaidPayouts.amount.minorUnits, "3000");
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

/* -------------------------------------------------------------------------- */
/* billingSnapshot — what is currently being paid, straight from Stripe        */
/* -------------------------------------------------------------------------- */

async function withStripeKey(key, fn) {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = key;
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  }
}

test("billingSnapshot paginates past a full page, tallies active subscriptions by plan, and spreads yearly revenue over its months", () =>
  withStripeKey("sk_test_billing_snapshot", async () => {
    // A full first page (exactly 100) so the "was this page full" check must
    // say "keep going" rather than "that's everyone" — a filler item that
    // charges nothing so it cannot perturb the MRR arithmetic below, and one
    // recognised subscriber on each of two different plans to prove `byPlan`
    // is not just counting the first plan it happens to see.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `sub_page1_${i}`, items: { data: [] } }));
    page1[0] = {
      id: "sub_page1_0",
      items: { data: [{ price: { id: "price_tracking_monthly", unit_amount: tiers.PLANS["tracking-monthly"].amountMinor, recurring: { interval: "month" } } }] },
    };
    page1[1] = {
      id: "sub_page1_1",
      items: { data: [{ price: { id: "price_ai_yearly", unit_amount: tiers.PLANS["ai-yearly"].amountMinor, recurring: { interval: "year" } } }] },
    };
    // The remaining 98 filler items still count toward `active`, at 0 revenue.
    for (let i = 2; i < 100; i += 1) {
      page1[i] = { id: `sub_page1_${i}`, items: { data: [{ price: { id: "price_unrecognised", unit_amount: 0, recurring: { interval: "month" } } }] } };
    }
    // A second, short page — proves pagination actually continued rather than
    // stopping after the first (full) page, and adds a second yearly plan
    // subscriber so byPlan's count can be more than one.
    const page2 = [
      {
        id: "sub_page2_0",
        items: { data: [{ price: { id: "price_ai_yearly", unit_amount: tiers.PLANS["ai-yearly"].amountMinor, recurring: { interval: "year" } } }] },
      },
    ];

    const savedVars = {};
    for (const [name, value] of [
      ["STRIPE_PRICE_TRACKING_MONTHLY", "price_tracking_monthly"],
      ["STRIPE_PRICE_AI_YEARLY", "price_ai_yearly"],
    ]) {
      savedVars[name] = process.env[name];
      process.env[name] = value;
    }
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get("status"), "active");
      assert.equal(parsed.searchParams.get("limit"), "100");
      if (parsed.searchParams.get("starting_after") === "sub_page1_99") {
        return Response.json({ data: page2 });
      }
      assert.equal(parsed.searchParams.has("starting_after"), false, "a starting_after was sent before any page was read");
      return Response.json({ data: page1 });
    };
    try {
      const snapshot = await stripe.billingSnapshot();
      assert.equal(snapshot.active, 101, "pagination did not reach the second page");
      assert.deepEqual(snapshot.byPlan, { "tracking-monthly": 1, "ai-yearly": 2 });
      // 490 (monthly, in full) + 8900/12 twice (yearly, spread over its months).
      const expectedMrrMinor = 490 + 2 * (8900 / 12);
      assert.equal(snapshot.mrrHkd, Math.round(expectedMrrMinor) / 100);
    } finally {
      for (const [name, value] of Object.entries(savedVars)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }));

test("billingSnapshot does not invent a cursor when a full page's last row has no id", () =>
  withStripeKey("sk_test_billing_snapshot_no_cursor", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      // A full (100-row) page, so the length check alone says "keep going" —
      // but the last row carries no id, so there is nothing safe to page from.
      const data = Array.from({ length: 100 }, (_, i) => ({ id: `sub_${i}`, items: { data: [] } }));
      data[99] = { items: { data: [] } };
      return Response.json({ data });
    };
    const snapshot = await stripe.billingSnapshot();
    assert.equal(calls, 1, "a second page was fetched with no real cursor to page from");
    assert.equal(snapshot.active, 100);
  }));

test("billingSnapshot never reads more than 20 pages, even from an account that would keep paginating forever", () =>
  withStripeKey("sk_test_billing_snapshot_cap", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      // Always a full page with fresh ids, so nothing here ever triggers the
      // ordinary "short page" or "no next cursor" endings — only the 20-page
      // safety cap can stop this.
      const data = Array.from({ length: 100 }, (_, i) => ({ id: `sub_${calls}_${i}`, items: { data: [] } }));
      return Response.json({ data });
    };
    const snapshot = await stripe.billingSnapshot();
    assert.equal(calls, 20, `expected exactly 20 requests (the pagination cap), saw ${calls}`);
    assert.equal(snapshot.active, 2000);
  }));

/* -------------------------------------------------------------------------- */
/* stripeDiagnostic                                                            */
/* -------------------------------------------------------------------------- */

test("stripeDiagnostic reports the Worker's own missing key before ever asking Stripe", async () => {
  const savedKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    assert.deepEqual(await stripe.stripeDiagnostic(), {
      ok: false,
      detail: "STRIPE_SECRET_KEY is not set on this Worker",
    });
  } finally {
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  }
});

test("stripeDiagnostic asks exactly one cheap question, and says which mode answered and whether anything is live", () =>
  withStripeKey("sk_test_diagnostic", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return Response.json({ livemode: true, data: [] });
    };
    assert.deepEqual(await stripe.stripeDiagnostic(), {
      ok: true,
      detail: "answers — live mode, no active subscriptions yet",
    });
    assert.equal(urls.at(-1), "https://api.stripe.com/v1/subscriptions?limit=1");

    globalThis.fetch = async () => Response.json({ livemode: false, data: [{ id: "sub_1" }] });
    assert.deepEqual(await stripe.stripeDiagnostic(), {
      ok: true,
      detail: "answers — test mode, subscriptions readable",
    });
  }));

/* -------------------------------------------------------------------------- */
/* financialSnapshot's own readers — validation, pagination, the two safety   */
/* caps                                                                        */
/* -------------------------------------------------------------------------- */

async function runFinancialSnapshot({ balanceHandler, payoutHandler }) {
  return withStripeKey("sk_test_finance_validation", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/balance_transactions")) return balanceHandler(url);
      if (url.pathname.endsWith("/payouts")) return payoutHandler(url);
      throw new Error(`unexpected request ${url}`);
    };
    return stripe.financialSnapshot(PERIOD, periodModule.FINANCE_LIFETIME_START);
  });
}

const emptyBalancePage = () => Response.json({ data: [], has_more: false });
const emptyPayoutPage = () => Response.json({ data: [], has_more: false });

test("every numeric field a balance transaction or a payout answers with must be a safe integer, named when it is not", async () => {
  const goodTxn = { id: "txn_1", created: 1_700_000_000, currency: "usd", reporting_category: "charge", amount: 100, fee: 5, net: 95 };
  const txnCases = [
    ["created", "balance transaction timestamp"],
    ["amount", "balance transaction amount"],
    ["fee", "balance transaction fee"],
    ["net", "balance transaction net"],
  ];
  for (const [field, label] of txnCases) {
    await assert.rejects(
      runFinancialSnapshot({
        balanceHandler: () => Response.json({ data: [{ ...goodTxn, [field]: 1.5 }], has_more: false }),
        payoutHandler: emptyPayoutPage,
      }),
      new RegExp(`Stripe returned an invalid ${label}`),
      `corrupting ${field} on a balance transaction was not caught`,
    );
  }

  const goodPayout = { id: "po_1", currency: "usd", arrival_date: 1_700_000_000, amount: 100 };
  for (const [field, label] of [["arrival_date", "payout arrival date"], ["amount", "payout amount"]]) {
    await assert.rejects(
      runFinancialSnapshot({
        balanceHandler: emptyBalancePage,
        payoutHandler: () => Response.json({ data: [{ ...goodPayout, [field]: 1.5 }], has_more: false }),
      }),
      new RegExp(`Stripe returned an invalid ${label}`),
      `corrupting ${field} on a payout was not caught`,
    );
  }
});

test("body.data that is not an array is refused before anything is read from it", async () => {
  await assert.rejects(
    runFinancialSnapshot({ balanceHandler: () => Response.json({ data: {}, has_more: false }), payoutHandler: emptyPayoutPage }),
    /Stripe returned invalid balance transactions/,
  );
  await assert.rejects(
    runFinancialSnapshot({ balanceHandler: emptyBalancePage, payoutHandler: () => Response.json({ data: null, has_more: false }) }),
    /Stripe returned invalid payouts/,
  );
});

test("a balance transaction without an id or a currency is refused, and its id is named when it has one", async () => {
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: () =>
        Response.json({ data: [{ created: 1, currency: "usd", reporting_category: "charge", amount: 1, fee: 0, net: 1 }], has_more: false }),
      payoutHandler: emptyPayoutPage,
    }),
    /Stripe returned a balance transaction without an id/,
  );
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: () =>
        Response.json({ data: [{ id: "", created: 1, currency: "usd", reporting_category: "charge", amount: 1, fee: 0, net: 1 }], has_more: false }),
      payoutHandler: emptyPayoutPage,
    }),
    /Stripe returned a balance transaction without an id/,
  );
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: () =>
        Response.json({ data: [{ id: "txn_missing_currency", created: 1, reporting_category: "charge", amount: 1, fee: 0, net: 1 }], has_more: false }),
      payoutHandler: emptyPayoutPage,
    }),
    /Stripe returned balance transaction txn_missing_currency without a currency/,
  );
  // Present, but empty — typeof "" === "string" would pass a check that only
  // asked whether currency was a string at all.
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: () =>
        Response.json({ data: [{ id: "txn_empty_currency", created: 1, currency: "", reporting_category: "charge", amount: 1, fee: 0, net: 1 }], has_more: false }),
      payoutHandler: emptyPayoutPage,
    }),
    /Stripe returned balance transaction txn_empty_currency without a currency/,
  );
});

test("a payout without an id or a currency is refused, and its id is named when it has one", async () => {
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: emptyBalancePage,
      payoutHandler: () => Response.json({ data: [{ arrival_date: 1, currency: "usd", amount: 1 }], has_more: false }),
    }),
    /Stripe returned a payout without an id/,
  );
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: emptyBalancePage,
      payoutHandler: () => Response.json({ data: [{ id: "", arrival_date: 1, currency: "usd", amount: 1 }], has_more: false }),
    }),
    /Stripe returned a payout without an id/,
  );
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: emptyBalancePage,
      payoutHandler: () => Response.json({ data: [{ id: "po_missing_currency", arrival_date: 1, amount: 1 }], has_more: false }),
    }),
    /Stripe returned payout po_missing_currency without a currency/,
  );
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: emptyBalancePage,
      payoutHandler: () => Response.json({ data: [{ id: "po_empty_currency", arrival_date: 1, currency: "", amount: 1 }], has_more: false }),
    }),
    /Stripe returned payout po_empty_currency without a currency/,
  );
});

test("balance-transaction pagination continues exactly while has_more is true, and the second page's rows are not dropped", async () => {
  const snapshot = await runFinancialSnapshot({
    balanceHandler: (url) => {
      if (!url.searchParams.has("starting_after")) {
        return Response.json({
          data: [{ id: "txn_a", created: 1, currency: "usd", reporting_category: "charge", amount: 100, fee: 0, net: 100 }],
          has_more: true,
        });
      }
      assert.equal(url.searchParams.get("starting_after"), "txn_a", "the cursor was not the previous page's last id");
      return Response.json({
        data: [{ id: "txn_b", created: 2, currency: "usd", reporting_category: "charge", amount: 50, fee: 0, net: 50 }],
        has_more: false,
      });
    },
    payoutHandler: emptyPayoutPage,
  });
  assert.equal(snapshot.currencies[0].lifetime.net.minorUnits, "150", "the second has_more:true page was never fetched");
});

test("payout pagination continues while has_more is true, and the next cursor is the last row, not the second one", async () => {
  // Three rows on the first page so "the last one" and "the second one" name
  // different ids — a two-row page would make them the same id by accident.
  const snapshot = await runFinancialSnapshot({
    balanceHandler: emptyBalancePage,
    payoutHandler: (url) => {
      if (!url.searchParams.has("starting_after")) {
        return Response.json({
          data: [
            { id: "po_a", currency: "usd", arrival_date: 1, amount: 10 },
            { id: "po_b", currency: "usd", arrival_date: 2, amount: 20 },
            { id: "po_c", currency: "usd", arrival_date: 3, amount: 30 },
          ],
          has_more: true,
        });
      }
      assert.equal(url.searchParams.get("starting_after"), "po_c", "the cursor was not the last row of the previous page");
      return Response.json({ data: [{ id: "po_d", currency: "usd", arrival_date: 4, amount: 40 }], has_more: false });
    },
  });
  assert.equal(snapshot.currencies[0].lifetimePaidPayouts.amount.minorUnits, "100", "the second has_more:true page was never fetched");
});

test("a balance-transaction or payout cursor that fails to advance is refused rather than looped on", async () => {
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: () =>
        Response.json({
          data: [{ id: "txn_stall", created: 1, currency: "usd", reporting_category: "charge", amount: 1, fee: 0, net: 1 }],
          has_more: true,
        }),
      payoutHandler: emptyPayoutPage,
    }),
    /Stripe balance transaction pagination did not advance/,
  );
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: emptyBalancePage,
      payoutHandler: () =>
        Response.json({ data: [{ id: "po_stall", currency: "usd", arrival_date: 1, amount: 1 }], has_more: true }),
    }),
    /Stripe payout pagination did not advance/,
  );
});

test("both readers page in hundreds, and encode the report period as whole Unix seconds", async () => {
  const seen = { balance: null, payout: null };
  await runFinancialSnapshot({
    balanceHandler: (url) => {
      seen.balance = url.searchParams;
      return Response.json({ data: [], has_more: false });
    },
    payoutHandler: (url) => {
      seen.payout = url.searchParams;
      return Response.json({ data: [], has_more: false });
    },
  });
  const startSeconds = String(Math.floor(Date.parse(periodModule.FINANCE_LIFETIME_START) / 1000));
  const endSeconds = String(Math.ceil(Date.parse(PERIOD.endingAt) / 1000));

  assert.equal(seen.balance.get("limit"), "100");
  assert.equal(seen.balance.get("created[gte]"), startSeconds);
  assert.equal(seen.balance.get("created[lt]"), endSeconds);

  assert.equal(seen.payout.get("limit"), "100");
  assert.equal(seen.payout.get("status"), "paid");
  assert.equal(seen.payout.get("arrival_date[gte]"), startSeconds);
  assert.equal(seen.payout.get("arrival_date[lt]"), endSeconds);
});

test("balance-transaction pagination is capped at 10,000 pages, so a runaway has_more cannot loop forever", async () => {
  let calls = 0;
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: () => {
        calls += 1;
        // A safety net for the test itself: if the cap ever failed to fire,
        // this stops the loop quickly with a message that will not match the
        // pattern below, rather than hanging or exhausting memory.
        if (calls > 10_050) throw new Error("test safety net: the 10,000-page cap did not stop pagination");
        return Response.json({
          data: [{ id: `txn_${calls}`, created: calls, currency: "usd", reporting_category: "charge", amount: 1, fee: 0, net: 1 }],
          has_more: true,
        });
      },
      payoutHandler: emptyPayoutPage,
    }),
    /Stripe balance transaction report exceeded 10,000 pages/,
  );
  assert.equal(calls, 10_000, `expected exactly 10,000 requests, saw ${calls}`);
});

test("payout pagination is capped at 10,000 pages, so a runaway has_more cannot loop forever", async () => {
  let calls = 0;
  await assert.rejects(
    runFinancialSnapshot({
      balanceHandler: emptyBalancePage,
      payoutHandler: () => {
        calls += 1;
        if (calls > 10_050) throw new Error("test safety net: the 10,000-page cap did not stop pagination");
        return Response.json({ data: [{ id: `po_${calls}`, currency: "usd", arrival_date: calls, amount: 1 }], has_more: true });
      },
    }),
    /Stripe payout report exceeded 10,000 pages/,
  );
  assert.equal(calls, 10_000, `expected exactly 10,000 requests, saw ${calls}`);
});
