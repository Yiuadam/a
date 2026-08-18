import { rpc } from "@/lib/auth/supabase";
import { COSTED_ROUTES, type CostedRoute } from "@/lib/ai/models";
import { mirrorsWritesToCloudflare } from "@/lib/cloudflare/bindings";
import { cutoverWriteBarrierArmed } from "@/lib/cloudflare/write-barrier";
import {
  type CloudflareAiCostCoverageReplica,
  type CloudflareAiCostEventReplica,
} from "@/lib/cloudflare/usage-cost-replica";
import {
  replicateAiCostCoverageDurably,
  replicateAiCostEventDurably,
} from "@/lib/cloudflare/replica-replay";

/*
  Local Anthropic cost accounting.

  This is calculated from the usage attached to a successful Message response.
  It is precise arithmetic at the published rate, but it is not an Anthropic
  invoice or Cost Report. The database records that distinction as
  `source = calculated_tokens`.

  USD nanodollars are the internal unit. They keep all currently published
  cache multipliers exact without using binary floating point:

    $1 / MTok = 1,000 nanodollars per token
    5-minute cache creation = 1.25x
    1-hour cache creation = 2x
    cache read = 0.1x
*/

const NANODOLLARS_PER_DOLLAR = BigInt(1_000_000_000);
const NANODOLLARS_PER_BASE_RATE_TOKEN = BigInt(1_000);
const SONNET_5_INTRO_END_EXCLUSIVE = Date.UTC(2026, 8, 1);

export interface AnthropicUsageForCost {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

export interface CalculatedAnthropicCost {
  source: "calculated_tokens";
  model: string;
  pricingTier: "haiku_4_5" | "sonnet_5_intro" | "sonnet_5_standard";
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  cacheReadInputTokens: number;
  /** Exact integer internal unit; never serialize this value directly to JSON. */
  costUsdNanodollars: bigint;
  /** Exact base-10 USD value accepted by the numeric database column. */
  costUsd: string;
}

export interface RecordAnthropicMessageCostInput {
  providerRequestId: string;
  route: CostedRoute;
  model: string;
  usage: AnthropicUsageForCost;
  occurredAt?: Date;
}

export interface SetAiCostCoverageInput {
  source: "provider_console" | "local_tracking";
  startsAt: Date;
  historicalComplete: boolean;
}

export interface AiCostAggregate {
  /** Exact decimal US cents, including any meaningful sub-cent digits. */
  costMinorUnits: string;
  calculatedCostMinorUnits: string;
  providerBackfillCostMinorUnits: string;
  inputTokens: string;
  outputTokens: string;
  cacheCreationInputTokens: string;
  cacheReadInputTokens: string;
  /** Successful Message responses, excluding provider daily backfill rows. */
  requestCount: string;
  backfillRowCount: string;
  startsAt: string | null;
}

export interface AiCostDailyAggregate extends Omit<AiCostAggregate, "startsAt"> {
  date: string;
}

export interface AdminAiCostSnapshot {
  source: "local_cost_ledger";
  currency: "USD";
  asOf: string;
  periodDays: number;
  coverage: {
    source: "provider_console" | "local_tracking" | null;
    startsAt: string | null;
    historicalComplete: boolean;
    includesProviderBackfill: boolean;
  };
  lifetime: AiCostAggregate;
  period: AiCostAggregate;
  daily: AiCostDailyAggregate[];
}

interface PublishedRate {
  pricingTier: CalculatedAnthropicCost["pricingTier"];
  inputPerMillionUsd: bigint;
  outputPerMillionUsd: bigint;
}

interface StoredAiCostResponse {
  inserted?: unknown;
  event?: unknown;
  coverage?: unknown;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const raw = nonempty(value, field);
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`Supabase returned an invalid ${field}`);
  return raw;
}

function wholeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return value;
}

function storedCostEvent(value: unknown): CloudflareAiCostEventReplica {
  const event = record(value, "AI cost event");
  const id = nonempty(event.id, "AI cost event id");
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Supabase returned an invalid AI cost event id");
  if (event.source !== "calculated_tokens") {
    throw new Error("Supabase returned the wrong AI cost event source");
  }
  const route = nonempty(event.route, "AI cost route");
  if (!(COSTED_ROUTES as readonly string[]).includes(route)) {
    throw new Error("Supabase returned an invalid AI cost route");
  }
  const costUsd = nonempty(event.costUsd, "AI cost amount");
  if (!/^\d+(?:\.\d+)?$/.test(costUsd)) {
    throw new Error("Supabase returned an invalid AI cost amount");
  }
  return {
    id,
    source: "calculated_tokens",
    providerRequestId: nonempty(event.providerRequestId, "provider request id"),
    route: route as CostedRoute,
    model: nonempty(event.model, "AI model"),
    inputTokens: wholeNumber(event.inputTokens, "input token count"),
    outputTokens: wholeNumber(event.outputTokens, "output token count"),
    cacheCreationInputTokens: wholeNumber(
      event.cacheCreationInputTokens,
      "cache creation token count",
    ),
    cacheCreation5mInputTokens: wholeNumber(
      event.cacheCreation5mInputTokens,
      "5-minute cache creation token count",
    ),
    cacheCreation1hInputTokens: wholeNumber(
      event.cacheCreation1hInputTokens,
      "1-hour cache creation token count",
    ),
    cacheReadInputTokens: wholeNumber(event.cacheReadInputTokens, "cache read token count"),
    costUsd,
    occurredAt: timestamp(event.occurredAt, "AI cost occurrence timestamp"),
    recordedAt: timestamp(event.recordedAt, "AI cost record timestamp"),
  };
}

