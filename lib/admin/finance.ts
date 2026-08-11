import { minorPerUnit } from "@/lib/billing/currency";
import { addDecimal, multiplyDecimal, subtractDecimal } from "./finance-decimal";
import { grossCustomerPayments } from "./finance-view";
import type {
  AnthropicCostSnapshot,
  ContributionAmounts,
  ContributionSnapshot,
  ExactMoney,
  HkdFinanceEstimate,
  HkdFinanceTotals,
  HkdFxSnapshot,
  StripeFinancialSnapshot,
} from "./finance-types";

function money(currency: string, value: string): ExactMoney {
  return { currency: currency.toUpperCase(), minorUnits: value };
}

function amounts(currency: string, receipts: string, aiCost: string): ContributionAmounts {
  return {
    receipts: money(currency, receipts),
    aiCost: money(currency, aiCost),
    contribution: money(currency, subtractDecimal(receipts, aiCost)),
  };
}

/**
 * Provider-exact net receipts less Anthropic costs, only when both providers
 * already report the same currency. No exchange rate is guessed here.
 */
export function financeContribution(
  stripe: StripeFinancialSnapshot | null,
  anthropic: AnthropicCostSnapshot | null,
): ContributionSnapshot | null {
  if (
    !stripe ||
    !anthropic ||
    anthropic.source !== "anthropic_cost_api" ||
    stripe.currencies.length !== 1
  ) {
    return null;
  }
  const stripeCurrency = stripe.currencies[0];
  const currency = stripeCurrency.currency.toUpperCase();
  if (
    anthropic.lifetime.cost.currency.toUpperCase() !== currency ||
    anthropic.period.cost.currency.toUpperCase() !== currency
  ) {
    return null;
  }

  const anthropicDays = new Map(anthropic.daily.map((row) => [row.day, row.cost.minorUnits]));
  return {
    currency,
    basis: "exact",
    lifetime: amounts(
      currency,
      stripeCurrency.lifetime.net.minorUnits,
      anthropic.lifetime.cost.minorUnits,
    ),
    period: amounts(
      currency,
      stripeCurrency.period.net.minorUnits,
      anthropic.period.cost.minorUnits,
    ),
    daily: stripeCurrency.daily.map((row) => ({
      day: row.day,
      ...amounts(currency, row.operatingNet.minorUnits, anthropicDays.get(row.day) ?? "0"),
    })),
  };
}

/** Convert provider minor units to estimated HKD minor units at one HKMA rate. */
export function estimateMoneyInHkd(
  value: ExactMoney,
  fx: HkdFxSnapshot,
): ExactMoney | null {
  const currency = value.currency.toUpperCase();
  const rate = fx.rates[currency];
  if (!rate) return null;

  let converted = multiplyDecimal(value.minorUnits, rate);
  const sourceMinorPerUnit = minorPerUnit(currency);
  if (sourceMinorPerUnit === 1) {
    converted = multiplyDecimal(converted, "100");
  } else if (sourceMinorPerUnit !== 100) {
    return null;
  }
  return money("HKD", converted);
}

function sumInHkd(values: ExactMoney[], fx: HkdFxSnapshot): ExactMoney | null {
  const converted = values.map((value) => estimateMoneyInHkd(value, fx));
  if (converted.some((value) => value === null)) return null;
  return money("HKD", addDecimal(...converted.map((value) => value?.minorUnits ?? "0")));
}

function hkdTotals(
  stripe: StripeFinancialSnapshot,
  anthropic: AnthropicCostSnapshot,
  fx: HkdFxSnapshot,
  range: "lifetime" | "period",
): HkdFinanceTotals | null {
  const customerPaid = sumInHkd(
    stripe.currencies.map((currency) => grossCustomerPayments(currency, range)),
    fx,
  );
  const stripeFees = sumInHkd(
    stripe.currencies.map((currency) => currency[range].fees),
    fx,
  );
  const received = sumInHkd(
    stripe.currencies.map((currency) => currency[range].net),
    fx,
  );
  const aiCost = estimateMoneyInHkd(anthropic[range].cost, fx);
  if (!customerPaid || !stripeFees || !received || !aiCost) return null;

  return {
    customerPaid,
    stripeFees,
    received,
    aiCost,
    afterAi: money("HKD", subtractDecimal(received.minorUnits, aiCost.minorUnits)),
  };
}

/**
 * Convert every provider currency to HKD using the latest official HKMA
 * closing middle rates. This is deliberately marked estimated: applying one
 * current rate to historical totals is a planning view, not accounting FX.
 */
export function estimatedHkdFinance(
  stripe: StripeFinancialSnapshot | null,
  anthropic: AnthropicCostSnapshot | null,
  fx: HkdFxSnapshot | null,
): HkdFinanceEstimate | null {
  if (!stripe || !anthropic || !fx) return null;
  const lifetime = hkdTotals(stripe, anthropic, fx, "lifetime");
  const period = hkdTotals(stripe, anthropic, fx, "period");
  if (!lifetime || !period) return null;

  const daily = anthropic.daily.map((costRow) => {
    const received = sumInHkd(
      stripe.currencies.map((currency) => {
        const row = currency.daily.find((candidate) => candidate.day === costRow.day);
        return row?.operatingNet ?? money(currency.currency, "0");
      }),
      fx,
    );
    const aiCost = estimateMoneyInHkd(costRow.cost, fx);
    if (!received || !aiCost) return null;
    return {
      day: costRow.day,
      received,
      aiCost,
      afterAi: money("HKD", subtractDecimal(received.minorUnits, aiCost.minorUnits)),
    };
  });
  if (daily.some((row) => row === null)) return null;

  return {
    currency: "HKD",
    basis: "estimated",
    fx,
    lifetime,
    period,
    daily: daily.filter((row): row is NonNullable<typeof row> => row !== null),
  };
}
