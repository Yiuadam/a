import { assertServerOnly } from "@/lib/auth/server-only";
import { anthropicAdminKey, anthropicWorkspaceId } from "@/lib/auth/env";
import { addDecimal, normaliseDecimal } from "./finance-decimal";
import { utcDays } from "./finance-period";
import type {
  AnthropicCostSnapshot,
  ExactMoney,
  FinancePeriod,
} from "./finance-types";

const MODULE = "lib/admin/anthropic-cost.ts";
const COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report";

export class AnthropicCostError extends Error {}

interface CostRow {
  amount: string;
  currency: string;
  costType: string;
}

export interface AnthropicCostBucket {
  startingAt: string;
  endingAt: string;
  results: CostRow[];
}

function money(value: string): ExactMoney {
  return { currency: "USD", minorUnits: normaliseDecimal(value) };
}

function isInPeriod(bucket: AnthropicCostBucket, period: FinancePeriod): boolean {
  const timestamp = Date.parse(bucket.startingAt);
  return timestamp >= Date.parse(period.startingAt) && timestamp < Date.parse(period.endingAt);
}

/** Aggregate provider rows with exact decimal arithmetic; amounts are cents. */
export function summariseAnthropicCost(
  buckets: AnthropicCostBucket[],
  period: FinancePeriod,
  workspaceFiltered: boolean,
): AnthropicCostSnapshot {
  let lifetimeCost = "0";
  let lifetimeTokenCost = "0";
  let periodCost = "0";
  let periodTokenCost = "0";
  const daily = new Map(utcDays(period).map((day) => [day, { cost: "0", tokenCost: "0" }]));
  const byType = new Map<string, { lifetime: string; period: string }>();

  for (const bucket of buckets) {
    const inPeriod = isInPeriod(bucket, period);
    const day = new Date(bucket.startingAt).toISOString().slice(0, 10);
    for (const row of bucket.results) {
      if (row.currency.toUpperCase() !== "USD") {
        throw new AnthropicCostError(`Anthropic returned cost in ${row.currency}, expected USD`);
      }
      const amount = normaliseDecimal(row.amount);
      const costType = row.costType || "unknown";
      const type = byType.get(costType) ?? { lifetime: "0", period: "0" };
      type.lifetime = addDecimal(type.lifetime, amount);
      lifetimeCost = addDecimal(lifetimeCost, amount);
      if (costType === "tokens") lifetimeTokenCost = addDecimal(lifetimeTokenCost, amount);

      if (inPeriod) {
        type.period = addDecimal(type.period, amount);
        periodCost = addDecimal(periodCost, amount);
        if (costType === "tokens") periodTokenCost = addDecimal(periodTokenCost, amount);
        const date = daily.get(day);
        if (date) {
          date.cost = addDecimal(date.cost, amount);
          if (costType === "tokens") date.tokenCost = addDecimal(date.tokenCost, amount);
        }
      }
      byType.set(costType, type);
    }
  }

  return {
    lifetime: { cost: money(lifetimeCost), tokenCost: money(lifetimeTokenCost) },
    period: { cost: money(periodCost), tokenCost: money(periodTokenCost) },
    daily: [...daily.entries()].map(([day, value]) => ({
      day,
      cost: money(value.cost),
      tokenCost: money(value.tokenCost),
    })),
    byCostType: [...byType.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([costType, value]) => ({
        costType,
        lifetimeCost: money(value.lifetime),
        periodCost: money(value.period),
      })),
    workspaceFiltered,
  };
}

function readCostBuckets(payload: unknown): AnthropicCostBucket[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new AnthropicCostError("Anthropic returned an invalid Cost Report");
  }

  return (payload as { data: unknown[] }).data.map((rawBucket) => {
    if (!rawBucket || typeof rawBucket !== "object") {
      throw new AnthropicCostError("Anthropic returned an invalid cost bucket");
    }
    const bucket = rawBucket as Record<string, unknown>;
    if (
      typeof bucket.starting_at !== "string" ||
      typeof bucket.ending_at !== "string" ||
      !Array.isArray(bucket.results)
    ) {
      throw new AnthropicCostError("Anthropic returned an incomplete cost bucket");
    }
    return {
      startingAt: bucket.starting_at,
      endingAt: bucket.ending_at,
      results: bucket.results.map((rawRow) => {
        if (!rawRow || typeof rawRow !== "object") {
          throw new AnthropicCostError("Anthropic returned an invalid cost row");
        }
        const row = rawRow as Record<string, unknown>;
        if (typeof row.amount !== "string" || typeof row.currency !== "string") {
          throw new AnthropicCostError("Anthropic returned an incomplete cost row");
        }
        return {
          amount: row.amount,
          currency: row.currency,
          costType: typeof row.cost_type === "string" ? row.cost_type : "unknown",
        };
      }),
    };
  });
}

export function anthropicCostConfigured(): boolean {
  return Boolean(anthropicAdminKey());
}

/**
 * Reads Anthropic's authoritative historical Cost Report. The regular
 * ANTHROPIC_API_KEY cannot access it; an organization Admin key is required.
 */
export async function anthropicCostSnapshot(
  period: FinancePeriod,
  lifetimeStartingAt: string,
  fetcher: typeof fetch = fetch,
): Promise<AnthropicCostSnapshot> {
  assertServerOnly(MODULE);
  const key = anthropicAdminKey();
  if (!key) throw new AnthropicCostError("Anthropic Cost Report is not configured");
  const workspaceId = anthropicWorkspaceId();
  const buckets: AnthropicCostBucket[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 1_000; page += 1) {
    const query = new URLSearchParams({
      starting_at: lifetimeStartingAt,
      ending_at: period.endingAt,
      bucket_width: "1d",
      limit: "31",
    });
    query.append("group_by[]", "description");
    if (workspaceId) query.append("workspace_ids[]", workspaceId);
    if (pageToken) query.set("page", pageToken);

    let response: Response;
    try {
      response = await fetcher(`${COST_REPORT_URL}?${query.toString()}`, {
        method: "GET",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": key,
          "User-Agent": "BandUp/1.0 (https://bandup.life)",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new AnthropicCostError(
        `Anthropic Cost Report request failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AnthropicCostError(`Anthropic Cost Report was not JSON (${response.status})`);
    }
    if (!response.ok) {
      const error = (payload as { error?: { type?: unknown } } | null)?.error;
      const detail = typeof error?.type === "string" ? error.type : String(response.status);
      throw new AnthropicCostError(`Anthropic Cost Report refused: ${detail}`);
    }

    buckets.push(...readCostBuckets(payload));
    const report = payload as { has_more?: unknown; next_page?: unknown };
    if (report.has_more !== true) {
      return summariseAnthropicCost(buckets, period, Boolean(workspaceId));
    }
    if (
      typeof report.next_page !== "string" ||
      report.next_page.length === 0 ||
      report.next_page === pageToken
    ) {
      throw new AnthropicCostError("Anthropic Cost Report pagination did not advance");
    }
    pageToken = report.next_page;
  }

  throw new AnthropicCostError("Anthropic Cost Report exceeded 1,000 pages");
}
