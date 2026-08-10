import { assertServerOnly } from "@/lib/auth/server-only";
import { stripeSecretKey, stripePriceId } from "./env";
import { PLANS, isPaidTier } from "./tiers";
import type { Tier, PlanId } from "./tiers";
import type { SubscriptionStatus } from "./providers";

/*
  Stripe, over `fetch`, with the signature check done in Web Crypto.

  ---------------------------------------------------------------------------
  Why no `stripe` package

  Two reasons, and the second is the load-bearing one.

  This app deploys only to Cloudflare Workers. The Node SDK's
  `constructEvent` is synchronous and reaches for Node's `crypto` to do its
  HMAC; the Workers runtime has Web Crypto, whose digest and sign operations
  are asynchronous by design. The SDK does ship an async
  `constructEventAsync` for exactly this, so the package *can* be made to work
  — but the whole of what is needed here is one HMAC, one constant-time
  compare and two form-encoded POSTs, and writing those directly means the
  verification this system's security rests on is forty readable lines in this
  repository rather than a version range in package-lock.json.

  And it is the same decision lib/auth/supabase.ts already made, for the same
  reason: a module that holds a key which can move money should expose a fixed
  set of named operations, not a general client somebody later points at
  something else.

  ---------------------------------------------------------------------------
  What is trusted here, and what is not

  Nothing that arrives in a webhook body is believed until the signature over
  the *raw bytes* has verified. That ordering is not stylistic: parsing first
  and verifying second means a forged payload has already been through JSON
  parsing and whatever came after it, and it means the verification is being
  performed over a re-serialisation rather than over what was actually signed.
  `verifyStripeSignature` takes the raw text, and the route calls it before it
  calls JSON.parse. See ACCOUNTS.md, threat 3.
*/

const MODULE = "lib/billing/stripe.ts";

const API_BASE = "https://api.stripe.com/v1";

/*
  How far out of date a signed timestamp may be before the delivery is refused.
  Five minutes is Stripe's own default, and it is what makes a captured webhook
  body useless to replay an hour later.
*/
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {}

/* -------------------------------------------------------------------------- */
/* Signature verification                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The `Stripe-Signature` header, split into its timestamp and its signatures.
 *
 * The header looks like `t=1699999999,v1=abc…,v1=def…`. More than one `v1` is
 * normal and is how Stripe rolls a signing secret over without dropping
 * deliveries, so every one of them is a candidate and any single match is
 * enough.
 */