function storedCoverage(value: unknown): CloudflareAiCostCoverageReplica {
  const coverage = record(value, "AI cost coverage");
  if (coverage.source !== "provider_console" && coverage.source !== "local_tracking") {
    throw new Error("Supabase returned an invalid AI cost coverage source");
  }
  if (typeof coverage.historicalComplete !== "boolean") {
    throw new Error("Supabase returned an invalid AI cost coverage state");
  }
  return {
    source: coverage.source,
    startsAt: timestamp(coverage.startsAt, "AI cost coverage start"),
    historicalComplete: coverage.historicalComplete,
    recordedAt: timestamp(coverage.recordedAt, "AI cost coverage record timestamp"),
  };
}

async function mirrorStoredCostResponse(response: StoredAiCostResponse): Promise<void> {
  const event = storedCostEvent(response.event);
  try {
    if (!await replicateAiCostEventDurably(event)) {
      throw new Error("D1 did not accept the AI cost event replica");
    }
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[ai-cost] Cloudflare event replica: ${detail}`);
  }

  if (response.coverage !== null && response.coverage !== undefined) {
    try {
      if (!await replicateAiCostCoverageDurably(storedCoverage(response.coverage))) {
        throw new Error("D1 did not accept the AI cost coverage replica");
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[ai-cost] Cloudflare coverage replica: ${detail}`);
    }
  }
}

function tokens(value: number | null | undefined, field: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`Anthropic returned an invalid ${field} token count`);
  }
  return resolved;
}

function publishedRate(model: string, occurredAt: Date): PublishedRate {
  const id = model.toLowerCase();
  if (id.startsWith("claude-haiku-4-5")) {
    return {
      pricingTier: "haiku_4_5",
      inputPerMillionUsd: BigInt(1),
      outputPerMillionUsd: BigInt(5),
    };
  }
  if (id.startsWith("claude-sonnet-5")) {
    const introductory = occurredAt.getTime() < SONNET_5_INTRO_END_EXCLUSIVE;
    return introductory
      ? {
          pricingTier: "sonnet_5_intro",
          inputPerMillionUsd: BigInt(2),
          outputPerMillionUsd: BigInt(10),
        }
      : {
          pricingTier: "sonnet_5_standard",
          inputPerMillionUsd: BigInt(3),
          outputPerMillionUsd: BigInt(15),
        };
  }
  throw new Error(`No local Anthropic price is configured for model ${model}`);
}

