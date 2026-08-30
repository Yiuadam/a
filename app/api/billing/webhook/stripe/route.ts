import { NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { nativeStripeBillingActive } from "@/lib/cloudflare/native-billing-readiness";
import { logInternal } from "@/lib/auth/errors";
import { stripeWebhookSecret, tierForStripePrice } from "@/lib/billing/env";
import {
  parseStripeEvent,
  prepaidPurchaseFromStripeEvent,
  prepaidRefundFromStripeEvent,
  subscriptionFromStripeEvent,
  verifyStripeSignature,
} from "@/lib/billing/stripe";
import {
  applyStripePrepaidPurchase,
  applyStripePrepaidRefund,
  applyStripeSubscription,
} from "@/lib/billing/subscriptions";
import { withCors } from "@/lib/http/cors";

/*
  The only door through which a subscription enters this system.

  Everything in ACCOUNTS.md threat 3 comes down to this file. A client that
  posts `{"subscribed": true}` must get nothing; a request that carries a valid
  Stripe signature over its own bytes is the only thing that causes a row to
  exist. So the order of operations here is fixed and is not a matter of taste:

    1. read the raw body as text, exactly as it arrived
    2. verify the signature over those bytes
    3. only then parse

  Parsing first would mean a forged payload had already been through JSON
  parsing and everything downstream of it, and it would mean verifying a
  re-serialisation rather than what was actually signed — `JSON.stringify`
  reorders nothing but normalises plenty, and any difference at all makes the
  HMAC fail. Reading `req.text()` once and passing the string to both steps is
  what keeps them the same bytes.

  ---------------------------------------------------------------------------
  Which events this endpoint needs

  Subscription lifecycle events update renewable card plans. Paid Checkout
  completion events grant one-time Alipay/WeChat passes. Full charge refunds
  and succeeded refund updates revoke the matching prepaid purchase; the
  latter is required because WeChat Pay refunds complete asynchronously.
  Anything else that is delivered is acknowledged and ignored.

  ---------------------------------------------------------------------------
  What is answered, and why almost everything is a 200

  A non-2xx makes Stripe retry, so a status code here is a decision about
  whether a redelivery would help. It would not help a duplicate, a stale
  event, an event about a subscription this database cannot place, or an event
  type we do not handle — those are already in their final state. It would help
  an unreachable database, and that is the one case that answers 5xx.

  A delivery that fails its signature check gets 400 and nothing else. No
  detail about which part failed, because the only party who cannot already
  work that out is somebody guessing.
*/

export const dynamic = "force-dynamic";

/*
  Bodies are small — a subscription event is a few kilobytes — and reading an
  unbounded stream from an unauthenticated endpoint is how a webhook becomes a
  way to exhaust a Worker's memory. The signature has not been checked yet at
  the point this limit applies, which is exactly why there is a limit.
*/
const MAX_BODY_BYTES = 1_000_000;

/*
  The only reader of this endpoint is Stripe, so the messages are not written
  for a learner — but the rule from ACCOUNTS.md threat 7 is the same one: they
  say nothing about how the server is built. "Temporarily unavailable" is what
  Stripe needs in order to decide to retry, and it is all Stripe gets.
*/
const RETRY_LATER = { error: "Temporarily unavailable." };

async function handlePOST(req: Request) {
  const secret = stripeWebhookSecret();

  /*
    No secret means no way to tell a real delivery from a forged one, and the
    only safe response to that is to accept nothing. Note this is not the same
    condition as ACCOUNTS_ENABLED being off: a payment that has been taken must
    be recorded whether or not the account UI is switched on, so this route
    deliberately does not check that flag. Losing a webhook because a feature
    flag was unset would mean somebody paid and the database never heard.
  */
  if (!secret || (!supabaseConfigured() && !nativeStripeBillingActive())) {
    logInternal(
      "billing/webhook/stripe",
      new Error("delivery received while the webhook secret or the database is unconfigured"),
    );
    return NextResponse.json(RETRY_LATER, { status: 503 });
  }

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    logInternal("billing/webhook/stripe/body", err);
    return NextResponse.json({ error: "Unreadable request." }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const signature = req.headers.get("stripe-signature");

  let verified = false;
  try {
    verified = await verifyStripeSignature(raw, signature, secret);
  } catch (err) {
    // A malformed key or a runtime without Web Crypto. Either way, unverified.
    logInternal("billing/webhook/stripe/verify", err);
  }

  if (!verified) {
    /*
      Logged because a burst of these is worth noticing — it is either somebody
      probing the endpoint or the signing secret having been rotated in the
      dashboard without being updated on the Worker, and the second one silently
      stops every subscription from being recorded.
    */
    logInternal("billing/webhook/stripe", new Error("signature verification failed"));
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  // Everything below this line is known to have come from Stripe.

  const event = parseStripeEvent(raw);
  if (!event) {
    logInternal("billing/webhook/stripe", new Error("verified delivery was not shaped like an event"));
    return NextResponse.json({ error: "Unrecognised payload." }, { status: 400 });
  }

  const payload = JSON.parse(raw) as unknown;
  const subscription = subscriptionFromStripeEvent(event, tierForStripePrice);
  const prepaidPurchase = prepaidPurchaseFromStripeEvent(event);
  const prepaidRefund = prepaidRefundFromStripeEvent(event);
  if (!subscription && !prepaidPurchase && !prepaidRefund) {
    // An event type this endpoint does not act on. Acknowledged so Stripe stops
    // retrying it, and named in the log so an endpoint subscribed to more than
    // it needs is visible rather than silent.
    return NextResponse.json({ received: true, handled: false, type: event.type });
  }

  try {
    const outcome = subscription
      ? await applyStripeSubscription(subscription, payload)
      : prepaidPurchase
        ? await applyStripePrepaidPurchase(prepaidPurchase, payload)
        : await applyStripePrepaidRefund(prepaidRefund!, payload);
    if (outcome !== "applied") {
      /*
        Worth a line each. `duplicate` is Stripe working as designed, `stale` is
        an out-of-order redelivery that was correctly refused, and
        `unknown_user` is the one that needs a human: a subscription exists in
        Stripe that this database cannot tie to an account, which usually means
        it was created in the dashboard rather than through checkout.
      */
      logInternal(
        "billing/webhook/stripe",
        new Error(`${event.type} ${event.id} was not applied: ${outcome}`),
      );
    }
    return NextResponse.json({ received: true, handled: true });
  } catch (err) {
    /*
      The database could not be reached, or answered something unrecognisable.
      This is the one failure a retry genuinely fixes, so it is the one that
      answers 5xx — Stripe will redeliver, and because the claim and the write
      are one transaction there is nothing half-done for it to trip over.
    */
    logInternal("billing/webhook/stripe/apply", err);
    return NextResponse.json(RETRY_LATER, { status: 503 });
  }
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.

  It grants nothing here in practice: Stripe is a server and sends no Origin
  header, so `corsHeaders` returns an empty object and this endpoint is not
  reachable from a browser on another origin whatever the allow list says. The
  wrapper is applied anyway because tests/cors.test.mjs requires every route
  under app/api to have it, and an exception is how the next route quietly
  becomes one too.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
