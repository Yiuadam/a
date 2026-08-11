import type { ExactMoney } from "@/lib/admin/finance-types";
import { minorPerUnit } from "@/lib/billing/currency";

/** Provider exact-decimal minor units converted for chart geometry only. */
export function exactMoneyMajor(money: ExactMoney): number {
  const minor = Number(money.minorUnits);
  return Number.isFinite(minor) ? minor / minorPerUnit(money.currency) : 0;
}

export function formatExactMoney(money: ExactMoney): string {
  const value = exactMoneyMajor(money);
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: money.currency.toUpperCase(),
    /* Anthropic reports decimal cents. Keep that provider precision even once
       the total crosses one dollar; switching to two decimals at that point
       made an exact $1.2345 cost look like $1.23. Stripe's integer-minor-unit
       amounts still render normally because Intl does not add optional zeroes. */
    maximumFractionDigits: 8,
  }).format(value);
}

export function zeroMoney(currency: string): ExactMoney {
  return { currency: currency.toUpperCase(), minorUnits: "0" };
}
