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

export interface AnthropicCostCoverage {
  /** Evidence used to establish the included date range. */
  source: "anthropic_cost_api" | "provider_console" | "local_tracking" | null;
  /** Earliest cost included by this source, when it cannot cover all history. */
  startsAt: string | null;
  /** True only when the source covers the full requested lifetime window. */
  historicalComplete: boolean;
  /** Whether provider-billed historical cost has been imported into the ledger. */
  includesProviderBackfill: boolean;
}

export interface AnthropicCostSnapshot {
  source: "anthropic_cost_api" | "local_cost_ledger";
  /** When this cost view was calculated or read. */
  asOf: string;
  coverage: AnthropicCostCoverage;
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
  currency: string;
  basis: "exact";
  lifetime: ContributionAmounts;
  period: ContributionAmounts;
  daily: ContributionDay[];
}

export interface HkdFxSnapshot {
  /** Where `rates` came from. The reference table is a fallback — see `approximate`. */
  source: "Hong Kong Monetary Authority" | "Approximate reference rate";
  /**
   * True when `rates` comes from the fixed reference table (finance-fx.ts)
   * rather than a live HKMA snapshot. A separate, explicit flag rather than a
   * sentinel value in `asOf` or a string comparison against `source`, so a
   * consumer cannot mistake an approximate rate for the day's official one.
   */
  approximate: boolean;
  sourceUrl: string;
  asOf: string;
  /** HKD major units per one major unit of each ISO currency. */
  rates: Record<string, string>;
}

export interface HkdFinanceTotals {
  /** Successful customer charge amounts before refunds and provider fees. */
  customerPaid: ExactMoney;
  stripeFees: ExactMoney;
  /** Operating net after fees, refunds, disputes and other classified activity. */
  received: ExactMoney;
  aiCost: ExactMoney;
  /** `received` less all Anthropic costs; hosting and taxes are not deducted. */
  afterAi: ExactMoney;
}

export interface HkdFinanceDay {
  day: string;
  received: ExactMoney;
  aiCost: ExactMoney;
  afterAi: ExactMoney;
}

/**
 * A current-rate planning view, never provider-exact accounting. Original
 * provider currencies remain available in `stripe` and `anthropic`.
 */
export interface HkdFinanceEstimate {
  currency: "HKD";
  basis: "estimated";
  fx: HkdFxSnapshot;
  lifetime: HkdFinanceTotals;
  period: HkdFinanceTotals;
  daily: HkdFinanceDay[];
}

export type FinanceAvailabilityCode =
  | "not_configured"
  | "authentication_failed"
  | "permission_denied"
  | "workspace_rejected"
  | "provider_unavailable"
  | "invalid_response"
  | "request_rejected"
  | "stale_data";

export interface FinanceAvailabilityReason {
  code: FinanceAvailabilityCode;
  /** Owner-safe copy; never includes a provider response body or secret. */
  message: string;
}

export interface FinanceProviderAvailability {
  configured: boolean;
  available: boolean;
  source:
    | "stripe_balance"
    | "anthropic_cost_api"
    | "local_cost_ledger"
    | "hkma"
    | null;
  reason: FinanceAvailabilityReason | null;
}

export interface FinanceProviderAvailabilityMap {
  stripe: FinanceProviderAvailability;
  anthropic: FinanceProviderAvailability;
  fx: FinanceProviderAvailability;
}

export type ContributionAvailabilityCode =
  | "stripe_unavailable"
  | "anthropic_unavailable"
  | "fx_unavailable"
  | "no_receipts"
  | "unsupported_currency";

export interface ContributionAvailability {
  available: boolean;
  basis: "exact" | "estimated" | null;
  reason: {
    code: ContributionAvailabilityCode;
    message: string;
  } | null;
}

export interface AdminFinanceResponse {
  period: FinancePeriod;
  /** Earliest provider data requested for the lifetime totals. */
  lifetimeStartingAt: string;
  stripeConfigured: boolean;
  anthropicConfigured: boolean;
  providers: FinanceProviderAvailabilityMap;
  stripe: StripeFinancialSnapshot | null;
  anthropic: AnthropicCostSnapshot | null;
  /**
   * Only present when Stripe has exactly one currency matching an authoritative
   * Anthropic Cost Report. No exchange rate or locally calculated bill is used.
   */
  contribution: ContributionSnapshot | null;
  /** Latest official HKMA rate converted planning totals, when available. */
  hkdEstimate: HkdFinanceEstimate | null;
  contributionStatus: ContributionAvailability;
}
