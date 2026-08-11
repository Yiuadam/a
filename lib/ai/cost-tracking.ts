import { rpc } from "@/lib/auth/supabase";
import type { CostedRoute } from "@/lib/ai/models";

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
  try {
    const providerRequestId = input.providerRequestId.trim();
    if (!providerRequestId) throw new Error("Anthropic response has no provider request id");

    const occurredAt = input.occurredAt ?? new Date();
    const calculated = calculateAnthropicTokenCost(input.model, input.usage, occurredAt);
    return await rpc<boolean>("record_ai_cost_event", {
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
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[ai-cost] recordAnthropicMessageCost: ${detail}`);
    return false;
  }
}

/** Service-role reader for the owner-only finance API. */
export async function readAdminAiCostSnapshot(days = 30): Promise<AdminAiCostSnapshot> {
  const requestedDays = Number.isFinite(days) ? Math.trunc(days) : 30;
  const boundedDays = Math.min(Math.max(requestedDays, 1), 366);
  return rpc<AdminAiCostSnapshot>("admin_ai_cost_snapshot", { p_days: boundedDays });
}
