import { assertServerOnly } from "@/lib/auth/server-only";
import type { CostedRoute } from "@/lib/ai/models";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { canonicalCloudflareSourceClock, currentCloudflareSourceClock } from "./source-clock";
import type { CloudflareAiCostEventReplica } from "./usage-cost-replica";

const MODULE = "lib/cloudflare/ai-cost-write-authority.ts";
const AI_COST_EVENTS_SEQUENCE = "ai_cost_events";

/*
  The D1-only write path for the `ai_cost_write_authority` cutover domain —
  see lib/cloudflare/cutover-domains.ts.

  This one needs none of usage-quota-authority.ts's cap arithmetic. Postgres's
  `record_ai_cost_event` is already a single statement — an INSERT with
  `ON CONFLICT (provider_request_id) DO NOTHING` — because the only thing it
  guards against is a duplicate write for the same Anthropic response, not a
  cap. D1 expresses that identically: `ON CONFLICT DO NOTHING` is exactly as
  atomic on D1 as `pg_advisory_xact_lock` makes the Postgres version, because
  the constraint that decides the outcome (`provider_request_id` UNIQUE) is
  enforced by the same statement that performs the write. There is no
  time-of-check/time-of-use gap here to close, unlike the usage meter.

  It still needs its own minted id — see usage-quota-authority.ts's comment on
  `mintIds` for why that is a D1 counter rather than a ULID — from a separate
  counter, because Supabase's `usage_events` and `ai_cost_events` id columns
  are independent bigint sequences (supabase/migrations/0028) and mixing them
  into one D1 counter would make ids collide across the two tables the moment
  both were seeded from the same starting point.
*/

/** Thrown when the D1 id counter for `ai_cost_events` has not been seeded. */
export class CloudflareAiCostIdSequenceNotSeededError extends Error {
  constructor() {
    super(
      'The D1 id counter for "ai_cost_events" is not seeded. This is an operator step, not ' +
      "a bug: see the pull request that added lib/cloudflare/ai-cost-write-authority.ts for " +
      "the exact wrangler d1 execute commands, and run them before setting this domain's " +
      "mode to 'cloudflare'.",
    );
    this.name = "CloudflareAiCostIdSequenceNotSeededError";
  }
}

/*
  Advances the counter by a literal 1 (not a bound parameter) so there is no
  question of SQLite arithmetic promoting to REAL and turning "42" into
  "42.0" — see the longer note on the same hazard in
  lib/cloudflare/usage-quota-authority.ts's `mintIds`.
*/
async function mintAiCostEventId(db: BandUpCloudflareBindings["db"]): Promise<string> {
  const row = await db.prepare(`
    UPDATE cloudflare_id_sequences
       SET next_value = next_value + 1
     WHERE sequence_name = ?
    RETURNING CAST(next_value - 1 AS TEXT) AS id
  `).bind(AI_COST_EVENTS_SEQUENCE).first<{ id: string }>();
  if (!row) throw new CloudflareAiCostIdSequenceNotSeededError();
  return row.id;
}

export interface AiCostAuthorityInput {
  providerRequestId: string;
  route: CostedRoute;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  cacheReadInputTokens: number;
  /** The exact minimal-form string `usdFromNanodollars` produced — see parity-money.ts. */
  costUsd: string;
  occurredAt: string;
}

export interface AiCostAuthorityResult {
  /** False when this call was a retry of an already-recorded response. */
  inserted: boolean;
  event: CloudflareAiCostEventReplica;
}

interface AiCostEventRow {
  id: string;
  source: string;
  provider_request_id: string;
  route: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_creation_5m_input_tokens: number | null;
  cache_creation_1h_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cost_usd: string;
  occurred_at: string;
  recorded_at: string;
}

function toReplica(row: AiCostEventRow): CloudflareAiCostEventReplica {
  return {
    id: row.id,
    source: "calculated_tokens",
    providerRequestId: row.provider_request_id,
    route: row.route as CostedRoute,
    model: row.model ?? "",
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
    cacheCreation5mInputTokens: row.cache_creation_5m_input_tokens ?? 0,
    cacheCreation1hInputTokens: row.cache_creation_1h_input_tokens ?? 0,
    cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
    costUsd: row.cost_usd,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

/**
 * Records one Anthropic response's cost directly in D1, with Supabase out of
 * the loop entirely. Idempotent on `providerRequestId`, exactly like
 * `record_ai_cost_event`: a retry of an already-recorded response returns the
 * row that was actually stored, with `inserted: false`, rather than writing a
 * second row or throwing.
 *
 * Throws `CloudflareAiCostIdSequenceNotSeededError` if the id counter has not
 * been provisioned, and a plain `Error` for any other D1 failure. Unlike
 * `admitUsageEventOnCloudflare`, nothing here gates a request — the AI call
 * this cost belongs to has already happened by the time this runs — so the
 * caller (lib/ai/cost-tracking.ts) keeps its existing "never throws past this
 * point, log and return false" contract for every failure this raises.
 */
export async function recordAiCostEventOnCloudflare(
  input: AiCostAuthorityInput,
  providedBindings?: BandUpCloudflareBindings,
): Promise<AiCostAuthorityResult> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const providerRequestId = input.providerRequestId.trim();
  if (!providerRequestId) throw new Error("Cloudflare AI cost write has no provider request id");
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error("Invalid Cloudflare AI cost occurrence timestamp");
  }

  const id = await mintAiCostEventId(bindings.db);
  const recordedAt = currentCloudflareSourceClock();
  const occurredAt = canonicalCloudflareSourceClock(input.occurredAt);

  const inserted = await bindings.db.prepare(`
    INSERT INTO ai_cost_events (
      id, source, provider_request_id, external_reference, route, model,
      input_tokens, output_tokens, cache_creation_input_tokens,
      cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
      cache_read_input_tokens, cost_usd, occurred_at, recorded_at
    ) VALUES (?, 'calculated_tokens', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_request_id) DO NOTHING
  `).bind(
    id,
    providerRequestId,
    input.route,
    input.model,
    input.inputTokens,
    input.outputTokens,
    input.cacheCreationInputTokens,
    input.cacheCreation5mInputTokens,
    input.cacheCreation1hInputTokens,
    input.cacheReadInputTokens,
    input.costUsd,
    occurredAt,
    recordedAt,
  ).run();
  if (!inserted.success) throw new Error("Cloudflare AI cost write is unavailable");

  const row = await bindings.db.prepare(`
    SELECT id, source, provider_request_id, route, model, input_tokens, output_tokens,
           cache_creation_input_tokens, cache_creation_5m_input_tokens,
           cache_creation_1h_input_tokens, cache_read_input_tokens, cost_usd,
           occurred_at, recorded_at
      FROM ai_cost_events
     WHERE provider_request_id = ?
  `).bind(providerRequestId).first<AiCostEventRow>();
  if (!row) throw new Error("Cloudflare AI cost write committed no row");

  return { inserted: inserted.meta.changes === 1, event: toReplica(row) };
}
