import { addDecimal, normaliseDecimal } from "./finance-decimal";
import { utcDays } from "./finance-period";
import type {
  AnthropicCostDay,
  AnthropicCostSnapshot,
  AnthropicCostTotals,
  ExactMoney,
  FinancePeriod,
} from "./finance-types";

export type LocalAiCostErrorCode = "provider_unavailable" | "invalid_response";

export class LocalAiCostError extends Error {
  readonly code: LocalAiCostErrorCode;

  constructor(code: LocalAiCostErrorCode, message: string) {
    super(message);
    this.name = "LocalAiCostError";
    this.code = code;
  }
}

interface LedgerTotals {
  cost: string;
  calculatedCost: string;
  providerBackfillCost: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalAiCostError("invalid_response", `AI cost ledger returned invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function dateTime(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new LocalAiCostError("invalid_response", `AI cost ledger returned invalid ${name}`);
  }
  return value;
}

function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LocalAiCostError("invalid_response", "AI cost ledger returned an invalid day");
  }
  return value;
}

function decimal(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new LocalAiCostError("invalid_response", `AI cost ledger returned invalid ${name}`);
  }
  let result: string;
  try {
    result = normaliseDecimal(value);
  } catch {
    throw new LocalAiCostError("invalid_response", `AI cost ledger returned invalid ${name}`);
  }
  if (result.startsWith("-")) {
    throw new LocalAiCostError("invalid_response", `AI cost ledger returned negative ${name}`);
  }
  return result;
}

function count(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new LocalAiCostError("invalid_response", `AI cost ledger returned invalid ${name}`);
  }
  return BigInt(value).toString();
}

function ledgerTotals(value: unknown, name: string): LedgerTotals {
  const raw = record(value, name);
  const totals = {
    cost: decimal(raw.costMinorUnits, `${name} cost`),
    calculatedCost: decimal(raw.calculatedCostMinorUnits, `${name} calculated cost`),
    providerBackfillCost: decimal(
      raw.providerBackfillCostMinorUnits,
      `${name} provider backfill cost`,
    ),
  };
  if (addDecimal(totals.calculatedCost, totals.providerBackfillCost) !== totals.cost) {
    throw new LocalAiCostError(
      "invalid_response",
      `AI cost ledger ${name} cost does not reconcile`,
    );
  }

  /* Validate the audit counters even though the finance headline only needs
     cost. A malformed token aggregate must not quietly become trusted money. */
  count(raw.inputTokens, `${name} input tokens`);
  count(raw.outputTokens, `${name} output tokens`);
  count(raw.cacheCreationInputTokens, `${name} cache-creation tokens`);
  count(raw.cacheReadInputTokens, `${name} cache-read tokens`);
  count(raw.requestCount, `${name} request count`);
  count(raw.backfillRowCount, `${name} backfill row count`);
  return totals;
}

function money(value: string): ExactMoney {
  return { currency: "USD", minorUnits: value };
}

function costTotals(value: LedgerTotals): AnthropicCostTotals {
  return {
    cost: money(value.cost),
    /* Backfilled provider cost can contain non-token items. Only the locally
       calculated portion is known to come from actual token usage. */
    tokenCost: money(value.calculatedCost),
  };
}

/** Validate and map the service-role-only aggregate into the finance model. */
export function parseLocalAiCost(
  payload: unknown,
  period: FinancePeriod,
): AnthropicCostSnapshot {
  const raw = record(payload, "snapshot");
  if (raw.source !== "local_cost_ledger" || raw.currency !== "USD") {
    throw new LocalAiCostError("invalid_response", "AI cost ledger returned the wrong source");
  }
  if (raw.periodDays !== period.days) {
    throw new LocalAiCostError("invalid_response", "AI cost ledger returned the wrong period");
  }
  const asOf = dateTime(raw.asOf, "as-of time");
  const coverageRaw = record(raw.coverage, "coverage");
  const coverageSource = coverageRaw.source;
  if (
    coverageSource !== null &&
    coverageSource !== "provider_console" &&
    coverageSource !== "local_tracking"
  ) {
    throw new LocalAiCostError("invalid_response", "AI cost ledger returned invalid coverage");
  }
  const startsAt =
    coverageRaw.startsAt === null ? null : dateTime(coverageRaw.startsAt, "coverage start");
  if (
    typeof coverageRaw.historicalComplete !== "boolean" ||
    typeof coverageRaw.includesProviderBackfill !== "boolean"
  ) {
    throw new LocalAiCostError("invalid_response", "AI cost ledger returned invalid coverage");
  }

  const lifetime = ledgerTotals(raw.lifetime, "lifetime");
  const currentPeriod = ledgerTotals(raw.period, "period");
  if (!Array.isArray(raw.daily)) {
    throw new LocalAiCostError("invalid_response", "AI cost ledger returned invalid daily data");
  }

  const expectedDays = utcDays(period);
  const expected = new Set(expectedDays);
  const days = new Map<string, LedgerTotals>();
  for (const value of raw.daily) {
    const row = record(value, "daily row");
    const rowDay = day(row.date);
    if (!expected.has(rowDay) || days.has(rowDay)) {
      throw new LocalAiCostError("invalid_response", "AI cost ledger returned an unexpected day");
    }
    days.set(rowDay, ledgerTotals(row, `daily ${rowDay}`));
  }

  const zero: LedgerTotals = { cost: "0", calculatedCost: "0", providerBackfillCost: "0" };
  const daily: AnthropicCostDay[] = expectedDays.map((rowDay) => ({
    day: rowDay,
    ...costTotals(days.get(rowDay) ?? zero),
  }));

  return {
    source: "local_cost_ledger",
    asOf,
    coverage: {
      source: coverageSource,
      startsAt,
      historicalComplete: coverageRaw.historicalComplete,
      includesProviderBackfill: coverageRaw.includesProviderBackfill,
    },
    lifetime: costTotals(lifetime),
    period: costTotals(currentPeriod),
    daily,
    byCostType: [
      {
        costType: "calculated_tokens",
        lifetimeCost: money(lifetime.calculatedCost),
        periodCost: money(currentPeriod.calculatedCost),
      },
      {
        costType: "provider_backfill",
        lifetimeCost: money(lifetime.providerBackfillCost),
        periodCost: money(currentPeriod.providerBackfillCost),
      },
    ],
    workspaceFiltered: true,
  };
}

/** Reads BandUp's actual-token cost ledger when an Admin Cost API is absent. */
export async function localAiCostSnapshot(
  period: FinancePeriod,
): Promise<AnthropicCostSnapshot> {
  let payload: unknown;
  try {
    const { readAdminAiCostSnapshot } = await import("@/lib/ai/cost-tracking");
    payload = await readAdminAiCostSnapshot(period.days);
  } catch (error) {
    throw new LocalAiCostError(
      "provider_unavailable",
      `AI cost ledger request failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  return parseLocalAiCost(payload, period);
}
