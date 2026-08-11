import type {
  ExactMoney,
  FinancePeriod,
  StripeAmounts,
  StripeCategoryAmounts,
  StripeCategoryClass,
  StripeCurrencyFinance,
  StripeFinancialSnapshot,
  StripePayoutTotals,
} from "@/lib/admin/finance-types";
import { utcDays } from "@/lib/admin/finance-period";

/*
  Categories that describe customer receipts and their direct deductions.

  Stripe recommends `reporting_category` rather than `type` for accounting.
  The list is intentionally explicit: when Stripe adds a category, silently
  calling it revenue is worse than showing it under Unknown until reviewed.
*/
const OPERATING_CATEGORIES = new Set([
  "charge",
  "charge_failure",
  "dispute",
  "dispute_reversal",
  "fee",
  "network_cost",
  "partial_capture_reversal",
  "platform_earning",
  "platform_earning_refund",
  "refund",
  "refund_failure",
  "revenue_share",
  "tax",
]);

/* Payouts and Connect transfers move already-counted funds; neither is new
   operating income. Paid bank payouts are fetched independently. */
const MONEY_MOVEMENT_CATEGORIES = new Set([
  "payout",
  "payout_reversal",
  "transfer",
  "transfer_reversal",
]);

export function stripeCategoryClass(category: string): StripeCategoryClass {
  if (OPERATING_CATEGORIES.has(category)) return "operating";
  if (MONEY_MOVEMENT_CATEGORIES.has(category)) return "money_movement";
  return "unknown";
}

export interface StripeFinanceTransaction {
  created: number;
  currency: string;
  reportingCategory: string;
  amountMinor: number;
  feeMinor: number;
  netMinor: number;
}

export interface StripePaidPayout {
  arrivalDate: number;
  currency: string;
  amountMinor: number;
}

interface MutableAmounts {
  amount: bigint;
  fees: bigint;
  net: bigint;
  unknownNet: bigint;
}

interface MutableCategoryAmounts {
  count: number;
  amount: bigint;
  fees: bigint;
  net: bigint;
}

interface MutableCategory {
  classification: StripeCategoryClass;
  lifetime: MutableCategoryAmounts;
  period: MutableCategoryAmounts;
}

interface MutablePayouts {
  amount: bigint;
  count: number;
}

interface MutableCurrency {
  lifetime: MutableAmounts;
  period: MutableAmounts;
  lifetimePayouts: MutablePayouts;
  periodPayouts: MutablePayouts;
  categories: Map<string, MutableCategory>;
  days: Map<string, MutableAmounts>;
}

const ZERO = BigInt(0);
const amounts = (): MutableAmounts => ({ amount: ZERO, fees: ZERO, net: ZERO, unknownNet: ZERO });
const categoryAmounts = (): MutableCategoryAmounts => ({
  count: 0,
  amount: ZERO,
  fees: ZERO,
  net: ZERO,
});
const payouts = (): MutablePayouts => ({ amount: ZERO, count: 0 });

function money(currency: string, value: bigint): ExactMoney {
  return { currency, minorUnits: value.toString() };
}

function finishAmounts(currency: string, value: MutableAmounts): StripeAmounts {
  return {
    amount: money(currency, value.amount),
    fees: money(currency, value.fees),
    net: money(currency, value.net),
    unknownNet: money(currency, value.unknownNet),
  };
}

function finishCategory(currency: string, value: MutableCategoryAmounts): StripeCategoryAmounts {
  return {
    count: value.count,
    amount: money(currency, value.amount),
    fees: money(currency, value.fees),
    net: money(currency, value.net),
  };
}

function finishPayouts(currency: string, value: MutablePayouts): StripePayoutTotals {
  return { amount: money(currency, value.amount), count: value.count };
}

function inPeriod(created: number, period: FinancePeriod): boolean {
  const millis = created * 1000;
  return millis >= Date.parse(period.startingAt) && millis < Date.parse(period.endingAt);
}

function addTransaction(target: MutableAmounts, transaction: StripeFinanceTransaction, classification: StripeCategoryClass) {
  if (classification === "operating") {
    target.amount += BigInt(transaction.amountMinor);
    target.fees += BigInt(transaction.feeMinor);
    target.net += BigInt(transaction.netMinor);
  } else if (classification === "unknown") {
    target.unknownNet += BigInt(transaction.netMinor);
  }
}

function addCategory(target: MutableCategoryAmounts, transaction: StripeFinanceTransaction) {
  target.count += 1;
  target.amount += BigInt(transaction.amountMinor);
  target.fees += BigInt(transaction.feeMinor);
  target.net += BigInt(transaction.netMinor);
}

/**
 * Produces lifetime totals and a fixed UTC reporting window without ever
 * combining currencies or folding an unrecognised category into revenue.
 */
export function summariseStripeFinance(
  transactions: StripeFinanceTransaction[],
  paidPayouts: StripePaidPayout[],
  period: FinancePeriod,
): StripeFinancialSnapshot {
  const byCurrency = new Map<string, MutableCurrency>();
  const dayNames = utcDays(period);

  const currencyState = (rawCurrency: string): MutableCurrency => {
    const currency = rawCurrency.toUpperCase();
    let state = byCurrency.get(currency);
    if (!state) {
      state = {
        lifetime: amounts(),
        period: amounts(),
        lifetimePayouts: payouts(),
        periodPayouts: payouts(),
        categories: new Map(),
        days: new Map(dayNames.map((day) => [day, amounts()])),
      };
      byCurrency.set(currency, state);
    }
    return state;
  };

  for (const transaction of transactions) {
    const state = currencyState(transaction.currency);
    const category = transaction.reportingCategory || "unreported";
    const classification = stripeCategoryClass(category);
    let categoryState = state.categories.get(category);
    if (!categoryState) {
      categoryState = { classification, lifetime: categoryAmounts(), period: categoryAmounts() };
      state.categories.set(category, categoryState);
    }

    addTransaction(state.lifetime, transaction, classification);
    addCategory(categoryState.lifetime, transaction);

    if (inPeriod(transaction.created, period)) {
      addTransaction(state.period, transaction, classification);
      addCategory(categoryState.period, transaction);
      const day = new Date(transaction.created * 1000).toISOString().slice(0, 10);
      const daily = state.days.get(day);
      if (daily) addTransaction(daily, transaction, classification);
    }
  }

  for (const payout of paidPayouts) {
    const state = currencyState(payout.currency);
    state.lifetimePayouts.amount += BigInt(payout.amountMinor);
    state.lifetimePayouts.count += 1;
    if (inPeriod(payout.arrivalDate, period)) {
      state.periodPayouts.amount += BigInt(payout.amountMinor);
      state.periodPayouts.count += 1;
    }
  }

  const currencies: StripeCurrencyFinance[] = [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, state]) => ({
      currency,
      lifetime: finishAmounts(currency, state.lifetime),
      period: finishAmounts(currency, state.period),
      lifetimePaidPayouts: finishPayouts(currency, state.lifetimePayouts),
      periodPaidPayouts: finishPayouts(currency, state.periodPayouts),
      categories: [...state.categories.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, value]) => ({
          category,
          classification: value.classification,
          lifetime: finishCategory(currency, value.lifetime),
          period: finishCategory(currency, value.period),
        })),
      daily: dayNames.map((day) => {
        const value = state.days.get(day) ?? amounts();
        return {
          day,
          operatingAmount: money(currency, value.amount),
          operatingFees: money(currency, value.fees),
          operatingNet: money(currency, value.net),
          unknownNet: money(currency, value.unknownNet),
        };
      }),
    }));

  return { currencies };
}
