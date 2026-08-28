import { assertServerOnly } from "@/lib/auth/server-only";
import type {
  StripePrepaidPurchaseEvent,
  StripePrepaidRefundEvent,
  StripeSubscriptionEvent,
} from "@/lib/billing/stripe";
import type { PrepaidApplyOutcome, ApplyOutcome } from "@/lib/billing/subscriptions";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { storeJson } from "./payloads";
import { canonicalCloudflareSourceClock, currentCloudflareSourceClock } from "./source-clock";

/*
  The D1 implementation of the verified Stripe event ledger.

  The webhook route verifies Stripe's signature before it can call this module.
  Here, a fresh `provider_events.claim_token` is inserted in the same D1 batch
  as the entitlement write. Every entitlement statement checks that token, so
  a redelivery can never reuse an old receipt to write again. D1 documents
  that `batch()` is transactional: a failure rolls the entire sequence back.

  R2 evidence is stored first because object storage cannot join a D1
  transaction. A failed D1 batch can leave an unreachable object, but it can
  never create an entitlement without the signed event receipt; the account
  deletion and object-cleanup paths reclaim superseded objects.
*/

const MODULE = "lib/cloudflare/native-stripe-billing.ts";
const PROVIDER = "stripe";

interface UserRow {
  id: string;
}

interface PrepaidPurchaseRow {
  user_id: string;
  subscription_id: string;
  amount_minor: number;
  provider_event_at: string | null;
}

function d1Changes(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0);
}

function claimToken(): string {
  return crypto.randomUUID();
}

async function bindingsFor(
  provided?: BandUpCloudflareBindings,
): Promise<BandUpCloudflareBindings> {
  return provided ?? requireBandUpCloudflareBindings();
}

async function liveUser(
  userId: string,
  bindings: BandUpCloudflareBindings,
): Promise<string | null> {
  const row = await bindings.db.prepare(`
    SELECT id FROM app_users
     WHERE id = ? AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = app_users.id
       )
     LIMIT 1
  `).bind(userId).first<UserRow>();
  return row?.id === userId ? userId : null;
}

async function resolveSubscriptionUser(
  event: StripeSubscriptionEvent,
  bindings: BandUpCloudflareBindings,
): Promise<string | null> {
  if (event.userId) return liveUser(event.userId, bindings);

  const bySubscription = await bindings.db.prepare(`
    SELECT user_id FROM subscriptions
     WHERE provider = ? AND external_subscription_id = ?
     ORDER BY updated_at DESC LIMIT 1
  `).bind(PROVIDER, event.subscriptionId).first<{ user_id: string }>();
  if (bySubscription?.user_id) return liveUser(bySubscription.user_id, bindings);

  if (!event.customerId) return null;
  const byCustomer = await bindings.db.prepare(`
    SELECT user_id FROM subscriptions
     WHERE provider = ? AND external_customer_id = ?
     ORDER BY updated_at DESC LIMIT 1
  `).bind(PROVIDER, event.customerId).first<{ user_id: string }>();
  return byCustomer?.user_id ? liveUser(byCustomer.user_id, bindings) : null;
}

function prepaidAmount(payload: unknown): number {
  const source = payload as {
    data?: { object?: { amount_total?: unknown } };
  };
  const amount = source?.data?.object?.amount_total;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("verified Stripe prepaid event has no positive amount_total");
  }
  return amount;
}

function subscriptionRowId(subscriptionId: string): string {
  return `stripe:subscription:${subscriptionId}`;
}

function prepaidSubscriptionRowId(paymentIntentId: string): string {
  return `stripe:prepaid:${paymentIntentId}`;
}

function receiptStatement(
  bindings: BandUpCloudflareBindings,
  eventId: string,
  eventAt: string,
  receipt: { objectKey: string | null; sha256: string },
  token: string,
  processedAt: string,
): D1PreparedStatement {
  return bindings.db.prepare(`
    INSERT INTO provider_events (
      provider, event_id, received_at, processed_at,
      payload_object_key, payload_sha256, claim_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, event_id) DO NOTHING
  `).bind(
    PROVIDER,
    eventId,
    canonicalCloudflareSourceClock(eventAt),
    processedAt,
    receipt.objectKey,
    receipt.sha256,
    token,
  );
}

