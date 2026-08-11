import { subtractDecimal } from "./finance-decimal";
import type {
  AnthropicCostSnapshot,
  ContributionAmounts,
  ContributionSnapshot,
  ExactMoney,
  StripeFinancialSnapshot,
} from "./finance-types";

function usd(value: string): ExactMoney {
  return { currency: "USD", minorUnits: value };
}

function amounts(receipts: string, aiCost: string): ContributionAmounts {
  return {
    receipts: usd(receipts),
    aiCost: usd(aiCost),
    contribution: usd(subtractDecimal(receipts, aiCost)),
  };
}

/**
 * Net receipts less Anthropic costs, only when no currency conversion is
 * required. A missing provider or a non-USD/multi-currency Stripe account is
 * intentionally `null`, never an estimate based on a stale FX constant.
 */
export function financeContribution(
  stripe: StripeFinancialSnapshot | null,
  anthropic: AnthropicCostSnapshot | null,
): ContributionSnapshot | null {
  if (!stripe || !anthropic || stripe.currencies.length !== 1) return null;
  const stripeCurrency = stripe.currencies[0];
  if (stripeCurrency.currency !== "USD") return null;

  const anthropicDays = new Map(anthropic.daily.map((row) => [row.day, row.cost.minorUnits]));
  return {
    currency: "USD",
    lifetime: amounts(
      stripeCurrency.lifetime.net.minorUnits,
      anthropic.lifetime.cost.minorUnits,
    ),
    period: amounts(
      stripeCurrency.period.net.minorUnits,
      anthropic.period.cost.minorUnits,
    ),
    daily: stripeCurrency.daily.map((row) => ({
      day: row.day,
      ...amounts(row.operatingNet.minorUnits, anthropicDays.get(row.day) ?? "0"),
    })),
  };
}
