import type { FinancePeriod } from "./finance-types";

export const FINANCE_DAYS = 30;
export const FINANCE_LIFETIME_START = "2025-01-01T00:00:00.000Z";

/** A rolling 30-calendar-day UTC window, including the current partial day. */
export function financePeriod(
  now: Date = new Date(),
  days: number = FINANCE_DAYS,
): FinancePeriod {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("Finance period days must be an integer from 1 to 366");
  }
  const endingAt = new Date(now);
  if (Number.isNaN(endingAt.getTime())) throw new Error("Invalid finance period end");

  const startingAt = new Date(Date.UTC(
    endingAt.getUTCFullYear(),
    endingAt.getUTCMonth(),
    endingAt.getUTCDate() - (days - 1),
  ));
  return {
    days,
    startingAt: startingAt.toISOString(),
    endingAt: endingAt.toISOString(),
    timezone: "UTC",
  };
}

export function utcDays(period: FinancePeriod): string[] {
  const out: string[] = [];
  const cursor = new Date(period.startingAt);
  for (let index = 0; index < period.days; index += 1) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
