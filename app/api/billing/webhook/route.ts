import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { hasStripeKey, stripe } from "@/lib/stripe";

/*
  Stripe's side of the conversation.

  Because entitlement is read from Stripe rather than mirrored into a database,
  this endpoint has no state to keep in step and the app stays correct even if
  every event here is dropped: a cancellation is caught when the learner's
  token next refreshes, and a school's seat codes start working the moment the
  invoice reads as paid, whether or not `invoice.paid` ever arrived.

  What it is for is the things Stripe alone knows and nobody would otherwise
  see — a card failing on renewal, a dispute, a school paying at last — and it
  is the hook to hang email on when there is email to send. Until then it logs,
  which is worth more than it sounds when the alternative is finding out from a
  learner that their card lapsed a fortnight ago.
*/

// The signature is computed over the exact bytes Stripe sent, so the body must
// be read as text and never as parsed JSON.
async function verify(req: Request): Promise<Stripe.Event> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
  const signature = req.headers.get("stripe-signature");
  if (!signature) throw new Error("No stripe-signature header.");
  const raw = await req.text();
  // constructEventAsync rather than constructEvent: the async form works on
  // both the Node runtime and the Worker runtime this repo can deploy to.
  return stripe().webhooks.constructEventAsync(raw, signature, secret);
}

export async function POST(req: Request) {
  if (!hasStripeKey() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Webhooks are not configured." }, { status: 503 });
  }

  let event: Stripe.Event;
  try {
    event = await verify(req);
  } catch (err) {
    // A bad signature is either a misconfiguration or someone trying it on;
    // either way Stripe should be told this was rejected, not retried forever.
    const msg = err instanceof Error ? err.message : "Invalid signature.";
    return NextResponse.json({ error: `Webhook signature check failed: ${msg}` }, { status: 400 });
  }

  switch (event.type) {
    case "invoice.paid": {
      const invoice = event.data.object;
      const seats = invoice.lines.data.reduce((n, line) => n + (line.quantity ?? 0), 0);
      console.info(
        `[billing] invoice ${invoice.id} paid (${invoice.customer_email ?? "no email"}), ${seats} seat(s) now redeemable`,
      );
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.warn(
        `[billing] payment failed for invoice ${invoice.id} (${invoice.customer_email ?? "no email"}) — Stripe will retry`,
      );
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      // Access continues until the learner's current token expires; that
      // window is the price of holding no state, and it is bounded by
      // TTL_SECONDS in lib/entitlement.ts.
      console.info(`[billing] subscription ${sub.id} ended for customer ${String(sub.customer)}`);
      break;
    }
    case "customer.subscription.updated":
    case "checkout.session.completed":
      break;
    default:
      // Unhandled types are acknowledged rather than errored, so Stripe does
      // not retry an event this app has no opinion about.
      break;
  }

  return NextResponse.json({ received: true });
}
