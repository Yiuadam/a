/*
  Whose fault a failed payment attempt was — ours, or the person paying.

  ---------------------------------------------------------------------------
  Why this file exists at all

  On the morning of 16 August the site could not take a payment, and had not
  been able to for an unknown length of time. The Stripe secret key had been
  rolled and the Worker was never given the replacement, so every single
  checkout was refused with `api_key_expired`. Nothing said so. The learner saw
  "We couldn't start the checkout just now", which is deliberately vague and
  stays that way (ACCOUNTS.md, threat 7); the real reason existed only in a
  Cloudflare Worker log nobody was tailing; and it was found by accident, by
  the owner, while testing something unrelated. `npx wrangler tail bandup` and
  one click on the button was the whole diagnosis, and the whole problem is
  that somebody had to think of doing it.

  The thing that made it invisible was not the absence of a log line. The log
  line was there. It was that the log line for "Stripe will not talk to this
  deployment at all" looked exactly like the log line for "somebody who is not
  signed in pressed Subscribe" — one of which is an emergency and the other of
  which is Tuesday. A signal that fires on both is a signal nobody can watch.

  So this module answers one question, and both the live checkout routes and
  the owner's console ask it: is this refusal something only the owner can fix?

  ---------------------------------------------------------------------------
  Two faults, and where the line is

    "platform"  Stripe refused *us*. An expired or restricted key, a Price id
                that names nothing, a payment method the account has not been
                approved for, a parameter Stripe will not accept, Stripe itself
                being down. Every one of these fails for every learner on the
                site simultaneously, and none of them recovers on its own.
                Loud.

    "learner"   The person paying did something the flow does not allow, or
                their bank said no. Not a fault at all — the app is working
                exactly as designed when it refuses these — so it must not
                raise anything. Signed out, an unknown plan id and an already
                subscribed account never even reach Stripe; a declined card
                does.

  ---------------------------------------------------------------------------
  Anything unrecognised is "platform", deliberately

  The tempting default is the quiet one, because an unknown code is usually
  harmless and nobody wants a console that cries wolf. That reasoning is what
  produced a fortnight of silence. An unrecognised refusal from Stripe is, by
  definition, one nobody has thought about yet, and the cost of being wrong in
  each direction is not symmetric: a false alarm costs the owner a minute of
  reading a log line that turns out to be a declined card, and a missed alarm
  costs every sale on the site for as long as it takes somebody to notice by
  accident. `api_key_expired` itself would have been an unknown code the day
  before it happened.

  Nothing here holds a message that a caller is ever shown. Everything in this
  file is for the server log and the owner-only console.
*/

/** Whether a refusal is the owner's problem or the payer's. */
export type BillingFault = "platform" | "learner";

/** The name the checkout health probe reports itself under, in the console. */
export const CHECKOUT_CHECK_NAME = "Checkout";

/*
  Codes Stripe attaches to a refusal that is about the person paying.

  Kept as an explicit list rather than a pattern, because the fallback is
  "platform" and a pattern that accidentally matched too much would be a
  pattern that silences the alarm — the exact failure this file exists to stop.
*/
const LEARNER_CODES = new Set([
  // The bank said no, in all the shapes Stripe reports it.
  "card_declined",
  "expired_card",
  "incorrect_cvc",
  "incorrect_number",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "invalid_number",
  "card_decline_rate_limit_exceeded",
  "insufficient_funds",
  "payment_intent_authentication_failure",
  "processing_error",
  // Stripe's own address and tax-id validation of what the buyer typed.
  "invalid_tax_id",
  "postal_code_invalid",
  // Somebody pressed the button twice, or came back to a session that had
  // already been paid or had expired while the tab sat open.
  "payment_intent_unexpected_state",
  "checkout_session_completed",
  "checkout_session_expired",
]);

/*
  Codes that are unambiguously configuration or credentials — the owner's.

  These are named even though the fallback already covers them, because naming
  them is what makes the intent readable at the call site and testable here.
  `api_key_expired` is first for reasons the header explains.
*/
const PLATFORM_CODES = new Set([
  "api_key_expired",
  "invalid_api_key",
  "authentication_required_key",
  "account_invalid",
  "account_closed",
  "api_key_missing",
  "testmode_charges_only",
  "livemode_mismatch",
  // A Price id, a Product or a Customer this deployment named and Stripe has
  // never heard of. Always our configuration: the caller cannot name any of
  // them — see the plan-id indirection in lib/billing/env.ts.
  "resource_missing",
  // A payment method that is not switched on, or still sitting in Stripe's
  // "pending approval". This took Alipay down along with WeChat Pay once
  // already; see createWalletCheckoutSession.
  "payment_method_not_available",
  "payment_method_unactivated",
  "payment_method_configuration_not_found",
  "amount_too_small",
  "amount_too_large",
]);

