/*
  Client-safe types for the owner's finance dashboard.

  Money is carried as a decimal string in the provider's smallest currency
  unit. Stripe amounts are whole minor units (for example cents); Anthropic
  can report fractional cents. Keeping the string avoids rounding money in a
  JSON number before the dashboard has even rendered it.
*/

export interface ExactMoney {
  /** Upper-case ISO currency code. */
  currency: string;
  /** Exact decimal amount in the currency's minor unit. */
  minorUnits: string;
}

export interface FinancePeriod {
  days: number;
  startingAt: string;
  endingAt: string;
  timezone: "UTC";
}

export type StripeCategoryClass = "operating" | "money_movement" | "unknown";

export interface StripeAmounts {
  amount: ExactMoney;
  fees: ExactMoney;
  net: ExactMoney;
  /** Unclassified activity, deliberately not folded into operating net. */
  unknownNet: ExactMoney;
}

export interface StripePayoutTotals {
  amount: ExactMoney;
  count: number;
}

export interface StripeCategoryAmounts {
  count: number;
  amount: ExactMoney;
  fees: ExactMoney;
  net: ExactMoney;
}

export interface StripeCategoryTotal {
  category: string;
  classification: StripeCategoryClass;
  lifetime: StripeCategoryAmounts;
  period: StripeCategoryAmounts;
}

export interface StripeFinanceDay {
  day: string;
  operatingAmount: ExactMoney;
  operatingFees: ExactMoney;
  operatingNet: ExactMoney;
  unknownNet: ExactMoney;
}

export interface StripeCurrencyFinance {
  currency: string;
  lifetime: StripeAmounts;
  period: StripeAmounts;
  lifetimePaidPayouts: StripePayoutTotals;
  periodPaidPayouts: StripePayoutTotals;
  categories: StripeCategoryTotal[];
  daily: StripeFinanceDay[];
}

export interface StripeFinancialSnapshot {
  currencies: StripeCurrencyFinance[];
}

export interface AnthropicCostTotals {
  /** All Anthropic API costs returned by the Cost Report. */
  cost: ExactMoney;
  /** The token-only subset; tool costs remain visible in `cost`. */
  tokenCost: ExactMoney;
}

export interface AnthropicCostDay extends AnthropicCostTotals {
  day: string;
}

export interface AnthropicCostTypeTotal {
  costType: string;
  lifetimeCost: ExactMoney;
  periodCost: ExactMoney;
}

export interface AnthropicCostSnapshot {
  lifetime: AnthropicCostTotals;
  period: AnthropicCostTotals;
  daily: AnthropicCostDay[];
  byCostType: AnthropicCostTypeTotal[];
  workspaceFiltered: boolean;
}

export interface ContributionAmounts {
  receipts: ExactMoney;
  aiCost: ExactMoney;
  contribution: ExactMoney;
}

export interface ContributionDay extends ContributionAmounts {
  day: string;
}

export interface ContributionSnapshot {
  currency: "USD";
  lifetime: ContributionAmounts;
  period: ContributionAmounts;
  daily: ContributionDay[];
}

export interface AdminFinanceResponse {
  period: FinancePeriod;
  /** Earliest provider data requested for the lifetime totals. */
  lifetimeStartingAt: string;
  stripeConfigured: boolean;
  anthropicConfigured: boolean;
  stripe: StripeFinancialSnapshot | null;
  anthropic: AnthropicCostSnapshot | null;
  /**
   * Only present when Stripe has exactly one currency and it is USD, matching
   * Anthropic's billing currency. No exchange rate is guessed.
   */
  contribution: ContributionSnapshot | null;
}