/** Converts an integer number of USD nanodollars to an exact decimal string. */
export function usdFromNanodollars(value: bigint): string {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = absolute / NANODOLLARS_PER_DOLLAR;
  const fraction = (absolute % NANODOLLARS_PER_DOLLAR)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Calculates one response at the published rate that applied when it arrived.
 *
 * `input_tokens` is the ordinary, uncached input count. Cache creation and
 * cache reads are separate usage fields and are therefore priced separately,
 * not added back into ordinary input first.
 */
export function calculateAnthropicTokenCost(
  model: string,
  usage: AnthropicUsageForCost,
  occurredAt: Date = new Date(),
): CalculatedAnthropicCost {
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid Anthropic cost timestamp");

  const inputTokens = tokens(usage.input_tokens, "input");
  const outputTokens = tokens(usage.output_tokens, "output");
  const cacheCreationInputTokens = tokens(
    usage.cache_creation_input_tokens,
    "cache creation",
  );
  const cacheReadInputTokens = tokens(usage.cache_read_input_tokens, "cache read");
  const reported5m = tokens(
    usage.cache_creation?.ephemeral_5m_input_tokens,
    "5-minute cache creation",
  );
  const reported1h = tokens(
    usage.cache_creation?.ephemeral_1h_input_tokens,
    "1-hour cache creation",
  );

  if (reported5m + reported1h > cacheCreationInputTokens) {
    throw new Error("Anthropic cache creation breakdown exceeds its total");
  }

  /*
    Older response schemas expose only the total. Five minutes is Anthropic's
    default TTL, so an undifferentiated remainder is correctly charged at
    1.25x. When the 1-hour count is present it is charged at 2x.
  */
  const cacheCreation1hInputTokens = reported1h;
  const cacheCreation5mInputTokens = cacheCreationInputTokens - reported1h;
  const rate = publishedRate(model, occurredAt);
  const inputRate = rate.inputPerMillionUsd;

  const costUsdNanodollars =
    BigInt(inputTokens) * inputRate * NANODOLLARS_PER_BASE_RATE_TOKEN +
    BigInt(outputTokens) * rate.outputPerMillionUsd * NANODOLLARS_PER_BASE_RATE_TOKEN +
    BigInt(cacheCreation5mInputTokens) * inputRate * BigInt(1_250) +
    BigInt(cacheCreation1hInputTokens) * inputRate * BigInt(2_000) +
    BigInt(cacheReadInputTokens) * inputRate * BigInt(100);

  return {
    source: "calculated_tokens",
    model,
    pricingTier: rate.pricingTier,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
    cacheReadInputTokens,
    costUsdNanodollars,
    costUsd: usdFromNanodollars(costUsdNanodollars),
  };
}

/**
 * Persists one completed Anthropic response. This function deliberately never
 * rejects: cost observability must not turn a valid learner response into an
 * error if Supabase is unavailable or the ledger migration has not landed yet.
 */
export async function recordAnthropicMessageCost(
  input: RecordAnthropicMessageCostInput,
): Promise<boolean> {
  /*
    Like usage metering, cost recording writes Supabase through
    record_ai_cost_event[_with_identity] regardless of mode — see
    cutover-domains.ts's ai_cost_write_authority entry. Checked outside the
    try/catch below on purpose: a barred write is not the "Supabase
    unavailable" case that block already logs, and giving it its own line
    keeps the two distinguishable in the server log.
  */
  if (await cutoverWriteBarrierArmed("learner")) {
    console.error("[ai-cost] recordAnthropicMessageCost: cutover write barrier is armed for learner writes");
    return false;
  }
  try {
    const providerRequestId = input.providerRequestId.trim();
    if (!providerRequestId) throw new Error("Anthropic response has no provider request id");

    const occurredAt = input.occurredAt ?? new Date();
    const calculated = calculateAnthropicTokenCost(input.model, input.usage, occurredAt);
    const args = {
      p_provider_request_id: providerRequestId,
      p_route: input.route,
      p_model: calculated.model,
      p_input_tokens: calculated.inputTokens,
      p_output_tokens: calculated.outputTokens,
      p_cache_creation_input_tokens: calculated.cacheCreationInputTokens,
      p_cache_creation_5m_input_tokens: calculated.cacheCreation5mInputTokens,
      p_cache_creation_1h_input_tokens: calculated.cacheCreation1hInputTokens,
      p_cache_read_input_tokens: calculated.cacheReadInputTokens,
      p_cost_usd: calculated.costUsd,
      p_occurred_at: occurredAt.toISOString(),
    };
    if (!mirrorsWritesToCloudflare()) {
      return await rpc<boolean>("record_ai_cost_event", args);
    }

    const response = await rpc<StoredAiCostResponse>(
      "record_ai_cost_event_with_identity",
      args,
    );
    if (typeof response?.inserted !== "boolean") {
      throw new Error("Supabase returned an invalid AI cost write result");
    }
    const event = storedCostEvent(response.event);
    if (event.providerRequestId !== providerRequestId) {
      throw new Error("Supabase returned a different provider request id");
    }
    await mirrorStoredCostResponse({ ...response, event });
    return response.inserted;
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[ai-cost] recordAnthropicMessageCost: ${detail}`);
    return false;
  }
}

/**
 * Private operator write for the ledger's evidence window. Supabase remains
 * authoritative in dual mode; the exact stored singleton is then mirrored.
 */
export async function setAiCostCoverage(input: SetAiCostCoverageInput): Promise<boolean> {
  if (await cutoverWriteBarrierArmed("learner")) {
    console.error("[ai-cost] setAiCostCoverage: cutover write barrier is armed for learner writes");
    return false;
  }
  try {
    if (!Number.isFinite(input.startsAt.getTime())) throw new Error("Invalid coverage timestamp");
    const args = {
      p_source: input.source,
      p_starts_at: input.startsAt.toISOString(),
      p_historical_complete: input.historicalComplete,
    };
    if (!mirrorsWritesToCloudflare()) {
      return await rpc<boolean>("set_ai_cost_coverage", args);
    }

    const response = await rpc<unknown>("set_ai_cost_coverage_with_identity", args);
    const coverage = storedCoverage(response);
    try {
      if (!await replicateAiCostCoverageDurably(coverage)) {
        throw new Error("D1 did not accept the AI cost coverage replica");
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[ai-cost] Cloudflare coverage replica: ${detail}`);
    }
    return true;
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[ai-cost] setAiCostCoverage: ${detail}`);
    return false;
  }
}

/** Service-role reader for the owner-only finance API. */
export async function readAdminAiCostSnapshot(days = 30): Promise<AdminAiCostSnapshot> {
  const requestedDays = Number.isFinite(days) ? Math.trunc(days) : 30;
  const boundedDays = Math.min(Math.max(requestedDays, 1), 366);
  return rpc<AdminAiCostSnapshot>("admin_ai_cost_snapshot", { p_days: boundedDays });
}
