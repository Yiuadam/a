import { addDecimal, normaliseDecimal } from "@/lib/admin/finance-decimal";
import { utcDays } from "@/lib/admin/finance-period";
import type { AdminAiCostSnapshot } from "@/lib/ai/cost-tracking";
import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

const MODULE = "lib/cloudflare/ai-cost-read-authority.ts";
const D1_PAGE_SIZE = 500;
const MAX_D1_COST_EVENTS = 50_000;

type CostSource = "calculated_tokens" | "provider_backfill";

interface CostEventRow {
  id: string;
  source: CostSource;
  cost_usd: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  occurred_at: string;
}

interface CoverageRow {
  source: "provider_console" | "local_tracking";
  starts_at: string;
  historical_complete: number;
}

interface Totals {
  costMinorUnits: string;
  calculatedCostMinorUnits: string;
  providerBackfillCostMinorUnits: string;
  inputTokens: string;
  outputTokens: string;
  cacheCreationInputTokens: string;
  cacheReadInputTokens: string;
  requestCount: string;
  backfillRowCount: string;
  startsAt: string | null;
}

function zeroTotals(startsAt: string | null = null): Totals {
  return {
    costMinorUnits: "0",
    calculatedCostMinorUnits: "0",
    providerBackfillCostMinorUnits: "0",
    inputTokens: "0",
    outputTokens: "0",
    cacheCreationInputTokens: "0",
    cacheReadInputTokens: "0",
    requestCount: "0",
    backfillRowCount: "0",
    startsAt,
  };
}

function validTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`D1 AI-cost ledger returned an invalid ${name}`);
  }
  return new Date(value).toISOString();
}

function validMoney(value: unknown): string {
  if (typeof value !== "string") throw new Error("D1 AI-cost ledger returned an invalid cost");
  let normalized: string;
  try {
    normalized = normaliseDecimal(value);
  } catch {
    throw new Error("D1 AI-cost ledger returned an invalid cost");
  }
  if (normalized.startsWith("-")) throw new Error("D1 AI-cost ledger returned a negative cost");
  return normalized;
}

function validCount(value: unknown, name: string): bigint {
  if (value === null) return BigInt(0);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`D1 AI-cost ledger returned an invalid ${name}`);
  }
  return BigInt(value);
}

function appendRow(totals: Totals, row: CostEventRow): void {
  if (row.source !== "calculated_tokens" && row.source !== "provider_backfill") {
    throw new Error("D1 AI-cost ledger returned an invalid source");
  }
  const cost = validMoney(row.cost_usd);
  validTimestamp(row.occurred_at, "occurrence timestamp");
  totals.costMinorUnits = addDecimal(totals.costMinorUnits, cost);
  if (row.source === "provider_backfill") {
    totals.providerBackfillCostMinorUnits = addDecimal(totals.providerBackfillCostMinorUnits, cost);
    totals.backfillRowCount = (BigInt(totals.backfillRowCount) + BigInt(1)).toString();
    return;
  }

  totals.calculatedCostMinorUnits = addDecimal(totals.calculatedCostMinorUnits, cost);
  totals.inputTokens = (BigInt(totals.inputTokens) + validCount(row.input_tokens, "input tokens")).toString();
  totals.outputTokens = (BigInt(totals.outputTokens) + validCount(row.output_tokens, "output tokens")).toString();
  totals.cacheCreationInputTokens = (
    BigInt(totals.cacheCreationInputTokens)
    + validCount(row.cache_creation_input_tokens, "cache-creation tokens")
  ).toString();
  totals.cacheReadInputTokens = (
    BigInt(totals.cacheReadInputTokens) + validCount(row.cache_read_input_tokens, "cache-read tokens")
  ).toString();
  totals.requestCount = (BigInt(totals.requestCount) + BigInt(1)).toString();
}

function snapshotTotals(totals: Totals) {
  return {
    costMinorUnits: totals.costMinorUnits,
    calculatedCostMinorUnits: totals.calculatedCostMinorUnits,
    providerBackfillCostMinorUnits: totals.providerBackfillCostMinorUnits,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    requestCount: totals.requestCount,
    backfillRowCount: totals.backfillRowCount,
    startsAt: totals.startsAt,
  };
}

