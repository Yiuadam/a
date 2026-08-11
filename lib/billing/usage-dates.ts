/**
 * The first instant at which one used request leaves the rolling allowance.
 * There is deliberately no whole-account reset date: each request returns
 * independently after `windowSeconds`.
 */
export function nextUsageReturnAt(
  oldestAt: string | null,
  windowSeconds: number,
): number | null {
  if (!oldestAt || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  const oldest = Date.parse(oldestAt);
  if (!Number.isFinite(oldest)) return null;
  return oldest + windowSeconds * 1000;
}

/** Browser-local wording for a date the learner can plan around. */
export function formatUsageDate(
  timestamp: number,
  locale?: string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(timestamp));
}

/** Compact wording for the bill-and-usage menu. */
export function formatUsageDateShort(
  timestamp: number,
  locale?: string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(timestamp));
}
