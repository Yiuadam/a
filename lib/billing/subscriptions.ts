import { assertServerOnly } from "@/lib/auth/server-only";
import { rpc } from "@/lib/auth/supabase";
import type { Provider } from "./providers";
import type { StripeSubscriptionEvent } from "./stripe";

/*
  The one place a subscription comes into existence.

  Everything in this file goes through the service role, which only server code
  holds, and every argument it passes has been established by the server: the
  account came out of metadata this application itself wrote into Stripe at
  checkout, or out of a row this database already held. Nothing a client said
  about itself reaches here. ACCOUNTS.md, threat 3.

  The interesting decisions are all in supabase/migrations/0009_billing_webhooks
  .sql rather than here, and deliberately so. Recording the event id, refusing a
  duplicate, refusing an out-of-order redelivery and writing the row are one
  database call because they have to be one transaction — claim the event over
  here and write the row over there, and a crash in between leaves a learner who
  has paid with a redelivery that gets refused as already handled.
*/

const MODULE = "lib/billing/subscriptions.ts";

/**
 * What became of an event.
 *
 * All four are ordinary outcomes rather than errors. Three of them mean the
 * database already holds the right answer; `unknown_user` means the event
 * belongs to a Stripe subscription this deployment cannot tie to an account,
 * which is worth a log line and is not worth a retry.
 */
export type ApplyOutcome = "applied" | "duplicate" | "stale" | "unknown_user";

function isOutcome(value: unknown): value is ApplyOutcome {
  return (
    value === "applied" || value === "duplicate" || value === "stale" || value === "unknown_user"
  );
}

/**
 * Writes a verified Stripe subscription event, or explains why it did not.
 *
 * Throws only when the database could not be reached. The caller answers Stripe
 * with a 500 in that case, which is the one situation where a redelivery is
 * genuinely useful.
 */
export async function applyStripeSubscription(
  event: StripeSubscriptionEvent,
  payload: unknown,
): Promise<ApplyOutcome> {
  assertServerOnly(MODULE);

  const outcome = await rpc<unknown>("apply_provider_subscription_event", {
    p_provider: "stripe" satisfies Provider,
    p_event_id: event.eventId,
    p_event_at: event.eventAt,
    /*
      The provider's payload is stored as it arrived. It is the evidence: if a
      charge is ever queried, or a decision here turns out to be wrong, this is
      what the decision was made from. The alternative — storing only the fields
      this code understood — throws away exactly the part that would explain a
      surprise.
    */
    p_payload: payload,
    p_user_id: event.userId,
    p_status: event.status,
    p_tier: event.tier,
    p_customer_id: event.customerId,
    p_subscription_id: event.subscriptionId,
    p_price_id: event.priceId,
    p_current_period_end: event.currentPeriodEnd,
    p_cancel_at_period_end: event.cancelAtPeriodEnd,
  });

  // The function always returns one of the four. Anything else means the
  // database is not the one this code was written against, which is treated as
  // a failure rather than quietly read as success.
  if (!isOutcome(outcome)) {
    throw new Error(`unrecognised outcome from apply_provider_subscription_event`);
  }
  return outcome;
}

/**
 * The Stripe customer id belonging to an account, or null.
 *
 * Only ever called with a user id the server resolved from a bearer token, so
 * "the caller's own customer" is a statement about the token rather than about
 * anything in the request body.
 */
export async function stripeCustomerFor(userId: string): Promise<string | null> {
  assertServerOnly(MODULE);
  const value = await rpc<unknown>("provider_customer_for_user", {
    p_user_id: userId,
    p_provider: "stripe" satisfies Provider,
  });
  return typeof value === "string" && value.length > 0 ? value : null;
}
