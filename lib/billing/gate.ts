import { assertServerOnly } from "@/lib/auth/server-only";
import { accountsEnabled, usageFailOpen } from "@/lib/auth/env";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { resolveEntitlement, ANONYMOUS_ENTITLEMENT } from "./entitlements";
import { tierAllows, type Feature } from "./tiers";

/*
  "May this caller use this feature?", answered on the server.

  It is shaped to be a two-line addition to a route, exactly like the usage
  meter it sits beside:

      const denied = await requireFeature(req, "tutor-chat");
      if (denied) return denied;

  Null means carry on. A response means stop and return it.

  ---------------------------------------------------------------------------
  Why the answer cannot be asked for

  There is no argument on this function through which a caller can suggest a
  tier. The tier comes from `resolveEntitlement`, which takes a user id and
  reads the database — and the user id comes from a bearer token the issuer
  was asked to validate. A paywall the client evaluates is a paywall the client
  can skip, so the client's copy of the answer (lib/billing/useTier.ts) decides
  only what to *draw*. ACCOUNTS.md, threats 1 and 3.

  ---------------------------------------------------------------------------
  What happens when the flag is off

  Nothing. With ACCOUNTS_ENABLED unset there are no accounts, so there is no
  tier to check and nothing to check it against, and this returns null before
  doing any work at all. That is the same rule lib/usage/guard.ts follows and
  it is what keeps the flag meaningful: off is not "gating that always allows",
  it is no gating. A feature that must not ship open before payments exist
  should not ship at all yet.

  ---------------------------------------------------------------------------
  What happens when the database is unreachable

  The same thing the meter does: refuse, unless USAGE_FAIL_OPEN says otherwise.
  The reasoning is identical — an attacker who can make Supabase unavailable
  would otherwise have found a way to unlock every paid feature — and reusing
  the meter's switch means there is one answer to "what does this app do when
  the database is down" rather than two that can be set differently by mistake.
*/

const MODULE = "lib/billing/gate.ts";

/**
 * Written for the learner, and it says what to do next. It deliberately does
 * not name the tier that would unlock the feature, because the pricing page is
 * where that is explained properly and a error message is a poor place to sell
 * anything.
 */
export const UPGRADE_MESSAGE =
  "This is part of BandUp Standard. See the plans on the pricing page — everything else, including practice tests, drills and your study plan, stays free.";

/**
 * 402 Payment Required, which is the rare status code that means precisely
 * what it says. It is distinguishable from a 401 (sign in) and a 429 (you have
 * used today's allowance), so a client can tell the three apart without
 * matching on message text.
 */
export const UPGRADE_STATUS = 402;

export interface FeatureDecision {
  allowed: boolean;
  /** Null when accounts are off, so nothing was resolved and nothing is known. */
  tier: string | null;
}

/**
 * The full answer, for a caller that wants to do something other than return a
 * response — logging a refusal, or shaping a payload differently for a tier.
 */
export async function checkFeature(req: Request, feature: Feature): Promise<FeatureDecision> {
  assertServerOnly(MODULE);
  if (!accountsEnabled() || !accountRuntimeEnabled()) return { allowed: true, tier: null };

  const user = await getSessionUser(req);
  const entitlement = user ? await resolveEntitlement(user.id, user.email) : ANONYMOUS_ENTITLEMENT;
  return { allowed: tierAllows(entitlement.tier, feature), tier: entitlement.tier };
}

/**
 * Null to proceed, or the response to return.
 *
 * A refusal is a 402 and nothing else — no tier name, no expiry, no hint about
 * how the decision was reached. What the account is entitled to is available
 * from /api/account/status to the account itself; it is not something an
 * error on an unrelated route should be narrating.
 */
export async function requireFeature(req: Request, feature: Feature): Promise<Response | null> {
  let decision: FeatureDecision;
  try {
    decision = await checkFeature(req, feature);
  } catch (err) {
    /*
      An unreachable database is not a refusal to pay for something, so it does
      not say so. The learner is told the service is briefly unavailable, which
      is what has actually happened, and the real cause goes to the log.
    */
    logInternal(`requireFeature/${feature}`, err);
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  if (decision.allowed) return null;
  return safeJsonError(UPGRADE_MESSAGE, UPGRADE_STATUS);
}