/**
 * Classifies one refusal from Stripe.
 *
 * `status` is the HTTP status Stripe answered with, `code` its `error.code`
 * where it sent one, and `message` its `error.message`. All three are read
 * because Stripe does not populate them consistently: errors about a *thing*
 * carry a code, errors about a *request* often carry only a message — which is
 * why lib/billing/stripe.ts logs both.
 */
export function classifyStripeRefusal(
  status: number,
  code: string | null,
  message: string | null,
): BillingFault {
  if (code && LEARNER_CODES.has(code)) return "learner";
  if (code && PLATFORM_CODES.has(code)) return "platform";

  /*
    401 and 403 are the incident itself: the key is wrong, expired, or
    restricted to a set of permissions that no longer covers what checkout
    does. There is no learner-caused 401 on this API — the learner has no
    credentials here, ours are the only ones sent.
  */
  if (status === 401 || status === 403) return "platform";

  /*
    429 and 5xx are Stripe rather than us, but they are still nothing the payer
    can act on and still stop every sale while they last, so they go in the
    loud bucket. If Stripe has an outage the owner should know why the site
    stopped taking money, rather than concluding it was a quiet day.
  */
  if (status === 429 || status >= 500) return "platform";

  /*
    Parameter errors on a 400. Every parameter in a Checkout Session is built
    by this application from its own catalogue — the request chooses a plan id
    and nothing else — so Stripe rejecting one means our request is wrong, for
    everybody, until it is changed.
  */
  if (code && /^parameter_(invalid|missing|unknown)/.test(code)) return "platform";

  /*
    And the request-shaped errors that arrive with a message and no code at
    all. "is not activated", "not enabled", "must be set to" are all Stripe
    describing an account or a request it will not accept.
  */
  if (message && /not (activated|enabled|supported|available)|invalid request|must be/i.test(message)) {
    return "platform";
  }

  return "platform";
}

/**
 * The log line for a payments failure, and how loud it is.
 *
 * One prefix, `[billing]`, and one word that a `wrangler tail` or a Workers
 * log search can be filtered on: `PAYMENTS-BROKEN`. It is deliberately ugly
 * and deliberately unique in this repository, so that "show me every time the
 * site could not take money" is a text search rather than an investigation.
 *
 * `where` is a fixed string from the call site. `detail` is Stripe's own text,
 * which is why this returns a line for the *log* and nothing that any response
 * body ever sees — ACCOUNTS.md, threat 7.
 */
export function billingLogLine(fault: BillingFault, where: string, detail: string): string {
  return fault === "platform"
    ? `[billing] PAYMENTS-BROKEN ${where}: ${detail} — no learner can pay until this is fixed`
    : `[billing] ${where} refused: ${detail}`;
}

/**
 * Reads the fault off whatever was thrown, without importing the Stripe module.
 *
 * A `StripeError` carries its own classification (lib/billing/stripe.ts). This
 * file must not import that module to read it: stripe.ts calls
 * `assertServerOnly`, and the owner's console — a client component — needs the
 * constant and the types from here. Duck-typing the one field keeps the
 * dependency pointing one way.
 *
 * Anything else thrown on a payments path — a timeout, a bug in our own code, a
 * Supabase read that failed while looking up the customer — is "platform" for
 * the same reason unknown Stripe codes are: it is our side, and nobody paying
 * can do anything about it.
 */
export function faultOf(err: unknown): BillingFault {
  return (err as { fault?: unknown } | null)?.fault === "learner" ? "learner" : "platform";
}

/**
 * Logs a payments failure at the volume its fault deserves, and says which it
 * was so the route can decide what to answer.
 *
 * `console.error` for both, because Workers logs are not levelled in any way
 * this deployment can filter on and a `console.warn` would only make the loud
 * case harder to find. The distinction is carried by the `PAYMENTS-BROKEN`
 * marker in the line itself, which is greppable, tail-able, and the thing the
 * owner's console has now made unnecessary to watch by hand.
 */
export function logBillingFailure(where: string, err: unknown): BillingFault {
  const fault = faultOf(err);
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(billingLogLine(fault, where, detail));
  return fault;
}
