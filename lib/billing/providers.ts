import type { Tier } from "./entitlements";

/*
  The seam for phase 3. Nothing here talks to Stripe or to Apple yet; this file
  fixes the shape of the answer both of them must produce, so that neither can
  quietly become a second source of truth.

  The rule both providers obey: a subscription row is written only from
  something the server itself verified — a Stripe webhook whose signature
  checked out, or an App Store transaction the server re-fetched from Apple. A
  purchase reported by the app is a hint that it is worth going and asking; it
  is never itself the answer. See ACCOUNTS.md, threat 3.
*/

export type Provider = "stripe" | "apple";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "expired"
  | "paused"
  | "refunded";

/**
 * The normalised result of verifying an entitlement with a provider. Both
 * providers must produce this, and only this, so the resolver never has to
 * know which one a user bought through.
 */
export interface VerifiedSubscription {
  provider: Provider;
  userId: string;
  status: SubscriptionStatus;
  tier: Tier;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  /** Apple only: the stable id that survives renewals. */
  originalTransactionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** The provider payload, stored so a decision can be re-derived later. */
  raw: unknown;
}

/**
 * A provider adapter. Phase 3 implements one of these per provider and writes
 * the result through a single server-side upsert, so there is exactly one
 * place where an entitlement can come into existence.
 */
export interface BillingProvider {
  readonly name: Provider;
  /**
   * Turns a verified provider event into a subscription record. Implementations
   * must verify authenticity *before* returning — a signature check for Stripe,
   * a signed-transaction check against Apple's public keys for App Store
   * Server Notifications v2 — and must throw if it fails.
   */
  verify(payload: unknown, signature: string | null): Promise<VerifiedSubscription>;
}
