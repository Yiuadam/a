import { assertServerOnly } from "@/lib/auth/server-only";
import { accountsEnabled, usageFailOpen } from "@/lib/auth/env";
import { supabaseConfigured, rpc } from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { clientIp, hashIp } from "./ip";
import { limitsForDatabase, USAGE_WINDOW_SECONDS, type AiRoute } from "./limits";

/*
  The one call the four AI routes make.

  It is shaped to be a two-line addition to a route that already exists:

      const denied = await checkAiUsage(req, "define");
      if (denied) return denied;

  Null means carry on. A response means stop and return it. Nothing else about
  those routes changes, which is the point — a metering layer that required
  restructuring the routes would be a metering layer that got applied to three
  of the four.

  It reads only headers, never the request body, so a route that goes on to
  call `req.json()` is unaffected.
*/

const MODULE = "lib/usage/guard.ts";

interface UsageDecision {
  allowed?: unknown;
  reason?: unknown;
  used?: unknown;
  quota?: unknown;
}

/**
 * Records the call and decides whether it may proceed.
 *
 * With the feature flag off this returns null before doing anything at all:
 * no session lookup, no database call, no added latency. That is what makes
 * phase 1 safe to deploy — the flag off is not "metering that always allows",
 * it is no metering.
 */
export async function checkAiUsage(req: Request, route: AiRoute): Promise<Response | null> {
  assertServerOnly(MODULE);
  if (!accountsEnabled()) return null;

  if (!supabaseConfigured()) {
    // The flag is on but the backend is not configured. This is a deployment
    // mistake, and the two ways to be wrong about it are opposite: allow, and
    // the meter is decorative; refuse, and the app is down. Which one is
    // chosen is explicit rather than incidental.
    logInternal("checkAiUsage", new Error("ACCOUNTS_ENABLED=1 but Supabase is not configured"));
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  let userId: string | null = null;
  let ipHash: string | null = null;
  try {
    const [user, hash] = await Promise.all([getSessionUser(req), hashIp(clientIp(req))]);
    userId = user?.id ?? null;
    ipHash = hash;
  } catch (err) {
    // An unverifiable token is an anonymous caller, not an error: the meter
    // still runs, at the anonymous allowance and against the address.
    logInternal("checkAiUsage/session", err);
  }

  let decision: UsageDecision | null;
  try {
    decision = await rpc<UsageDecision | null>("check_and_record_usage", {
      p_user_id: userId,
      p_ip_hash: ipHash,
      p_route: route,
      p_window_seconds: USAGE_WINDOW_SECONDS,
      p_limits: limitsForDatabase(),
    });
  } catch (err) {
    logInternal("checkAiUsage/rpc", err);
    // Failing closed is the default. An attacker who can make the database
    // unreachable would otherwise have found a way to uncap a paid API.
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  if (!decision || typeof decision.allowed !== "boolean") {
    // The function always returns a row, so this means the response was not
    // the shape this code was written against. Treated the same as an
    // unreachable database rather than waved through.
    logInternal("checkAiUsage/rpc", new Error("unrecognised usage decision"));
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  if (decision.allowed) return null;

  if (decision.reason === "rate_limited") {
    return safeJsonError(MESSAGES.rateLimited, 429);
  }
  return safeJsonError(MESSAGES.quotaExceeded, 429);
}
