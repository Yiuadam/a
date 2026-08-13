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
