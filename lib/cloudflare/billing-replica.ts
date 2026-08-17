import type { PromoSubscriptionReplica, StripeSubscriptionReplica } from "@/lib/auth/supabase";
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
 * Everything the guarded `subscriptions` upsert needs, independent of where
 * it came from: a live Stripe webhook (`StripeSubscriptionReplica`, always
 * `provider: "stripe"`) or a drift backfill row read back from Supabase
 * (`CloudflareBackfillSubscriptionRow` in lib/auth/supabase.ts, whose
 * `provider` is whatever Supabase actually has — this must never assume
 * Stripe for a row the backfill did not itself originate).
 */
export interface CloudflareSubscriptionRowInput {
  id: string;
  userId: string;
  provider: string;
  status: string;
  tier: string;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  providerEventAt: string | null;
  verifiedAt: string;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * The one guarded upsert every subscription write in this file uses: never
 * rolling `provider_event_at` backwards, keyed by this provider's existing
 * `external_subscription_id` row when one is already mirrored.
 */
async function prepareSubscriptionUpsert(
  input: CloudflareSubscriptionRowInput,
  bindings: BandUpCloudflareBindings,
): Promise<D1PreparedStatement> {
  const existing = input.subscriptionId
    ? await bindings.db.prepare(`
        SELECT id FROM subscriptions
         WHERE provider = ? AND external_subscription_id = ? LIMIT 1
      `).bind(input.provider, input.subscriptionId).first<{ id: string }>()
    : null;
  const subscriptionStored = await storeJson(bindings, "subscriptions", input.userId, input.raw);
  return bindings.db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, external_customer_id,
      external_subscription_id, external_price_id, current_period_end,
      cancel_at_period_end, provider_event_at, verified_at,
      raw_inline, raw_object_key, raw_sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    existing?.id ?? input.id,
    input.userId,
    input.provider,
    input.status,
    input.tier,
    input.customerId,
    input.subscriptionId,
    input.priceId,
    input.currentPeriodEnd,
    input.cancelAtPeriodEnd ? 1 : 0,
    input.providerEventAt
      ? canonicalCloudflareSourceClock(input.providerEventAt)
      : null,
    canonicalCloudflareSourceClock(input.verifiedAt),
    subscriptionStored.inline,
    subscriptionStored.objectKey,
    subscriptionStored.sha256,
    canonicalCloudflareSourceClock(input.createdAt),
    canonicalCloudflareSourceClock(input.updatedAt),
  );
}

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

  const eventStored = await storeJson(
    bindings,
    "provider-events",
    authoritative.userId,
    eventPayload,
    { forceObject: true },
  );
  const subscriptionStatement = await prepareSubscriptionUpsert(
    { ...authoritative, provider: "stripe" },
    bindings,
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
    subscriptionStatement,
  ]);
  return results.every((item) => item.success);
}

export interface CloudflareBackfillSubscriptionOutcome {
  success: boolean;
  /** False when the guard above left an already current-or-newer row alone. */
  changed: boolean;
}

/**
 * Repairs one drifted subscription row directly from its current Supabase
 * state, for the drift backfill.
 *
 * This deliberately writes only the `subscriptions` row. A backfill has no
 * originating webhook delivery to record next to it — inventing one would
 * put a `provider_events` row in D1 that Supabase never had, which is a new
 * drift, not a repair of the reported one. The same guarded upsert above
 * (never rolling `provider_event_at` backwards) is reused unchanged, so a D1
 * row a real webhook already brought current is left alone here too.
 *
 * The caller (lib/cloudflare/domain-backfill.ts) has already confirmed the
 * account is not mid-deletion; this only bootstraps the `app_users` row with
 * `INSERT OR IGNORE`, exactly as the webhook path above does, which never
 * touches an existing row's email.
 */
export async function backfillCloudflareSubscription(
  row: CloudflareSubscriptionRowInput,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareBackfillSubscriptionOutcome> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureEventUser(row.userId, bindings);
  const statement = await prepareSubscriptionUpsert(row, bindings);
  const result = await statement.run();
  return { success: result.success, changed: result.success && (result.meta.changes ?? 0) > 0 };
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

/**
 * Copy the exact current Supabase promo row.
 *
 * A promo grant has no provider webhook, so there is no `provider_events` row
 * to write and no delivery id to dedupe — unlike
 * `replicateAuthoritativeStripeState`, this writes only `subscriptions`. What
 * plays the ordering role `provider_event_at` plays for Stripe is the row's
 * own `updated_at`: a promo row is a *mutable* snapshot (accepted, later
 * possibly given up and taken again — see the pull request for why status is
 * the column that changes), not a stream of immutable events, so a stale
 * replay is one whose `updated_at` is not newer than what D1 already holds,
 * the same rule learner_profiles and progress_snapshots already use for their
 * own mutable rows (see lib/cloudflare/learner-data.ts).
 *
 * Takes the whole row rather than assuming `status: 'active'`, so this same
 * function mirrors a later status change — 'paused' from a learner giving the
 * trial back, 'canceled' from the owner's sweep — with no changes here. It is
 * the resolver, not this write, that already treats anything other than
 * 'active'/'trialing' as granting nothing (supabase/migrations/0026, and
 * lib/cloudflare/entitlement-runtime.ts's `status IN` clause matching it).
 */
export async function replicateAuthoritativePromoState(
  row: PromoSubscriptionReplica,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureEventUser(row.userId, bindings);

  const stored = await storeJson(bindings, "subscriptions", row.userId, row.raw);
  const result = await bindings.db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, current_period_end,
      cancel_at_period_end, verified_at,
      raw_inline, raw_object_key, raw_sha256, created_at, updated_at
    ) VALUES (?, ?, 'promo', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      tier = excluded.tier,
      current_period_end = excluded.current_period_end,
      verified_at = excluded.verified_at,
      raw_inline = excluded.raw_inline,
      raw_object_key = excluded.raw_object_key,
      raw_sha256 = excluded.raw_sha256,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at >= subscriptions.updated_at
  `).bind(
    row.id,
    row.userId,
    row.status,
    row.tier,
    row.currentPeriodEnd ? canonicalCloudflareSourceClock(row.currentPeriodEnd) : null,
    canonicalCloudflareSourceClock(row.verifiedAt),
    stored.inline,
    stored.objectKey,
    stored.sha256,
    canonicalCloudflareSourceClock(row.createdAt),
    canonicalCloudflareSourceClock(row.updatedAt),
  ).run();
  return result.success;
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
