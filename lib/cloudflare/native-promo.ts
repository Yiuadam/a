import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { storeJson } from "./payloads";
import { currentCloudflareSourceClock } from "./source-clock";

/*
  The Cloudflare-only writer for the optional free-Pro trial.

  A promotion is deliberately kept separate from Stripe: it moves no money,
  has no provider webhook, and is safe to make D1-authoritative before the
  Stripe webhook writer is moved.  The public billing module selects these
  operations only in `CLOUDFLARE_DATA_MODE=cloudflare`; dual and
  read_cloudflare deployments continue to use their existing Supabase writer
  and replica path.

  The narrow API here is important.  It does not accept a tier, an expiry or a
  provider from a browser.  Every native row is the same `promo / active /
  pro` entitlement and every operation re-establishes the row's state in D1.
*/

const MODULE = "lib/cloudflare/native-promo.ts";
const PROVIDER = "promo";
const RELEASED = "paused";

export type NativePromoRowState = "none" | "holding" | "released" | "ended";
export type NativePromoUpdateOutcome = "changed" | "no-match" | "failed";
export type NativePromoInsertOutcome = "inserted" | "exists" | "failed";

interface PromoStatusRow {
  status: string;
}

async function bindingsFor(
  providedBindings?: BandUpCloudflareBindings,
): Promise<BandUpCloudflareBindings> {
  return providedBindings ?? requireBandUpCloudflareBindings();
}

/** A deleted D1 account must never be revived by a late trial request. */
async function liveAccount(
  userId: string,
  bindings: BandUpCloudflareBindings,
): Promise<boolean> {
  const row = await bindings.db.prepare(`
    SELECT id FROM app_users
     WHERE id = ? AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = app_users.id
       )
     LIMIT 1
  `).bind(userId).first<{ id: string }>();
  return row?.id === userId;
}

/**
 * Reduces all rows defensively.  A cancelled row always wins: it represents
 * the owner's irreversible withdrawal, and must not be undone by an old
 * active row left by a historical retry.
 */
export async function nativePromoSubscriptionState(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativePromoRowState> {
  assertServerOnly(MODULE);
  const bindings = await bindingsFor(providedBindings);
  const rows = await bindings.db.prepare(`
    SELECT status FROM subscriptions
     WHERE user_id = ? AND provider = ?
  `).bind(userId, PROVIDER).all<PromoStatusRow>();
  const statuses = rows.results.map((row) => row.status);
  if (statuses.length === 0) return "none";
  if (statuses.some((status) => status !== "active" && status !== "trialing" && status !== RELEASED)) {
    return "ended";
  }
  if (statuses.some((status) => status === "active" || status === "trialing")) return "holding";
  return "released";
}

async function promoPayload(
  userId: string,
  value: Record<string, unknown>,
  bindings: BandUpCloudflareBindings,
) {
  return storeJson(bindings, "subscriptions", userId, value);
}

/**
 * Creates the sole D1 promo row for an account.  The stable primary key makes
 * concurrent accepts collapse to an ordinary duplicate rather than creating
 * multiple grants, even before every historical mirror is known to be clean.
 */
export async function nativeInsertPromoSubscription(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativePromoInsertOutcome> {
  assertServerOnly(MODULE);
  const bindings = await bindingsFor(providedBindings);
  if (!(await liveAccount(userId, bindings))) return "failed";

  const now = currentCloudflareSourceClock();
  const stored = await promoPayload(userId, {
    kind: "free-pro-trial",
    acceptedAt: now,
  }, bindings);

  try {
    const result = await bindings.db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, provider, status, tier, current_period_end,
        cancel_at_period_end, verified_at,
        raw_inline, raw_object_key, raw_sha256, created_at, updated_at
      )
      SELECT ?, ?, ?, 'active', 'pro', NULL, 0, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM app_users
          WHERE id = ? AND deleted_at IS NULL
       )
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions WHERE user_id = ? AND provider = ?
         )
    `).bind(
      `promo:${userId}`,
      userId,
      PROVIDER,
      now,
      stored.inline,
      stored.objectKey,
      stored.sha256,
      now,
      now,
      userId,
      userId,
      userId,
      PROVIDER,
    ).run();
    if (!result.success) return "failed";
    if ((result.meta.changes ?? 0) > 0) return "inserted";
    return (await nativePromoSubscriptionState(userId, bindings)) === "none" ? "failed" : "exists";
  } catch {
    // The deletion trigger intentionally appears to callers as a failed write.
    return "failed";
  }
}

async function updateNativePromo(
  userId: string,
  from: readonly string[],
  to: "active" | "paused",
  payload: Record<string, unknown>,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativePromoUpdateOutcome> {
  assertServerOnly(MODULE);
  const bindings = await bindingsFor(providedBindings);
  if (!(await liveAccount(userId, bindings))) return "failed";
  const now = currentCloudflareSourceClock();
  const stored = await promoPayload(userId, payload, bindings);
  const marks = from.map(() => "?").join(", ");
  try {
    const result = await bindings.db.prepare(`
      UPDATE subscriptions
         SET status = ?, verified_at = ?, raw_inline = ?, raw_object_key = ?,
             raw_sha256 = ?, updated_at = ?
       WHERE user_id = ? AND provider = ? AND status IN (${marks})
         AND EXISTS (
           SELECT 1 FROM app_users WHERE id = ? AND deleted_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
         )
    `).bind(
      to,
      now,
      stored.inline,
      stored.objectKey,
      stored.sha256,
      now,
      userId,
      PROVIDER,
      ...from,
      userId,
      userId,
    ).run();
    if (!result.success) return "failed";
    return (result.meta.changes ?? 0) > 0 ? "changed" : "no-match";
  } catch {
    return "failed";
  }
}

/** The learner sets a live grant down; only this transition is reversible. */
export function nativeReleasePromoSubscription(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativePromoUpdateOutcome> {
  const now = currentCloudflareSourceClock();
  return updateNativePromo(userId, ["active", "trialing"], RELEASED, {
    kind: "free-pro-trial",
    releasedAt: now,
  }, providedBindings);
}

/** The learner resumes only a grant they previously released themselves. */
export function nativeResumePromoSubscription(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativePromoUpdateOutcome> {
  const now = currentCloudflareSourceClock();
  return updateNativePromo(userId, [RELEASED], "active", {
    kind: "free-pro-trial",
    acceptedAt: now,
    restarted: true,
  }, providedBindings);
}

