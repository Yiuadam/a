/*
  Whether the access somebody holds will renew itself, or will simply stop.

  ---------------------------------------------------------------------------
  Why this exists at all

  `resolve_entitlement` answers what a learner may do and until when. It has
  never answered *why*, and one date on an account now means one of two opposite
  things:

    a card subscription  — it renews, and the money goes out again on that date
    a wallet pass        — it ends, and the account drops back to Free

  Both have existed since Alipay and WeChat Pay were added, and every screen has
  been printing "Renews on" for both, because that is all the entitlement said.
  For a pass holder that is false in the way that costs somebody their access
  with no warning: they have no reason to expect the tutor to stop. So the
  difference is established here, in a pure function, rather than in a new
  database column — a column means a migration, a migration cannot be previewed,
  and every fact needed is already in the row.

  ---------------------------------------------------------------------------
  How a pass is told from a subscription

  By `external_price_id`. supabase/migrations/0016 writes a prepaid wallet row
  with `'wallet:' || plan_id` there, where a card subscription carries the Stripe
  Price id it charges. That is the same marker `apply_stripe_prepaid_refund_event`
  matches a refund against (`like 'wallet:%'`), so it is the marker with a
  database function already depending on it rather than a convention invented
  here.

  Nothing here is a security decision. It chooses which sentence a screen prints
  about a date the server already resolved; what a learner may *do* is decided
  in `resolve_entitlement` and in lib/billing/gate.ts, and neither reads this.
*/

/** The prefix supabase/migrations/0016 writes into a prepaid pass's price id. */
export const PASS_PRICE_PREFIX = "wallet:";

/** As much of a `subscriptions` row as deciding "does this renew?" needs. */
export interface AccessGrant {
  provider: string;
  tier: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** Whether one row is a prepaid pass rather than a renewing subscription. */
export function isPassGrant(grant: AccessGrant): boolean {
  return grant.priceId !== null && grant.priceId.startsWith(PASS_PRICE_PREFIX);
}

/**
 * Whether one row will charge again by itself.
 *
 * Three ways it will not, and they are different things:
 *
 *   a pass — one payment, already made, nothing scheduled
 *   a subscription already set to end at the period end — the learner cancelled
 *     and keeps what they paid for
 *   the free Pro trial — provider 'promo', a grant rather than a purchase, and
 *     it has no period end at all, so no date is printed for it either way
 */
export function grantRenews(grant: AccessGrant): boolean {
  if (isPassGrant(grant)) return false;
  if (grant.provider === "promo") return false;
  return !grant.cancelAtPeriodEnd;
}

/**
 * Whether the grant that produced this entitlement will renew — or null when
 * that cannot be established.
 *
 * The row is identified by matching the entitlement rather than by re-running
 * the resolver's ordering in TypeScript. That ordering lives in
 * supabase/migrations/0026 and involves tier rank, period end, verification time
 * and row id; a second copy of it here would be a second thing to keep in step,
 * and the first time the two disagreed a subscriber would be told their
 * subscription was a pass. What the entitlement already tells us — the tier that
 * won and the instant it ends — is enough to find the row that won.
 *
 * Null rather than a guess when no row matches, because both sentences are wrong
 * in that case and the caller has a third one that is not: the date, and no
 * claim about what happens on it.
 */
export function entitlementRenews(
  /* Structural rather than `Entitlement`, so this file imports nothing at all
     and can be unit-tested without a database or an environment. */
  entitlement: { tier: string; expiresAt: string | null },
  grants: readonly AccessGrant[],
): boolean | null {
  if (entitlement.expiresAt === null) return null;
  const endsAt = Date.parse(entitlement.expiresAt);
  if (!Number.isFinite(endsAt)) return null;

  /*
    Compared as instants, not as strings. Both values are the same timestamptz
    column, but one arrived through a composite type returned by an RPC and the
    other through a PostgREST select, and those two need not spell an offset the
    same way.
  */
  const matching = grants.filter(
    (grant) =>
      grant.tier === entitlement.tier &&
      grant.currentPeriodEnd !== null &&
      Date.parse(grant.currentPeriodEnd) === endsAt,
  );
  if (matching.length === 0) return null;

  /*
    Two rows can end on the same instant for the same tier — a pass bought to
    extend a subscription that was already running, for instance. If any of them
    renews, money will leave that account on that date, and that is the fact
    worth printing.
  */
  return matching.some(grantRenews);
}
