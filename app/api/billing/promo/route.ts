import { NextResponse } from "next/server";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { acceptPromo, payingWhileFree, promoOfferFor, releasePromo } from "@/lib/billing/promo";
import { withCors } from "@/lib/http/cors";

/*
  The free Pro trial: whether to offer it, taking it up, and giving it back.

  GET answers booleans about the caller's own account. It deliberately does not
  say why the offer is no — "you already decided" and "the owner has not opened
  it yet" are the server's business, and a client that could tell them apart
  could count the difference.

  POST grants it. The body is empty and is ignored if it is not: the only thing
  a caller chooses here is that they said yes, and which account said it comes
  from the session. Nothing about the tier, the length or the price is
  addressable from outside. See ACCOUNTS.md, threat 3.

  ---------------------------------------------------------------------------
  Why giving it up is DELETE here rather than a route of its own

  It is the same resource: this account's free Pro trial. POST starts it, DELETE
  ends it, GET says where it stands. A second route would have to re-establish
  the same session, re-derive the same account, repeat the same degrade-when-the-
  constraint-is-narrow rule and be added to the same CORS preflight — four
  chances to get one of them subtly different, in exchange for a URL. The one
  thing DELETE does not do literally is delete: the row is kept, paused, because
  keeping it is what stops an ended trial being taken out again. What is removed
  is the entitlement, which is what the caller is addressing.
*/

export const dynamic = "force-dynamic";

/** What a learner is told, in each case that is not a plain success. */
const PROMO_MESSAGES = {
  notOpen:
    "The free Pro trial isn't open yet. Nothing is wrong with your account — please try again later.",
  signInFirst: "Please sign in first, so the free Pro trial is attached to your account.",
  ended:
    "The free Pro trial has ended, so it can't be started now. Your account is on the free plan, and everything on the free plan still works.",
  failed:
    "We couldn't start your free Pro trial just now. Nothing has been charged and nothing has changed. Please try again in a minute.",
  notHeld:
    "Your account isn't on the free Pro trial, so there is nothing to give up. Nothing has changed.",
  releaseUnavailable:
    "We couldn't change your free Pro trial just now. Nothing has changed on your account — please try again in a minute.",
} as const;

async function handleGET(req: Request) {
  if (!accountRuntimeEnabled()) {
    return NextResponse.json({ offered: false, payingWhileFree: false, grantHeld: false });
  }
  try {
    const user = await getSessionUser(req);
    const offer = await promoOfferFor(user?.id ?? null, user?.email ?? null);
    /*
      Only asked when there is nothing to offer and nothing being held by grant.
      All three are mutually exclusive by construction — a subscriber is
      `already-pro`, and a trialist's Pro comes from the grant rather than from a
      payment — and skipping the query on those paths keeps every one of the three
      readers of this route to a single round trip.

      This tells the caller something about their own account that they already
      know: that they are paying. It reveals nothing about anybody else, and no
      more about the trial than the poster does.
    */
    const paying =
      offer.offered || offer.grantHeld
        ? false
        : await payingWhileFree(user?.id ?? null, user?.email ?? null);
    return NextResponse.json({
      offered: offer.offered,
      payingWhileFree: paying,
      /*
        Whether to draw the give-up control. Resolved server-side from the
        session, so a browser cannot talk itself into one — and if it draws one
        anyway, DELETE re-establishes the same condition before it writes.
      */
      grantHeld: offer.grantHeld,
    });
  } catch (err) {
    /*
      An unreachable database hides the poster rather than showing one that
      cannot be accepted, and hides the give-up control rather than offering an
      exit that cannot be taken. Nothing a learner relies on depends on this
      route.
    */
    logInternal("billing/promo/offer", err);
    return NextResponse.json({ offered: false, payingWhileFree: false, grantHeld: false });
  }
}

async function handlePOST(req: Request) {
  if (!accountRuntimeEnabled()) {
    return safeJsonError(PROMO_MESSAGES.notOpen, 503);
  }

  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    logInternal("billing/promo/session", err);
    return safeJsonError(PROMO_MESSAGES.failed, 503);
  }
  if (!user) return safeJsonError(PROMO_MESSAGES.signInFirst, 401);

  try {
    const outcome = await acceptPromo(user.id, user.email ?? null);
    switch (outcome) {
      case "granted":
      case "already-pro":
        // Both mean the same thing to the reader: Pro is on the account, and
        // there is nothing left for them to do.
        return NextResponse.json({ granted: true });
      case "ended":
        return safeJsonError(PROMO_MESSAGES.ended, 409);
      case "not-open":
        return safeJsonError(PROMO_MESSAGES.notOpen, 503);
      default:
        return safeJsonError(PROMO_MESSAGES.failed, 503);
    }
  } catch (err) {
    logInternal("billing/promo/accept", err);
    return safeJsonError(PROMO_MESSAGES.failed, 503);
  }
}

async function handleDELETE(req: Request) {
  if (!accountRuntimeEnabled()) {
    return safeJsonError(PROMO_MESSAGES.releaseUnavailable, 503);
  }

  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    logInternal("billing/promo/session", err);
    return safeJsonError(PROMO_MESSAGES.releaseUnavailable, 503);
  }
  if (!user) return safeJsonError(PROMO_MESSAGES.signInFirst, 401);

  try {
    /*
      No body is read, here as in POST. The request carries one instruction —
      give it up — and every other fact it depends on is re-established from the
      session inside `releasePromo`: whether this account holds a trial at all,
      and which row that is.
    */
    const result = await releasePromo(user.id, user.email ?? null);
    switch (result.outcome) {
      case "released":
        /*
          The tier is what the account holds now, read back from the database
          rather than assumed to be free — an account can hold a paid plan
          underneath the grant, and the confirmation says the true thing.
        */
        return NextResponse.json({ released: true, tier: result.tier });
      case "not-held":
        return safeJsonError(PROMO_MESSAGES.notHeld, 409);
      case "not-open":
        return safeJsonError(PROMO_MESSAGES.releaseUnavailable, 503);
      default:
        return safeJsonError(PROMO_MESSAGES.releaseUnavailable, 503);
    }
  } catch (err) {
    logInternal("billing/promo/release", err);
    return safeJsonError(PROMO_MESSAGES.releaseUnavailable, 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
export const DELETE = withCors(handleDELETE);
