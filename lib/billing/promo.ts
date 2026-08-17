import { assertServerOnly } from "@/lib/auth/server-only";
import {
  insertPromoSubscription,
  promoProviderAllowed,
  promoSubscriptionExists,
  promoSubscriptionReplica,
} from "@/lib/auth/supabase";
import { mirrorsWritesToCloudflare } from "@/lib/cloudflare/bindings";
import { replicatePromoSubscriptionDurably } from "@/lib/cloudflare/replica-replay";
import { resolveEntitlement } from "./entitlements";

/*
  The free Pro trial.

  ---------------------------------------------------------------------------
  What it is

  Every account is offered Pro for nothing, until the owner decides to stop.
  Accepting is a deliberate act — a poster explains the offer and the learner
  presses a button — because an entitlement that appears on its own is one
  nobody was told about, and one nobody was told about cannot be ended fairly.

  ---------------------------------------------------------------------------
  Why there is no new table and no new resolver

  A grant is an ordinary row in `public.subscriptions`: provider 'promo',
  status 'active', tier 'pro', `current_period_end` null. `resolve_entitlement`
  (supabase/migrations/0026) already takes the most generous row whose status is
  active or trialing and whose period has not ended, so such a row resolves to
  Pro for as long as it stands, composes correctly with a real paid
  subscription — the paid row wins nothing and loses nothing, because both say
  Pro — and needs no second place where an entitlement can be decided.

  Ending the trial is therefore one UPDATE the owner runs, setting every promo
  row's status to 'canceled'. It is written out in the pull request.

  ---------------------------------------------------------------------------
  Why the code checks whether the write is possible

  `subscriptions_provider_check` in supabase/migrations/0001 allows 'stripe' and
  'apple' only. Widening it is a migration, and a migration cannot be previewed:
  applying one changes production there and then. So this build does not assume
  it has been applied. It asks — see `promoProviderAllowed` — and until the
  answer is yes the poster is never drawn and accepting answers with a sentence
  rather than a 500.

  ---------------------------------------------------------------------------
  Why a grant is now also mirrored to Cloudflare

  D1's `subscriptions.provider` CHECK has the identical problem one layer
  further along: it allowed only `('stripe', 'apple')` until the pull request
  that added this comment widened it by hand, the same way its Supabase
  counterpart was. A grant made before that ran, or made while
  `mirrorsWritesToCloudflare()` is false, simply is not in D1 — the resolver at
  lib/cloudflare/entitlement-runtime.ts finds no subscription row for that
  account and reports free, silently, which is exactly the bug the pull
  request describes and the backfill it also describes is how existing grants
  stop being invisible to a D1 read. `mirrorPromoBestEffort` below is the
  write side going forward: same best-effort shape as
  lib/billing/subscriptions.ts's replicateBillingBestEffort, so a mirror
  failure costs a row of drift, not a trial the learner was told they got.
*/

const MODULE = "lib/billing/promo.ts";

/**
 * The probe costs a round trip, and the answer changes at most once in the life
 * of this deployment. Cache it: for ever once it is yes, and for a minute while
 * it is still no, so the offer appears within a minute of the owner running the
 * SQL without anybody having to redeploy.
 */
let capability: { allowed: boolean; at: number } | null = null;
const NEGATIVE_TTL_MS = 60_000;

export function forgetPromoCapability(): void {
  capability = null;
}

export async function promoWriteSupported(now = Date.now()): Promise<boolean> {
  assertServerOnly(MODULE);
  if (capability && (capability.allowed || now - capability.at < NEGATIVE_TTL_MS)) {
    return capability.allowed;
  }
  const allowed = await promoProviderAllowed();
  capability = { allowed, at: now };
  return allowed;
}

/**
 * Which tiers are already at least as good as the trial, and so are never
 * shown it: a Pro subscriber would be offered what they are paying for, and the
 * owner's own account is above every tier there is.
 */
export function alreadyCovered(tier: string): boolean {
  return tier === "pro" || tier === "admin";
}

/** Whether this account should see the poster, and why not when it should not. */
export type OfferReason =
  | "offered"
  | "signed-out"
  | "already-pro"
  | "already-decided"
  | "not-open";

export interface PromoOffer {
  offered: boolean;
  reason: OfferReason;
}

/**
 * Answers the poster's question, server-side.
 *
 * A promo row in *any* status means the learner has already decided, or the
 * owner has already ended the trial for them. Either way the offer is over for
 * that account and must not come back — a trial that reappears after it was
 * withdrawn is a nag with a grievance attached.
 */
