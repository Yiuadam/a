import { assertServerOnly } from "@/lib/auth/server-only";
import { normaliseDecimal } from "./finance-decimal";
import type { HkdFxSnapshot } from "./finance-types";

const MODULE = "lib/admin/finance-fx.ts";

export const HKMA_FX_API_URL =
  "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily";
export const HKMA_FX_SOURCE_URL =
  "https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily/";

const MAX_AGE_DAYS = 45;
const CACHE_MS = 60 * 60 * 1_000;

export type FinanceFxErrorCode = "provider_unavailable" | "invalid_response" | "stale_data";

export class FinanceFxError extends Error {
  readonly code: FinanceFxErrorCode;

  constructor(code: FinanceFxErrorCode, message: string) {
    super(message);
    this.name = "FinanceFxError";
    this.code = code;
  }
}

let cached: { until: number; value: HkdFxSnapshot } | null = null;

function rateDecimal(value: unknown): string | null {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number) || number <= 0 || number >= 1_000_000) return null;
  /* The API serialises decimal source data as JSON numbers, so values such as
     7.842 can arrive as 7.8420000000000005. Eight published decimal places is
     more than enough for this planning estimate and removes binary noise. */
  return normaliseDecimal(number.toFixed(8));
}

export function parseHkmaFx(payload: unknown, now: Date = new Date()): HkdFxSnapshot {
  if (!payload || typeof payload !== "object") {
    throw new FinanceFxError("invalid_response", "HKMA returned an invalid response");
  }
  const result = (payload as { result?: unknown }).result;
  const records =
    result && typeof result === "object" ? (result as { records?: unknown }).records : null;
  if (!Array.isArray(records) || !records[0] || typeof records[0] !== "object") {
    throw new FinanceFxError("invalid_response", "HKMA returned no exchange-rate record");
  }

  const record = records[0] as Record<string, unknown>;
  const asOf = record.end_of_day;
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new FinanceFxError("invalid_response", "HKMA returned an invalid exchange-rate date");
  }
  const asOfMillis = Date.parse(`${asOf}T23:59:59.999Z`);
  const nowMillis = now.getTime();
  if (!Number.isFinite(nowMillis) || !Number.isFinite(asOfMillis)) {
    throw new FinanceFxError("invalid_response", "HKMA returned an invalid exchange-rate date");
  }
  const ageDays = (nowMillis - asOfMillis) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS || ageDays < -2) {
    throw new FinanceFxError("stale_data", "HKMA's latest exchange rate is not current enough");
  }

  const rates: Record<string, string> = { HKD: "1" };
  for (const [key, value] of Object.entries(record)) {
    if (!/^[a-z]{3}$/.test(key)) continue;
    const rate = rateDecimal(value);
    if (rate) rates[key.toUpperCase()] = rate;
  }
  if (!rates.USD) {
    throw new FinanceFxError("invalid_response", "HKMA returned no USD/HKD exchange rate");
  }

  return {
    source: "Hong Kong Monetary Authority",
    approximate: false,
    sourceUrl: HKMA_FX_SOURCE_URL,
    asOf,
    rates,
  };
}

/** Latest official HKMA closing middle rates, cached for one hour per isolate. */
export async function hkmaFxSnapshot(
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<HkdFxSnapshot> {
  assertServerOnly(MODULE);
  if (cached && cached.until > now.getTime()) return cached.value;

  let response: Response;
  try {
    response = await fetcher(`${HKMA_FX_API_URL}?pagesize=1`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "BandUp/1.0 (https://bandup.life)" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new FinanceFxError(
      "provider_unavailable",
      `HKMA exchange-rate request failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  if (!response.ok) {
    throw new FinanceFxError(
      "provider_unavailable",
      `HKMA exchange-rate request returned ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FinanceFxError("invalid_response", "HKMA exchange-rate response was not JSON");
  }

  const value = parseHkmaFx(payload, now);
  cached = { value, until: now.getTime() + CACHE_MS };
  return value;
}

/*
  Approximate HKD-per-major-unit reference rates.

  These are round, long-run approximations — deliberately simple so a human
  glancing at "7.8" can correct it by eye later rather than needing to reverse
  a formula. HKD is pegged to USD at roughly 7.8, which is why that one holds
  steadiest; every other currency drifts against it over time, and this table
  is not refreshed automatically the way the live HKMA feed is.

  They exist for exactly one job: letting the owner's dashboard still show a
  clearly labelled, indicative HKD total when the live rate cannot be
  fetched. They must NEVER be used for anything that charges a customer —
  Stripe and Adaptive Pricing already settle at the real rate, and this table
  is not accurate enough to stand in for that.
*/
const REFERENCE_HKD_PER_UNIT: Record<string, number> = {
  USD: 7.8,
  EUR: 8.5,
  GBP: 9.9,
  CNY: 1.08,
  JPY: 0.052,
  AUD: 5.1,
  CAD: 5.7,
  SGD: 5.8,
  NZD: 4.7,
  CHF: 8.8,
  HKD: 1,
};

/**
 * A fixed-table HKD snapshot, for use only when the live HKMA feed in
 * `hkmaFxSnapshot` above is unavailable. Built through the same
 * `rateDecimal`/`normaliseDecimal` formatting the live parser uses, so a
 * reference rate and a live rate are indistinguishable in shape — only
 * `approximate` tells them apart.
 */
export function referenceHkdFxSnapshot(now: Date = new Date()): HkdFxSnapshot {
  const rates: Record<string, string> = {};
  for (const [currency, perUnit] of Object.entries(REFERENCE_HKD_PER_UNIT)) {
    const rate = rateDecimal(perUnit);
    if (rate) rates[currency] = rate;
  }
  return {
    source: "Approximate reference rate",
    approximate: true,
    sourceUrl: HKMA_FX_SOURCE_URL,
    asOf: now.toISOString().slice(0, 10),
    rates,
  };
}