export function parseSignatureHeader(header: string | null): {
  timestamp: number;
  signatures: string[];
} | null {
  if (!header) return null;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      // Number("") is 0 and Number("abc") is NaN; both are "no timestamp", and
      // a timestamp of zero would sail through an "is it recent" check written
      // as a subtraction.
      if (Number.isInteger(parsed) && parsed > 0) timestamp = parsed;
    } else if (key === "v1" && /^[0-9a-f]+$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compares two hex strings without leaking where they first differ.
 *
 * A plain `===` on strings short-circuits at the first mismatched character,
 * and the time that takes is measurable over enough attempts. It is a thin
 * attack against a 64-character hex digest over a network, but the defence
 * costs four lines and the alternative is arguing about how thin.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Verifies a webhook delivery against the endpoint's signing secret.
 *
 * `payload` must be the exact bytes Stripe sent, as text — not a re-serialised
 * object. Stripe signs `${timestamp}.${body}`, so a body that has been through
 * `JSON.parse` and `JSON.stringify` will not verify, and the failure looks
 * exactly like an attack rather than like the bug it is.
 *
 * Only the "too old" side of the tolerance is checked, which is what Stripe's
 * own libraries do. A timestamp far in the future cannot be produced without
 * the signing secret, so rejecting one would guard against nothing while
 * turning a slow clock on our side into silently dropped subscriptions.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  if (parsed.timestamp < nowSeconds - toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${parsed.timestamp}.${payload}`),
  );
  const expected = toHex(signature);

  // Every candidate is compared even after one matches, so the number of
  // comparisons does not depend on which signature was the right one.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (timingSafeEqualHex(candidate, expected)) matched = true;
  }
  return matched;
}

/* -------------------------------------------------------------------------- */
/* Reading an event                                                            */
/* -------------------------------------------------------------------------- */

export interface StripeEvent {
  id: string;
  type: string;
  /** Unix seconds. Used to refuse an out-of-order redelivery — see below. */
  created: number;
  data: { object: Record<string, unknown> };
}

/**
 * Turns verified text into an event, or null if it is not shaped like one.
 *
 * Called only after `verifyStripeSignature` has returned true. It is still
 * defensive about the shape, because "signed by Stripe" is a statement about
 * authenticity and not about the payload matching the fields this code reads —
 * Stripe adds and moves fields between API versions, and a missing one should
 * produce a refusal rather than `undefined` flowing into the database.
 */
export function parseStripeEvent(payload: string): StripeEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  const event = body as Record<string, unknown>;
  const data = event.data as { object?: unknown } | undefined;
  if (typeof event.id !== "string" || event.id.length === 0) return null;
  if (typeof event.type !== "string" || event.type.length === 0) return null;
  if (!data || typeof data.object !== "object" || data.object === null) return null;

  return {
    id: event.id,
    type: event.type,
    created: typeof event.created === "number" ? event.created : 0,
    data: { object: data.object as Record<string, unknown> },
  };
}

/*
  Stripe's subscription statuses mapped onto the seven this database allows.

  Only `active` and `trialing` grant anything — `resolve_entitlement` requires
  one of those *and* an unexpired period end — so the rest differ only in what
  the row says happened. They are still distinguished rather than collapsed
  into one "not active", because the row is the audit trail for a payment, and
  "we stopped collecting" and "they cancelled" are not the same event to
  anybody who later has to explain a charge.
*/
const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  // The first payment never completed. Nothing was bought, so nothing is owed
  // and nothing is granted.
  incomplete: "past_due",
  incomplete_expired: "expired",
  // Stripe has given up collecting. Recoverable in principle, so not "expired".
  unpaid: "past_due",
  canceled: "canceled",
  paused: "paused",
};

export interface StripeSubscriptionEvent {
  eventId: string;
  eventAt: string;
  userId: string | null;
  status: SubscriptionStatus;
  tier: Tier;
  customerId: string | null;
  subscriptionId: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** The metadata key carrying the BandUp account a Stripe subscription is for. */
export const USER_METADATA_KEY = "bandup_user_id";
/** The metadata key carrying which tier was bought. */
export const TIER_METADATA_KEY = "bandup_tier";

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoFromUnix(value: unknown): string | null {
  return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : null;
}

/**
 * Reads a `customer.subscription.*` event into the shape the database stores.
 *
 * Returns null for every other event type, which is most of them. The endpoint
 * only needs the three subscription events: Stripe fires
 * `customer.subscription.created` at the moment checkout completes and
 * `customer.subscription.updated` on every renewal, plan change and
 * cancellation, so they carry the whole lifecycle. `checkout.session.completed`
 * is deliberately *not* used to write a row — it arrives with no period end,
 * and its only unique field is `client_reference_id`, which is redundant
 * because checkout also stamps the account id into the subscription's own
 * metadata where every later event carries it.
 *
 * `tierForPrice` is a parameter rather than an environment read so that this
 * function stays pure and can be tested without a Stripe account. The route
 * supplies the env-backed version.
 */
export function subscriptionFromStripeEvent(
  event: StripeEvent,
  tierForPrice?: (priceId: string) => Tier | null,
): StripeSubscriptionEvent | null {
  if (!event.type.startsWith("customer.subscription.")) return null;

  const object = event.data.object;
  const subscriptionId = readString(object, "id");
  if (!subscriptionId) return null;

  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const userId = readString(metadata, USER_METADATA_KEY);

  /*
    A deletion is a cancellation whatever the object says. Stripe does set
    status to `canceled` on the deleted object, but this event is the one that
    must never be misread — reading a status this code did not expect and
    defaulting to something permissive would leave a cancelled subscriber paid
    up forever.
  */
  const rawStatus = readString(object, "status");
  const status: SubscriptionStatus =
    event.type === "customer.subscription.deleted"
      ? "canceled"
      : (rawStatus && STATUS_MAP[rawStatus]) || "canceled";

  /*
    Where the period end lives depends on the API version. It used to be
    `current_period_end` on the subscription; on newer versions it moved onto
    each subscription item, because a subscription can hold items on different
    schedules. Both are read, newest shape first, so the account's API version
    is not something this code has an opinion about.
  */
  const items = (object.items as { data?: unknown } | undefined)?.data;
  const firstItem =
    Array.isArray(items) && items[0] && typeof items[0] === "object"
      ? (items[0] as Record<string, unknown>)
      : null;

  const currentPeriodEnd =
    isoFromUnix(firstItem?.current_period_end) ?? isoFromUnix(object.current_period_end);

  const price =
    firstItem && typeof firstItem.price === "object" && firstItem.price !== null
      ? (firstItem.price as Record<string, unknown>)
      : null;
  const priceId = price ? readString(price, "id") : null;

  /*
    Which tier was bought, in order of how much the answer can be trusted:
    the metadata this app stamped on at checkout, then the Price id mapped
    through the server's own configuration. If neither answers, the row is
    written as `free` — a subscription whose tier cannot be established grants
    nothing, which is the direction to fail in.
  */
  const metadataTier = readString(metadata, TIER_METADATA_KEY);
  const tier: Tier =
    metadataTier !== null && isPaidTier(metadataTier as Tier)
      ? (metadataTier as Tier)
      : (priceId && tierForPrice?.(priceId)) || "free";

  return {
    eventId: event.id,
    eventAt: new Date((event.created > 0 ? event.created : Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    userId,
    status,
    tier,
    customerId: readString(object, "customer"),
    subscriptionId,
    priceId,
    currentPeriodEnd,
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
  };
}

/* -------------------------------------------------------------------------- */
/* Talking to Stripe                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Stripe's API takes form encoding, including for nested objects, which it
 * spells `parent[child]`. Undefined values are dropped rather than sent as the
 * string "undefined".
 */
function form(fields: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

async function stripePost(path: string, body: string): Promise<Record<string, unknown>> {
  assertServerOnly(MODULE);
  const key = stripeSecretKey();
  if (!key) throw new StripeError("Stripe is not configured");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      // A hung Stripe must not hold a request open until the platform's own
      // timeout, which on Workers is measured in tens of seconds.
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new StripeError(`request to ${path} failed: ${err instanceof Error ? err.name : "unknown"}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new StripeError(`response from ${path} was not JSON (${res.status})`);
  }

  if (!res.ok) {
    /*
      Stripe's error messages are written for developers and can name the
      account, the key's mode and the object that was refused. The message is
      built for the server log and the caller is never shown it — see
      ACCOUNTS.md, threat 7.
    */
    const error = (payload as { error?: { message?: unknown; code?: unknown } }).error;
    const detail = typeof error?.code === "string" ? error.code : String(res.status);
    throw new StripeError(`${path} refused: ${detail}`);
  }

  return payload as Record<string, unknown>;
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  assertServerOnly(MODULE);
  const key = stripeSecretKey();
  if (!key) throw new StripeError("Stripe is not configured");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new StripeError(`request to ${path} failed: ${err instanceof Error ? err.name : "unknown"}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new StripeError(`response from ${path} was not JSON (${res.status})`);
  }

  if (!res.ok) {
    const error = (payload as { error?: { code?: unknown } }).error;
    const detail = typeof error?.code === "string" ? error.code : String(res.status);
    throw new StripeError(`${path} refused: ${detail}`);
  }

  return payload as Record<string, unknown>;
}

/**
 * Refuses to sell a plan at a price other than the one on the page.
 *
 * The catalogue in lib/billing/tiers.ts is what /pricing and /terms print. The
 * amount actually charged is whatever the Stripe Price behind that plan says,
 * and the two are joined only by an environment variable holding an id. Nothing
 * in the type system, the tests or the build connects them, and they come apart
 * in the most ordinary way there is: prices are changed here, and the Stripe
 * Prices — which are immutable objects that have to be recreated, not edited —
 * are updated a day later, or on the wrong account, or not at all.
 *
 * What that produces is not a bug report. It is a page advertising $0.49, a
 * card charged $0.99, and a customer who is right. Under the consumer law this
 * app already sets out on /terms that is a misleading price indication and the
 * charge is refundable on request; it is also the single most damaging thing
 * this codebase could do to somebody, because it takes money.
 *
 * So the amount is checked against the catalogue before the session is made,
 * and a mismatch refuses the sale. One extra call to Stripe on a path that was
 * already calling Stripe, in exchange for it being impossible to charge a price
 * that was never shown.
 */
async function assertPriceMatchesCatalogue(plan: PlanId, priceId: string): Promise<void> {
  const expected = PLANS[plan];
  const price = await stripeGet(`/prices/${encodeURIComponent(priceId)}`);

  const amount = price.unit_amount;
  const currency = price.currency;
  const interval = (price.recurring as { interval?: unknown } | undefined)?.interval;

  if (typeof amount !== "number" || amount !== expected.amountMinor) {
    throw new StripeError(
      `price ${priceId} for ${plan} charges ${String(amount)} but the catalogue advertises ${expected.amountMinor}`,
    );
  }
  if (typeof currency !== "string" || currency.toLowerCase() !== expected.currency.toLowerCase()) {
    throw new StripeError(
      `price ${priceId} for ${plan} is in ${String(currency)} but the catalogue advertises ${expected.currency}`,
    );
  }
  /*
    A monthly Price sold as the yearly plan would charge the right number and
    twelve times as often, which is worse than charging the wrong number once.
  */
  if (interval !== expected.interval) {
    throw new StripeError(
      `price ${priceId} for ${plan} renews ${String(interval)}ly but the catalogue advertises ${expected.interval}ly`,
    );
  }

  /*
    And every other currency the page might have quoted.

    Checkout picks the currency from the customer's address, and the pricing
    page picks it from the same address, so whichever one a reader was shown is
    the one they are about to be charged in. Checking only the base amount would
    leave every regional price unguarded — and a Price created before regional
    pricing existed carries no currency_options at all, so a reader quoted
    £1.29 would be charged the base amount converted, silently.
  */
  const options = (price.currency_options ?? {}) as Record<
    string,
    { unit_amount?: unknown } | undefined
  >;
  for (const [code, amount] of Object.entries(expected.prices)) {
    if (code === expected.currency) continue;
    const actual = options[code]?.unit_amount;
    if (actual !== amount) {
      throw new StripeError(
        `price ${priceId} for ${plan} charges ${String(actual)} in ${code} but the catalogue advertises ${amount}`,
      );
    }
  }
}

/**
 * What is currently being paid, straight from Stripe.
 *
 * Stripe rather than our own `subscriptions` table, and the difference matters.
 * Our table is a copy kept in step by webhooks, so it is right until a webhook
 * is missed — and a dashboard whose job is to tell the owner whether anything
 * is wrong should not be reading the copy that goes stale when something is.
 * Stripe is where the money actually is.
 *
 * Counts only `active` and `trialing`. A subscription that is past due or
 * cancelled is not revenue, and rolling those in is how a dashboard reports
 * growth on the day it should be reporting churn.
 */
export interface BillingSnapshot {
  /** Live subscriptions, by plan id where we recognise the Price. */
  byPlan: Record<string, number>;
  active: number;
  /** Monthly recurring revenue in Hong Kong dollars, yearly plans divided out. */
  mrrHkd: number;
}

export async function billingSnapshot(): Promise<BillingSnapshot> {
  const byPlan: Record<string, number> = {};
  let active = 0;
  let mrrMinor = 0;

  /*
    Paginated deliberately rather than capped at Stripe's default hundred. A
    dashboard that silently stopped counting at subscriber 101 would be wrong
    in the direction that matters and would look right for months.
  */
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ status: "active", limit: "100" });
    if (startingAfter) query.set("starting_after", startingAfter);
    const body = await stripeGet(`/subscriptions?${query.toString()}`);
    const data = (body.data ?? []) as Array<Record<string, unknown>>;

    for (const sub of data) {
      active += 1;
      const items = (sub.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
      for (const item of items) {
        const price = item.price as
          | { id?: unknown; unit_amount?: unknown; recurring?: { interval?: unknown } }
          | undefined;
        const planId = price?.id ? planForStripePrice(String(price.id)) : null;
        if (planId) byPlan[planId] = (byPlan[planId] ?? 0) + 1;

        const amount = typeof price?.unit_amount === "number" ? price.unit_amount : 0;
        /* A year's money spread over the months it covers, so the two plans
           are comparable on one axis rather than one of them spiking once. */
        mrrMinor += price?.recurring?.interval === "year" ? amount / 12 : amount;
      }
    }

    if (data.length < 100) break;
    startingAfter = String(data[data.length - 1]?.id ?? "");
    if (!startingAfter) break;
  }

  return { byPlan, active, mrrHkd: Math.round(mrrMinor) / 100 };
}

/** Which plan a Stripe Price id belongs to, or null if we do not sell it. */
function planForStripePrice(priceId: string): PlanId | null {
  for (const id of Object.keys(PLANS) as PlanId[]) {
    if (stripePriceId(id) === priceId) return id;
  }
  return null;
}

/**
 * Creates a Checkout Session and returns the URL to send the learner to.
 *
 * Two things travel with the session so that every later webhook can be tied
 * back to an account without a lookup table:
 *
 *   client_reference_id                     — the account, on the session
 *   subscription_data[metadata][…user_id]   — the account, on the subscription
 *
 * The second is the one that matters. It is copied onto the Subscription
 * object at creation, so it is present on `customer.subscription.updated` two
 * years later when the card is renewed, long after the session is gone.
 *
 * No idempotency key is sent, deliberately. A duplicate create makes a second
 * Checkout Session, which costs nothing and cannot be paid twice; a key stable
 * enough to be useful would also return a stale session to somebody who had
 * changed their mind about the plan in between.
 */
export async function createCheckoutSession(args: {
  plan: PlanId;
  tier: Tier;
  userId: string;
  email: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<string | null> {
  const price = stripePriceId(args.plan);
  if (!price) throw new StripeError(`no Price id configured for ${args.plan}`);

  // Never charge an amount the page did not show. See above.
  await assertPriceMatchesCatalogue(args.plan, price);

  const session = await stripePost(
    "/checkout/sessions",
    form({
      mode: "subscription",
      /*
        Managed Payments off, deliberately, and it is a pricing decision rather
        than a technical one.

        Stripe enables it by default on new accounts. It makes Stripe the
        merchant of record: it registers for, collects and remits sales tax and
        VAT on your behalf, which for digital goods sold to consumers in dozens
        of countries is a real burden lifted. It also charges more than the
        3.9% + HK$2.35 that lib/billing/tiers.ts prices every plan against — and
        those prices carry as little as HK$1.26 of margin a month, so a higher
        fee does not thin the margin, it removes it.

        Leaving it on would also have needed a tax code on every product, which
        is what Stripe refuses the session for without this.

        Turning it back on is a deliberate change and not a one-liner: the fee
        assumption in lib/billing/tiers.ts has to be re-measured and every price
        recomputed first. tests/ai-economics.test.mjs asserts this line is here,
        so removing it fails the build rather than quietly invalidating the
        arithmetic.
      */
      "managed_payments[enabled]": "false",
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      client_reference_id: args.userId,
      // Prefilling the address saves a step and, more usefully, keeps the
      // Stripe customer's email in step with the account's.
      customer_email: args.email ?? undefined,
      [`metadata[${USER_METADATA_KEY}]`]: args.userId,
      [`subscription_data[metadata][${USER_METADATA_KEY}]`]: args.userId,
      [`subscription_data[metadata][${TIER_METADATA_KEY}]`]: args.tier,
    }),
  );

  const url = session.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Creates a Billing Portal session — where a subscriber changes their card,
 * downloads an invoice, or cancels.
 *
 * Cancelling has to be as easy as subscribing, and building our own cancel
 * button would mean writing a second path that can end a subscription. The
 * portal is Stripe's, it is one API call, and it keeps this app with exactly
 * one way to change what somebody is paying.
 */
export async function createPortalSession(args: {
  customerId: string;
  returnUrl: string;
}): Promise<string | null> {
  const session = await stripePost(
    "/billing_portal/sessions",
    form({ customer: args.customerId, return_url: args.returnUrl }),
  );
  const url = session.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}