/** Writes a current Stripe subscription event, preserving duplicate and stale semantics. */
export async function applyNativeStripeSubscription(
  event: StripeSubscriptionEvent,
  payload: unknown,
  providedBindings?: BandUpCloudflareBindings,
): Promise<ApplyOutcome> {
  assertServerOnly(MODULE);
  const bindings = await bindingsFor(providedBindings);
  const userId = await resolveSubscriptionUser(event, bindings);
  if (!userId) return "unknown_user";

  const token = claimToken();
  const now = currentCloudflareSourceClock();
  const receipt = await storeJson(bindings, "provider-events", userId, payload, { forceObject: true });
  const subscription = await storeJson(bindings, "subscriptions", userId, payload);
  const eventAt = canonicalCloudflareSourceClock(event.eventAt);

  const results = await bindings.db.batch([
    receiptStatement(bindings, event.eventId, event.eventAt, receipt, token, now),
    bindings.db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, provider, status, tier, external_customer_id,
        external_subscription_id, external_price_id, current_period_end,
        cancel_at_period_end, provider_event_at, verified_at,
        raw_inline, raw_object_key, raw_sha256, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM provider_events
          WHERE provider = ? AND event_id = ? AND claim_token = ?
       )
         AND EXISTS (
           SELECT 1 FROM app_users
            WHERE id = ? AND deleted_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
         )
      ON CONFLICT(provider, external_subscription_id)
       WHERE external_subscription_id IS NOT NULL
      DO UPDATE SET
        user_id = excluded.user_id,
        status = excluded.status,
        tier = excluded.tier,
        external_customer_id = coalesce(excluded.external_customer_id, subscriptions.external_customer_id),
        external_price_id = coalesce(excluded.external_price_id, subscriptions.external_price_id),
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        provider_event_at = excluded.provider_event_at,
        verified_at = excluded.verified_at,
        raw_inline = excluded.raw_inline,
        raw_object_key = excluded.raw_object_key,
        raw_sha256 = excluded.raw_sha256,
        updated_at = excluded.updated_at
       WHERE subscriptions.provider_event_at IS NULL
          OR excluded.provider_event_at >= subscriptions.provider_event_at
    `).bind(
      subscriptionRowId(event.subscriptionId),
      userId,
      PROVIDER,
      event.status,
      event.tier,
      event.customerId,
      event.subscriptionId,
      event.priceId,
      event.currentPeriodEnd ? canonicalCloudflareSourceClock(event.currentPeriodEnd) : null,
      event.cancelAtPeriodEnd ? 1 : 0,
      eventAt,
      now,
      subscription.inline,
      subscription.objectKey,
      subscription.sha256,
      now,
      now,
      PROVIDER,
      event.eventId,
      token,
      userId,
      userId,
    ),
  ]);

  if (d1Changes(results[0]!) === 0) return "duplicate";
  if (d1Changes(results[1]!) > 0) return "applied";
  return (await liveUser(userId, bindings)) ? "stale" : "unknown_user";
}

/** Grants a one-time pass only once, and extends an existing live pass of the same tier. */
export async function applyNativeStripePrepaidPurchase(
  event: StripePrepaidPurchaseEvent,
  payload: unknown,
  providedBindings?: BandUpCloudflareBindings,
): Promise<PrepaidApplyOutcome> {
  assertServerOnly(MODULE);
  const bindings = await bindingsFor(providedBindings);
  const userId = await liveUser(event.userId, bindings);
  if (!userId) return "unknown_user";
  const amountMinor = prepaidAmount(payload);
  const token = claimToken();
  const now = currentCloudflareSourceClock();
  const eventAt = canonicalCloudflareSourceClock(event.eventAt);
  const receipt = await storeJson(bindings, "provider-events", userId, payload, { forceObject: true });
  const subscription = await storeJson(bindings, "subscriptions", userId, payload);
  const rowId = prepaidSubscriptionRowId(event.paymentIntentId);

  const results = await bindings.db.batch([
    receiptStatement(bindings, event.eventId, event.eventAt, receipt, token, now),
    bindings.db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, provider, status, tier, external_customer_id,
        external_subscription_id, external_price_id, current_period_end,
        cancel_at_period_end, provider_event_at, verified_at,
        raw_inline, raw_object_key, raw_sha256, created_at, updated_at
      )
      SELECT ?, ?, 'stripe', 'active', ?, ?, ?, ?,
        strftime(
          '%Y-%m-%dT%H:%M:%f000000Z',
          coalesce(
            (
              SELECT max(current_period_end) FROM subscriptions
               WHERE user_id = ? AND provider = 'stripe' AND tier = ?
                 AND status IN ('active', 'trialing')
                 AND current_period_end > ?
            ),
            ?
          ),
          CASE ? WHEN 'month' THEN '+1 month' ELSE '+1 year' END
        ),
        1, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM provider_events
          WHERE provider = 'stripe' AND event_id = ? AND claim_token = ?
       )
         AND EXISTS (
           SELECT 1 FROM app_users WHERE id = ? AND deleted_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions
            WHERE provider = 'stripe' AND external_subscription_id = ?
         )
    `).bind(
      rowId,
      userId,
      event.tier,
      event.customerId,
      event.paymentIntentId,
      `wallet:${event.planId}`,
      userId,
      event.tier,
      eventAt,
      eventAt,
      event.interval,
      eventAt,
      now,
      subscription.inline,
      subscription.objectKey,
      subscription.sha256,
      now,
      now,
      event.eventId,
      token,
      userId,
      userId,
      event.paymentIntentId,
    ),
    bindings.db.prepare(`
      INSERT INTO stripe_prepaid_purchases (
        payment_intent_id, user_id, subscription_id, amount_minor, created_at
      )
      SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM provider_events
          WHERE provider = 'stripe' AND event_id = ? AND claim_token = ?
       )
         AND EXISTS (SELECT 1 FROM subscriptions WHERE id = ?)
      ON CONFLICT(payment_intent_id) DO NOTHING
    `).bind(
      event.paymentIntentId,
      userId,
      rowId,
      amountMinor,
      now,
      event.eventId,
      token,
      rowId,
    ),
  ]);

  if (d1Changes(results[0]!) === 0) return "duplicate";
  if (d1Changes(results[1]!) > 0 && d1Changes(results[2]!) > 0) return "applied";
  return (await liveUser(userId, bindings)) ? "duplicate" : "unknown_user";
}

