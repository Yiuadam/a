import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { acceptPromo, payingWhileFree, promoOfferFor } from "@/lib/billing/promo";
import { withCors } from "@/lib/http/cors";

/*
  The free Pro trial: whether to offer it, and taking it up.

  GET answers one boolean. It deliberately does not say why the answer is no —
  "you already decided" and "the owner has not opened it yet" are the server's
  business, and a client that could tell them apart could count the difference.

  POST grants it. The body is empty and is ignored if it is not: the only thing
  a caller chooses here is that they said yes, and which account said it comes
  from the session. Nothing about the tier, the length or the price is
  addressable from outside. See ACCOUNTS.md, threat 3.
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
} as const;

async function handleGET(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
    return NextResponse.json({ offered: false, payingWhileFree: false });
  }
  try {
    const user = await getSessionUser(req);
    const offer = await promoOfferFor(user?.id ?? null, user?.email ?? null);
    /*
      Only asked when there is nothing to offer. The two are mutually exclusive
      by construction — a subscriber is `already-pro` or on a paid tier, so is
      never offered the trial — and skipping the query on the common path keeps
      the poster's request to one round trip.

      This tells the caller something about their own account that they already
      know: that they are paying. It reveals nothing about anybody else, and no
      more about the trial than the poster does.
    */
    const paying = offer.offered
      ? false
      : await payingWhileFree(user?.id ?? null, user?.email ?? null);
    return NextResponse.json({ offered: offer.offered, payingWhileFree: paying });
  } catch (err) {
    /*
      An unreachable database hides the poster rather than showing one that
      cannot be accepted. Nothing a learner relies on depends on this route.
    */
    logInternal("billing/promo/offer", err);
    return NextResponse.json({ offered: false, payingWhileFree: false });
  }
}

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
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

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
