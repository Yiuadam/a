import { createHmac } from "node:crypto";
import { stripe } from "./stripe";

/*
  Who is allowed to spend our Claude budget, decided without a database.

  The app has no accounts and no server-side storage — `lib/store.ts` keeps a
  learner's whole profile in one localStorage key — so Stripe itself is the
  record of who has paid. Asking Stripe on every graded essay would be slow and
  would tie the examiner to Stripe's uptime, so instead a successful checkout
  mints a short-lived token that the learner's browser keeps and presents.

  The token is a signed claim, not a secret to be looked up: verifying it is one
  HMAC and no network call. It carries only a Stripe id and an expiry, so a
  stolen token grants the paid features for at most TTL_SECONDS and reveals
  nothing about the customer beyond an opaque id.

  The cost of holding no state is that a cancellation is not felt until the
  token expires. TTL_SECONDS is the whole of that exposure: twelve hours of
  access already paid for, in exchange for never having a database to keep in
  step with Stripe.
*/

export type AccessKind = "sub" | "seat";

export interface AccessClaims {
  /** Format version, so a later change can reject old tokens deliberately. */
  v: 1;
  /** "sub" — `ref` is a Stripe customer; "seat" — `ref` is a paid invoice. */
  k: AccessKind;
  ref: string;
  /** Expiry, epoch seconds. */
  e: number;
}

/** How long a minted token is trusted without re-asking Stripe. */
export const TTL_SECONDS = 12 * 60 * 60;

/**
 * How long after expiry a token may still be exchanged for a fresh one.
 *
 * Refresh re-checks Stripe, so a lapsed subscription is caught either way; the
 * bound just stops an abandoned token being a permanent handle on the account.
 */
export const REFRESH_GRACE_SECONDS = 60 * 24 * 60 * 60;

/**
 * Subscription states that still open the AI features.
 *
 * `past_due` is included on purpose: Stripe retries a failed card over several
 * days, and locking a paying learner out on the first hiccup — mid-essay, most
 * likely — costs more goodwill than the few days of access it saves.
 */
const ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"]);

export const NO_SECRET_MESSAGE =
  "Billing is not configured. Add BILLING_TOKEN_SECRET to .env.local (see .env.example) and restart the server.";

export function hasBillingSecret(): boolean {
  return Boolean(process.env.BILLING_TOKEN_SECRET);
}

function secret(): string {
  const s = process.env.BILLING_TOKEN_SECRET;
  if (!s) throw new Error(NO_SECRET_MESSAGE);
  return s;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function unb64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payload: string, domain: string): string {
  return createHmac("sha256", secret()).update(`${domain}.${payload}`).digest("base64url");
}

/**
 * Compare without leaking, through timing, how much of the tag was right.
 *
 * Written by hand rather than with `crypto.timingSafeEqual` because that throws
 * on a length mismatch — which for an attacker-supplied string is itself the
 * answer to a question — and because it is not uniformly available on the
 * Workers runtime this repo can also deploy to.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function encode(claims: object, domain: string): string {
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, domain)}`;
}

function decode<T>(token: string, domain: string): T | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload, domain))) return null;
  try {
    return JSON.parse(unb64url(payload)) as T;
  } catch {
    return null;
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** A token proving the bearer may use the AI features, valid for TTL_SECONDS. */
export function mintAccessToken(kind: AccessKind, ref: string): string {
  const claims: AccessClaims = { v: 1, k: kind, ref, e: now() + TTL_SECONDS };
  return encode(claims, "access");
}

export type VerifyFailure = "invalid" | "expired" | "stale";

export interface VerifyResult {
  claims?: AccessClaims;
  failure?: VerifyFailure;
}

/**
 * Check a token's signature, and its expiry unless the caller is refreshing.
 *
 * `allowExpired` is what /api/billing/refresh uses: the signature still proves
 * the token was minted here, so the Stripe id inside it can be trusted enough
 * to go and ask Stripe whether the subscription is still live.
 */
export function verifyAccessToken(token: string, allowExpired = false): VerifyResult {
  const claims = decode<AccessClaims>(token, "access");
  if (!claims || claims.v !== 1 || typeof claims.ref !== "string" || !claims.ref) {
    return { failure: "invalid" };
  }
  if (claims.k !== "sub" && claims.k !== "seat") return { failure: "invalid" };
  if (typeof claims.e !== "number") return { failure: "invalid" };

  const age = now() - claims.e;
  if (age > 0) {
    if (!allowExpired) return { failure: "expired" };
    if (age > REFRESH_GRACE_SECONDS) return { failure: "stale" };
  }
  return { claims };
}

/**
 * Ask Stripe whether this reference still entitles its holder.
 *
 * The only place the two kinds of access differ: a subscriber is entitled while
 * a subscription is live, a school seat while the invoice that bought it is
 * paid. Everything downstream treats them alike.
 */
export async function isStillEntitled(kind: AccessKind, ref: string): Promise<boolean> {
  if (kind === "seat") {
    const invoice = await stripe().invoices.retrieve(ref);
    return invoice.status === "paid";
  }
  const subs = await stripe().subscriptions.list({ customer: ref, status: "all", limit: 20 });
  return subs.data.some((s) => ENTITLING_STATUSES.has(s.status));
}

/*
  School seats.

  An invoice buys a school N seats, and each seat is handed to one learner as a
  code they paste into /redeem. The code is another signed claim — the invoice
  it came from, plus which seat it is — so redeeming needs no lookup table:
  verify the signature, ask Stripe whether that invoice is paid, mint access.

  What this deliberately does not do is stop a school sharing one code with a
  whole class. Counting redemptions means storing which codes have been used,
  which means the database this design exists to avoid. Seat *counts* are
  therefore contractual rather than enforced, and BILLING.md says so plainly.
*/

export interface SeatClaims {
  v: 1;
  inv: string;
  /** 1-based seat number, for the school's own records. */
  n: number;
}

export function mintSeatCode(invoiceId: string, seat: number): string {
  const claims: SeatClaims = { v: 1, inv: invoiceId, n: seat };
  return `BU-${encode(claims, "seat")}`;
}

export function readSeatCode(code: string): SeatClaims | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith("BU-")) return null;
  const claims = decode<SeatClaims>(trimmed.slice(3), "seat");
  if (!claims || claims.v !== 1 || typeof claims.inv !== "string" || !claims.inv) return null;
  return claims;
}