export async function promoOfferFor(
  userId: string | null,
  email: string | null,
): Promise<PromoOffer> {
  assertServerOnly(MODULE);
  if (!userId) return { offered: false, reason: "signed-out" };

  const entitlement = await resolveEntitlement(userId, email);
  if (alreadyCovered(entitlement.tier)) return { offered: false, reason: "already-pro" };

  if (!(await promoWriteSupported())) return { offered: false, reason: "not-open" };
  if (await promoSubscriptionExists(userId)) {
    return { offered: false, reason: "already-decided" };
  }
  return { offered: true, reason: "offered" };
}

/**
 * Whether this account is paying for something that is, at this moment, free.
 *
 * The trial creates a fairness problem the trial itself cannot solve: somebody
 * who subscribed last month is paying for Pro while a new account is given it.
 * They will find out. The only question is whether they find out from us or by
 * accident, and the second one is the one that reads as sharp practice.
 *
 * So a subscriber is told, on the page where they would go to cancel. Nothing
 * is cancelled for them and no refund is offered — the owner's decision — but
 * the fact is not hidden, and the sentence says plainly that they may cancel and
 * take the trial instead.
 *
 * Note what is *not* checked: `promoSubscriptionExists`. A subscriber has not
 * been offered the trial, so they have no promo row, and looking for one would
 * only cost a query to learn something already known.
 */
export async function payingWhileFree(
  userId: string | null,
  email: string | null,
): Promise<boolean> {
  assertServerOnly(MODULE);
  if (!userId) return false;

  const entitlement = await resolveEntitlement(userId, email);
  /*
    Paid, rather than merely Pro. An admin holds their tier by role and a
    trialist by promo grant; neither is paying, so neither is owed this. The
    source is the provider `resolve_entitlement` reports, so this is exactly
    "somebody is being charged for this account".
  */
  if (entitlement.source !== "stripe" && entitlement.source !== "apple") return false;

  return promoWriteSupported();
}

export type AcceptOutcome =
  | "granted"
  /** Pro already, by subscription, by role, or by a trial still standing. */
  | "already-pro"
  /** A promo row exists but no longer grants anything: the owner ended it. */
  | "ended"
  | "not-open"
  | "failed";

/**
 * Takes the offer up.
 *
 * Everything is re-established here rather than trusted from the request: the
 * client says only "yes", and which account that is comes from the session.
 */
export async function acceptPromo(
  userId: string,
  email: string | null,
): Promise<AcceptOutcome> {
  assertServerOnly(MODULE);

  const entitlement = await resolveEntitlement(userId, email);
  if (alreadyCovered(entitlement.tier)) return "already-pro";
  if (!(await promoWriteSupported())) return "not-open";
  /*
    A row exists and the entitlement above was not Pro, so the row no longer
    grants anything — the owner has ended the trial. Say that, rather than
    writing a second row that would quietly undo their decision.
  */
  if (await promoSubscriptionExists(userId)) return "ended";

  const outcome = await insertPromoSubscription(userId);
  if (outcome === "inserted") {
    await mirrorPromoBestEffort(userId);
    return "granted";
  }
  if (outcome === "exists") return "already-pro";
  if (outcome === "unsupported") {
    // The constraint changed under us between the probe and the write. Drop the
    // cached yes so the next reader is told the truth.
    forgetPromoCapability();
    return "not-open";
  }
  return "failed";
}

/**
 * Supabase has already committed by the time this runs. Best-effort in the
 * same sense `lib/billing/subscriptions.ts`'s replicateBillingBestEffort is:
 * awaited for deterministic ordering and observability, but a mirror failure
 * here must never turn a trial that was actually granted into a 500 for the
 * learner who just accepted it.
 *
 * A no-op when this deployment is not mirroring writes to Cloudflare at all
 * (`mirrorsWritesToCloudflare()` is false for `supabase` and for `cloudflare`
 * itself, which has no separate Supabase write to mirror from).
 */
async function mirrorPromoBestEffort(userId: string): Promise<void> {
  if (!mirrorsWritesToCloudflare()) return;
  try {
    const row = await promoSubscriptionReplica(userId);
    if (!row) {
      console.error("[accounts] billing/promo Cloudflare replica: no row to mirror after insert");
      return;
    }
    if (!(await replicatePromoSubscriptionDurably(row))) {
      console.error("[accounts] billing/promo Cloudflare replica: replica write returned false");
    }
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[accounts] billing/promo Cloudflare replica: ${detail}`);
  }
}