/**
 * Builds the same private aggregate shape as the legacy RPC without asking
 * SQLite to sum decimal TEXT into binary floating-point values. D1 returns
 * the individual decimal values; BandUp adds them with exact decimal
 * arithmetic and the integer counters with BigInt.
 */
export function summarizeCloudflareAiCostLedger(
  rows: readonly CostEventRow[],
  coverage: CoverageRow | null,
  days: number,
  asOf = new Date(),
): AdminAiCostSnapshot {
  assertServerOnly(MODULE);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("AI-cost ledger period must be between 1 and 366 days");
  }
  const asOfTimestamp = validTimestamp(asOf.toISOString(), "as-of timestamp");
  const periodStart = new Date(Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate() - (days - 1),
  ));
  const expectedDays = utcDays({
    days,
    startingAt: periodStart.toISOString(),
    endingAt: asOfTimestamp,
    timezone: "UTC",
  });
  const daily = new Map(expectedDays.map((day) => [day, zeroTotals()]));
  const lifetime = zeroTotals(coverage ? validTimestamp(coverage.starts_at, "coverage start") : null);
  const period = zeroTotals(lifetime.startsAt);
  let includesProviderBackfill = false;

  for (const row of rows) {
    appendRow(lifetime, row);
    if (row.source === "provider_backfill") includesProviderBackfill = true;
    const occurredAt = validTimestamp(row.occurred_at, "occurrence timestamp");
    if (Date.parse(occurredAt) < Date.parse(periodStart.toISOString()) || Date.parse(occurredAt) > Date.parse(asOfTimestamp)) {
      continue;
    }
    appendRow(period, row);
    const day = occurredAt.slice(0, 10);
    const dailyTotals = daily.get(day);
    if (dailyTotals) appendRow(dailyTotals, row);
  }

  const coverageValid = coverage
    && (coverage.source === "provider_console" || coverage.source === "local_tracking")
    && (coverage.historical_complete === 0 || coverage.historical_complete === 1);
  if (coverage && !coverageValid) throw new Error("D1 AI-cost ledger returned invalid coverage");
  return {
    source: "local_cost_ledger",
    currency: "USD",
    asOf: asOfTimestamp,
    periodDays: days,
    coverage: {
      source: coverage?.source ?? null,
      startsAt: coverage ? validTimestamp(coverage.starts_at, "coverage start") : null,
      historicalComplete: coverage?.historical_complete === 1,
      includesProviderBackfill,
    },
    lifetime: snapshotTotals(lifetime),
    period: snapshotTotals(period),
    daily: expectedDays.map((date) => ({ date, ...snapshotTotals(daily.get(date) ?? zeroTotals()) })),
  };
}

async function allCostRows(bindings: BandUpCloudflareBindings): Promise<CostEventRow[]> {
  const rows: CostEventRow[] = [];
  let offset = 0;
  while (true) {
    const page = await bindings.db.prepare(`
      SELECT id, source, cost_usd, input_tokens, output_tokens,
             cache_creation_input_tokens, cache_read_input_tokens, occurred_at
        FROM ai_cost_events
       ORDER BY occurred_at ASC, id ASC
       LIMIT ? OFFSET ?
    `).bind(D1_PAGE_SIZE, offset).all<CostEventRow>();
    rows.push(...page.results);
    if (rows.length > MAX_D1_COST_EVENTS) {
      throw new Error("D1 AI-cost ledger is too large for an exact owner snapshot");
    }
    if (page.results.length < D1_PAGE_SIZE) return rows;
    offset += page.results.length;
  }
}

/** Exact owner-only D1 reader for the local AI-cost ledger. */
export async function readCloudflareAdminAiCostSnapshot(
  days = 30,
  providedBindings?: BandUpCloudflareBindings,
): Promise<AdminAiCostSnapshot> {
  assertServerOnly(MODULE);
  const requestedDays = Number.isFinite(days) ? Math.trunc(days) : 30;
  const boundedDays = Math.min(Math.max(requestedDays, 1), 366);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const [rows, coverage] = await Promise.all([
    allCostRows(bindings),
    bindings.db.prepare(`
      SELECT source, starts_at, historical_complete FROM ai_cost_coverage
       WHERE singleton = 1
    `).first<CoverageRow>(),
  ]);
  return summarizeCloudflareAiCostLedger(rows, coverage, boundedDays);
}
