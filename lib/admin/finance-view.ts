import { exactMoneyMajor } from "@/lib/admin/finance-format";
import type { AnthropicCostSnapshot, ExactMoney, StripeCurrencyFinance } from "@/lib/admin/finance-types";
import { addDecimal } from "@/lib/admin/finance-decimal";

/** A disclosed planning rate, never presented as provider-exact accounting. */
export const USD_TO_HKD_ESTIMATE = 7.8;

/* Stripe initially records some asynchronous or separately-captured payments
   as `charge`, then offsets the amount in one of these two categories when the
   payment fails or part of the authorisation is never captured. Gross customer
   payments must include those offsets or it reports money never received. */
const GROSS_PAYMENT_CATEGORIES = new Set([
  "charge",
  "charge_failure",
  "partial_capture_reversal",
]);

export function grossCustomerPayments(
  stripe: StripeCurrencyFinance,
  range: "lifetime" | "period",
): ExactMoney {
  return {
    currency: stripe.currency,
    minorUnits: addDecimal(
      ...stripe.categories
        .filter((row) => GROSS_PAYMENT_CATEGORIES.has(row.category))
        .map((row) => row[range].amount.minorUnits),
    ),
  };
}

export function estimatedHkdContribution(
  stripe: StripeCurrencyFinance,
  anthropic: AnthropicCostSnapshot,
  range: "lifetime" | "period",
): { total: ExactMoney; daily: Array<{ day: string; value: number }> } | null {
  if (stripe.currency.toUpperCase() !== "HKD" || anthropic[range].cost.currency.toUpperCase() !== "USD") return null;

  const total = exactMoneyMajor(stripe[range].net) - exactMoneyMajor(anthropic[range].cost) * USD_TO_HKD_ESTIMATE;
  const costs = new Map(anthropic.daily.map((row) => [row.day, exactMoneyMajor(row.cost)]));
  return {
    total: { currency: "HKD", minorUnits: String(total * 100) },
    daily: stripe.daily.map((row) => ({
      day: row.day,
      value: exactMoneyMajor(row.operatingNet) - (costs.get(row.day) ?? 0) * USD_TO_HKD_ESTIMATE,
    })),
  };
}
