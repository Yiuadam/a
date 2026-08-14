import type { SessionUser } from "@/lib/auth/session";
import type { CostedRoute } from "@/lib/ai/models";
import type { AiRoute } from "@/lib/usage/limits";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { ensureCloudflareUser } from "./learner-data";
import { canonicalCloudflareSourceClock } from "./source-clock";

export type UsageEventOutcome = "admitted" | "denied_quota" | "denied_rate";

export interface CloudflareUsageEventReplica {
  /** The decimal Supabase identity value, kept as text to avoid JS rounding. */
  id: string;
  userId: string | null;
  route: AiRoute;
  ipHash: string | null;
  outcome: UsageEventOutcome;
  createdAt: string;
}

export interface CloudflareAiCostEventReplica {
  /** The decimal Supabase identity value, kept as text to avoid JS rounding. */
  id: string;
  source: "calculated_tokens";
  providerRequestId: string;
  route: CostedRoute;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: string;
  occurredAt: string;
  recordedAt: string;
}

export interface CloudflareAiCostCoverageReplica {
  source: "provider_console" | "local_tracking";
  startsAt: string;
  historicalComplete: boolean;
  recordedAt: string;
}

/**
 * Mirrors the exact row committed by Supabase's atomic meter.
 *
 * Supabase remains the decision authority in dual mode. The source identity is
 * also the D1 primary key, so a request retry and the final migration copy both
 * converge on one row rather than manufacturing a second usage event.
 */
export async function mirrorCloudflareUsageEvent(
  event: CloudflareUsageEventReplica,
  user: SessionUser | null,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  if (event.userId !== null) {
    if (!user || user.id !== event.userId) {
      throw new Error("Cloudflare usage replica user does not match the verified session");
    }
    await ensureCloudflareUser(user, bindings);
  }

  const result = await bindings.db.prepare(`
    INSERT INTO usage_events (id, user_id, route, ip_hash, outcome, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      route = excluded.route,
      ip_hash = excluded.ip_hash,
      outcome = excluded.outcome,
      created_at = excluded.created_at
  `).bind(
    event.id,
    event.userId,
    event.route,
    event.ipHash,
    event.outcome,
    event.createdAt,
  ).run();
  return result.success;
}

/** One provider response maps to one Supabase id and one D1 row. */
export async function mirrorCloudflareAiCostEvent(
  event: CloudflareAiCostEventReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const result = await db.prepare(`
    INSERT INTO ai_cost_events (
      id, source, provider_request_id, external_reference, route, model,
      input_tokens, output_tokens, cache_creation_input_tokens,
      cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
      cache_read_input_tokens, cost_usd, occurred_at, recorded_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      provider_request_id = excluded.provider_request_id,
      external_reference = excluded.external_reference,
      route = excluded.route,
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      cache_creation_5m_input_tokens = excluded.cache_creation_5m_input_tokens,
      cache_creation_1h_input_tokens = excluded.cache_creation_1h_input_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens,
      cost_usd = excluded.cost_usd,
      occurred_at = excluded.occurred_at,
      recorded_at = excluded.recorded_at
  `).bind(
    event.id,
    event.source,
    event.providerRequestId,
    event.route,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheCreationInputTokens,
    event.cacheCreation5mInputTokens,
    event.cacheCreation1hInputTokens,
    event.cacheReadInputTokens,
    event.costUsd,
    event.occurredAt,
    event.recordedAt,
  ).run();
  return result.success;
}

/**
 * Mirrors the singleton coverage marker without allowing an older retry to
 * roll a newer coverage decision back.
 */
export async function mirrorCloudflareAiCostCoverage(
  coverage: CloudflareAiCostCoverageReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const result = await db.prepare(`
    INSERT INTO ai_cost_coverage (
      singleton, source, starts_at, historical_complete, recorded_at
    ) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      source = excluded.source,
      starts_at = excluded.starts_at,
      historical_complete = excluded.historical_complete,
      recorded_at = excluded.recorded_at
    WHERE excluded.recorded_at >= ai_cost_coverage.recorded_at
  `).bind(
    coverage.source,
    canonicalCloudflareSourceClock(coverage.startsAt),
    coverage.historicalComplete ? 1 : 0,
    canonicalCloudflareSourceClock(coverage.recordedAt),
  ).run();
  return result.success;
}
