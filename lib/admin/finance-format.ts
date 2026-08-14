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
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function zeroMoney(currency: string): ExactMoney {
  return { currency: currency.toUpperCase(), minorUnits: "0" };
}