/** Applies a full verified refund while retaining partial refunds as receipts only. */
export async function applyNativeStripePrepaidRefund(
  event: StripePrepaidRefundEvent,
  payload: unknown,
  providedBindings?: BandUpCloudflareBindings,
): Promise<PrepaidApplyOutcome> {
  assertServerOnly(MODULE);
  const bindings = await bindingsFor(providedBindings);
  const purchase = await bindings.db.prepare(`
    SELECT p.user_id, p.subscription_id, p.amount_minor, s.provider_event_at
      FROM stripe_prepaid_purchases p
      JOIN subscriptions s ON s.id = p.subscription_id
     WHERE p.payment_intent_id = ?
       AND s.provider = 'stripe' AND s.external_subscription_id = ?
     LIMIT 1
  `).bind(event.paymentIntentId, event.paymentIntentId).first<PrepaidPurchaseRow>();
  if (!purchase) return "unknown_purchase";

  const token = claimToken();
  const now = currentCloudflareSourceClock();
  const receipt = await storeJson(bindings, "provider-events", purchase.user_id, payload, { forceObject: true });
  const fullRefund = event.fullRefundConfirmed || event.amountMinor === purchase.amount_minor;
  const statements: D1PreparedStatement[] = [
    receiptStatement(bindings, event.eventId, event.eventAt, receipt, token, now),
  ];

  let replacement: Awaited<ReturnType<typeof storeJson>> | null = null;
  if (fullRefund) {
    replacement = await storeJson(bindings, "subscriptions", purchase.user_id, payload);
    statements.push(bindings.db.prepare(`
      UPDATE subscriptions
         SET status = 'refunded', cancel_at_period_end = 1,
             provider_event_at = ?, verified_at = ?,
             raw_inline = ?, raw_object_key = ?, raw_sha256 = ?, updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM provider_events
            WHERE provider = 'stripe' AND event_id = ? AND claim_token = ?
         )
         AND (provider_event_at IS NULL OR ? >= provider_event_at)
         AND EXISTS (
           SELECT 1 FROM app_users WHERE id = ? AND deleted_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
         )
    `).bind(
      canonicalCloudflareSourceClock(event.eventAt),
      now,
      replacement.inline,
      replacement.objectKey,
      replacement.sha256,
      now,
      purchase.subscription_id,
      event.eventId,
      token,
      canonicalCloudflareSourceClock(event.eventAt),
      purchase.user_id,
      purchase.user_id,
    ));
  }

  const results = await bindings.db.batch(statements);
  if (d1Changes(results[0]!) === 0) return "duplicate";
  if (!fullRefund) return "partial_refund";
  if (d1Changes(results[1]!) > 0) return "applied";
  return (await liveUser(purchase.user_id, bindings)) ? "stale" : "unknown_purchase";
}
