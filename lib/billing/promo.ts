import { assertServerOnly } from "@/lib/auth/server-only";
import {
  insertPromoSubscription,
  promoProviderAllowed,
  promoSubscriptionState,
  releasePromoSubscription,
  resumePromoSubscription,
  promoSubscriptionReplica,
} from "@/lib/auth/supabase";
import { mirrorsWritesToCloudflare } from "@/lib/cloudflare/bindings";
import { domainWritesToCloudflareOnly } from "@/lib/cloudflare/cutover-domains";
import {
  nativeInsertPromoSubscription,
  nativePromoSubscriptionState,
  nativeReleasePromoSubscription,
  nativeResumePromoSubscription,
} from "@/lib/cloudflare/native-promo";
import { replicatePromoSubscriptionDurably } from "@/lib/cloudflare/replica-replay";
import { resolveEntitlement } from "./entitlements";
import type { Tier } from "./tiers";

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
  Giving it up, and why that is not just a cancel

  A learner may hand the trial back, and the owner has decided that doing so is
  reversible: the offer comes back and they may take it again. That makes two
  ways for a grant to stop granting, and they must not look alike —

    the learner set it down     offer it again
    the owner withdrew it       never offer it again

  Both used to be `status = 'canceled'`. Now a learner's release writes
  `status = 'paused'` instead, which the status CHECK already allowed and which
  `resolve_entitlement` does not count. Why that column and not another, and
  what it costs the owner in their SQL, is written out where the write happens —
  see `releasePromoSubscription` in lib/auth/supabase.ts. The short version is
  that the owner's sweep must now read

    where provider = 'promo' and status in ('active', 'paused')

  so that withdrawing the trial reaches the accounts that had already handed it
  back. Their old statement is still correct about everything it touches: what it
  sets to 'canceled' is never offered again.

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
const NATIVE_PROBE_USER = "00000000-0000-0000-0000-000000000000";

function nativePromoAuthority(): boolean {
  return domainWritesToCloudflareOnly("billing_entitlement_runtime");
}

export function forgetPromoCapability(): void {
  capability = null;
}

export async function promoWriteSupported(now = Date.now()): Promise<boolean> {
  assertServerOnly(MODULE);
  if (capability && (capability.allowed || now - capability.at < NEGATIVE_TTL_MS)) {
    return capability.allowed;
  }
  /*
    In the one-way Cloudflare mode the D1 migration already carries the promo
    provider constraint.  Ask the real table rather than retaining a
    Supabase-only capability probe which would make a fully migrated account
    appear unable to take its trial.  The impossible all-zero id writes
    nothing; this is only a schema/binding availability probe.
  */
  const allowed = nativePromoAuthority()
    ? await nativePromoSubscriptionState(NATIVE_PROBE_USER).then(() => true).catch(() => false)
    : await promoProviderAllowed();
  capability = { allowed, at: now };
  return allowed;
}

async function promoState(userId: string) {
  return nativePromoAuthority()
    ? nativePromoSubscriptionState(userId)
    : promoSubscriptionState(userId);
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
  /**
   * Whether the trial itself is what is granting Pro to this account right now.
   *
   * It rides along with the offer because both answers come out of the same
   * `resolve_entitlement` call, and asking twice would cost a second round trip
   * to learn something already in hand. It is exactly the condition for showing
   * the give-up control: not a paying subscriber, whose source is stripe or
   * apple, and not the owner, whose source is role.
   */
  grantHeld: boolean;
}

/**
 * Answers the poster's question, server-side.
 *
 * A promo row means the account has answered, and the answer is not re-asked —
 * with one exception, which is the whole of this feature: a row the learner
 * released is offerable again. A row the *owner* ended is not, ever. The two are
 * different statuses, so they are different answers here; see
 * `promoSubscriptionState`.
 */
