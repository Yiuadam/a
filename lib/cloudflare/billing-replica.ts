import type { StripeSubscriptionReplica } from "@/lib/auth/supabase";
import type {
  StripePrepaidPurchaseEvent,
  StripePrepaidRefundEvent,
  StripeSubscriptionEvent,
} from "@/lib/billing/stripe";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { storeJson } from "./payloads";
import {
  canonicalCloudflareSourceClock,
  currentCloudflareSourceClock,
} from "./source-clock";

function stamp(): string {
  return currentCloudflareSourceClock();
}

async function ensureEventUser(
  userId: string,
  bindings: BandUpCloudflareBindings,
): Promise<void> {
  const now = stamp();
  const result = await bindings.db.prepare(`
    INSERT OR IGNORE INTO app_users (id, identity_provider, role, created_at, updated_at)
    VALUES (?, 'supabase', 'user', ?, ?)
  `).bind(userId, now, now).run();
  if (!result.success) throw new Error("Cloudflare billing user bootstrap is unavailable");
}

export type StripeReplicaEvent = Pick<StripeSubscriptionEvent, "eventId" | "eventAt">;

/**
 * Copy the exact current Supabase subscription row and separately claim the
 * verified delivery in D1. This distinction matters for duplicate, stale and
 * partial-refund outcomes: their event is audit data, but their payload must
 * never replace the newer authoritative subscription state.
 */
export async function replicateAuthoritativeStripeState(
  event: StripeReplicaEvent,
  eventPayload: unknown,
  authoritative: StripeSubscriptionReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureEventUser(authoritative.userId, bindings);

  const existing = await bindings.db.prepare(`
    SELECT id FROM subscriptions
     WHERE provider = 'stripe' AND external_subscription_id = ? LIMIT 1
  `).bind(authoritative.subscriptionId).first<{ id: string }>();
  const eventStored = await storeJson(
    bindings,
    "provider-events",
    authoritative.userId,
    eventPayload,
    { forceObject: true },
  );
  const subscriptionStored = await storeJson(
    bindings,
    "subscriptions",
    authoritative.userId,
    authoritative.raw,
  );
  const now = stamp();
  const results = await bindings.db.batch([
    bindings.db.prepare(`
      INSERT INTO provider_events (
        provider, event_id, received_at, processed_at,
        payload_object_key, payload_sha256
      ) VALUES ('stripe', ?, ?, ?, ?, ?)
      ON CONFLICT(provider, event_id) DO NOTHING
    `).bind(
      event.eventId,
      event.eventAt,
      now,
      eventStored.objectKey,
      eventStored.sha256,
    ),
    bindings.db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, provider, status, tier, external_customer_id,
        external_subscription_id, external_price_id, current_period_end,
        cancel_at_period_end, provider_event_at, verified_at,
        raw_inline, raw_object_key, raw_sha256, created_at, updated_at
      ) VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        status = excluded.status,
        tier = excluded.tier,
        external_customer_id = excluded.external_customer_id,
        external_price_id = excluded.external_price_id,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        provider_event_at = excluded.provider_event_at,
        verified_at = excluded.verified_at,
        raw_inline = excluded.raw_inline,
        raw_object_key = excluded.raw_object_key,
        raw_sha256 = excluded.raw_sha256,
        updated_at = excluded.updated_at
      WHERE subscriptions.provider_event_at IS NULL
         OR (
           excluded.provider_event_at IS NOT NULL
           AND excluded.provider_event_at >= subscriptions.provider_event_at
         )
    `).bind(
      existing?.id ?? authoritative.id,
      authoritative.userId,
      authoritative.status,
      authoritative.tier,
      authoritative.customerId,
      authoritative.subscriptionId,
      authoritative.priceId,
      authoritative.currentPeriodEnd,
      authoritative.cancelAtPeriodEnd ? 1 : 0,
      authoritative.providerEventAt
        ? canonicalCloudflareSourceClock(authoritative.providerEventAt)
        : null,
      canonicalCloudflareSourceClock(authoritative.verifiedAt),
      subscriptionStored.inline,
      subscriptionStored.objectKey,
      subscriptionStored.sha256,
      canonicalCloudflareSourceClock(authoritative.createdAt),
      canonicalCloudflareSourceClock(authoritative.updatedAt),
    ),
  ]);
  return results.every((item) => item.success);
}

export async function replicateStripeSubscriptionToCloudflare(
  event: StripeSubscriptionEvent,
  payload: unknown,
  authoritative: StripeSubscriptionReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  return replicateAuthoritativeStripeState(event, payload, authoritative, providedBindings);
}

export async function replicateStripePrepaidPurchaseToCloudflare(
  event: StripePrepaidPurchaseEvent,
  payload: unknown,
  authoritative: StripeSubscriptionReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  return replicateAuthoritativeStripeState(event, payload, authoritative, providedBindings);
}

export async function replicateStripePrepaidRefundToCloudflare(
  event: StripePrepaidRefundEvent,
  payload: unknown,
  authoritative: StripeSubscriptionReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  return replicateAuthoritativeStripeState(event, payload, authoritative, providedBindings);
}

export async function cloudflareStripeCustomerFor(userId: string): Promise<string | null> {
  const bindings = await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT external_customer_id FROM subscriptions
     WHERE user_id = ? AND provider = 'stripe' AND external_customer_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1
  `).bind(userId).first<{ external_customer_id: string }>();
  return row?.external_customer_id ?? null;
}