export async function promoOfferFor(
  userId: string | null,
  email: string | null,
): Promise<PromoOffer> {
  assertServerOnly(MODULE);
  if (!userId) return { offered: false, reason: "signed-out", grantHeld: false };

  const entitlement = await resolveEntitlement(userId, email);
  const grantHeld = entitlement.source === "promo";
  if (alreadyCovered(entitlement.tier)) {
    return { offered: false, reason: "already-pro", grantHeld };
  }

  if (!(await promoWriteSupported())) {
    return { offered: false, reason: "not-open", grantHeld: false };
  }
  const state = await promoState(userId);
  if (state === "none" || state === "released") {
    return { offered: true, reason: "offered", grantHeld: false };
  }
  return { offered: false, reason: "already-decided", grantHeld: false };
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
 * Note what is *not* checked: the promo row. A subscriber has not been offered
 * the trial, so they have no promo row, and looking for one would only cost a
 * query to learn something already known.
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
 * Takes the offer up, whether for the first time or again after giving it up.
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

  const state = await promoState(userId);
  /*
    A row that no longer grants anything and was not the learner's own doing:
    the owner ended the trial. Say so, rather than writing a second row that
    would quietly undo their decision.
  */
  if (state === "ended") return "ended";
  // Unreachable while the entitlement above is authoritative, and answered
  // rather than assumed away: a standing grant needs nothing written.
  if (state === "holding") return "already-pro";

  if (state === "released") {
    /*
      Their own trial, started again — the same row, revived. A second row would
      work equally well today and would leave the account with two grants and no
      record of which one the owner's sweep has already dealt with.
    */
    const resumed = nativePromoAuthority()
      ? await nativeResumePromoSubscription(userId)
      : await resumePromoSubscription(userId);
    if (resumed === "changed") {
      /*
        The resumed row is a status change on a row D1 may already hold, not a
        new grant, and mirrorPromoBestEffort carries whatever status the row now
        holds. Without this the mirror would still show the paused row and a D1
        read would resolve a learner who had just taken the trial back to free.
      */
      await mirrorPromoBestEffort(userId);
      return "granted";
    }
    // The owner's sweep landed between the read and the write, so the row is
    // 'canceled' now and matched nothing. Their decision stands.
    if (resumed === "no-match") return "ended";
    if (resumed === "unsupported") {
      forgetPromoCapability();
      return "not-open";
    }
    return "failed";
  }

  const outcome = nativePromoAuthority()
    ? await nativeInsertPromoSubscription(userId)
    : await insertPromoSubscription(userId);
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

export type ReleaseOutcome =
  /** The grant is paused. The account is on whatever it holds without it. */
  | "released"
  /** Nothing to give up: no trial is granting this account anything. */
  | "not-held"
  /** The row cannot be written at all — the provider widening was rolled back. */
  | "not-open"
  | "failed";

export interface ReleaseResult {
  outcome: ReleaseOutcome;
  /**
   * The tier the account holds now that the trial is not granting anything, so
   * the confirmation can name it instead of asserting "the free plan".
   *
   * It is almost always free, and the exception is the reason this is here: an
   * account can hold both a promo grant and a paid subscription — the grant is
   * the more generous row, so it is the one that was answering — and telling
   * somebody who is still paying for Plus that they are on the free plan would
   * be a false sentence in front of exactly the person who would notice.
   *
   * Null unless something was actually released; there is nothing to name
   * otherwise.
   */
  tier: Tier | null;
}

/**
 * Gives the trial up.
 *
 * Re-established from the session in the same way accepting is: the client says
 * only "yes", and both *which* account and *whether it holds a trial at all* are
 * answered here. There is no parameter through which a caller could name another
 * account, another tier or another status. See ACCOUNTS.md, threat 3.
 *
 * The gate is `source === "promo"` — the trial is what is granting Pro right
 * now. A paying subscriber's source is stripe or apple and the owner's is role,
 * so neither can release anything through this, even by calling it directly.
 * And the UPDATE only ever touches rows whose provider is 'promo', so a paid
 * subscription cannot be cancelled by any path through this route.
 */
export async function releasePromo(
  userId: string | null,
  email: string | null,
): Promise<ReleaseResult> {
  assertServerOnly(MODULE);
  if (!userId) return { outcome: "not-held", tier: null };

  const entitlement = await resolveEntitlement(userId, email);
  if (entitlement.source !== "promo") return { outcome: "not-held", tier: null };

  const outcome = nativePromoAuthority()
    ? await nativeReleasePromoSubscription(userId)
    : await releasePromoSubscription(userId);
  if (outcome === "unsupported") {
    forgetPromoCapability();
    return { outcome: "not-open", tier: null };
  }
  if (outcome === "failed") return { outcome: "failed", tier: null };
  /*
    `no-match` joins `changed` rather than becoming an error. It means no row was
    live to pause: the button was pressed twice, or the owner's sweep landed in
    between. The learner asked for the trial to stop granting and it is not
    granting, so the true answer to them is the same one — and the tier below is
    resolved rather than assumed, which makes it true in that case too.
  */
  /*
    Same reasoning as the resume path: pausing is a status change on a row the
    mirror already holds, and a D1 read that still saw 'active' would keep
    granting Pro to somebody who has just given it back.
  */
  await mirrorPromoBestEffort(userId);
  const after = await resolveEntitlement(userId, email);
  return { outcome: "released", tier: after.tier };
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
