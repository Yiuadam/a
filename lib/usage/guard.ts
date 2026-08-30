import { assertServerOnly } from "@/lib/auth/server-only";
import { accountsEnabled, isAdminEmail, usageFailOpen } from "@/lib/auth/env";
import { supabaseConfigured, rpc } from "@/lib/auth/supabase";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { mirrorsWritesToCloudflare } from "@/lib/cloudflare/bindings";
import { cutoverWriteBarrierArmed } from "@/lib/cloudflare/write-barrier";
import { domainWritesToCloudflareOnly } from "@/lib/cloudflare/cutover-domains";
import {
  admitUsageEventOnCloudflare,
  CloudflareIdSequenceNotSeededError,
  type UsageAuthorityDecision,
} from "@/lib/cloudflare/usage-quota-authority";
import {
  type UsageEventOutcome,
} from "@/lib/cloudflare/usage-cost-replica";
import { replicateUsageEventDurably } from "@/lib/cloudflare/replica-replay";
import { resolveEntitlement } from "@/lib/billing/entitlements";
import { MONTHLY_AI_CAPS, WEEKLY_AI_CAPS } from "@/lib/billing/tiers";
import { clientIp, hashIp } from "./ip";
import {
  ANONYMOUS_DAILY_AI_CALLS,
  IP_DAILY_CEILING,
  MONTH_WINDOW_SECONDS,
  limitsForDatabase,
  USAGE_WINDOW_SECONDS,
  type AiRoute,
} from "./limits";

const USAGE_QUOTA_AUTHORITY_DOMAIN = "usage_quota_authority";

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
  eventId?: unknown;
  eventCreatedAt?: unknown;
  eventOutcome?: unknown;
}

function usageEventOutcome(decision: UsageDecision): UsageEventOutcome | null {
  const expected = decision.allowed
    ? "admitted"
    : decision.reason === "rate_limited"
      ? "denied_rate"
      : decision.reason === "quota_exceeded"
        ? "denied_quota"
        : null;
  return decision.eventOutcome === expected ? expected : null;
}

async function mirrorUsageDecision(
  decision: UsageDecision,
  user: SessionUser | null,
  userId: string | null,
  route: AiRoute,
  ipHash: string | null,
): Promise<void> {
  const id = decision.eventId;
  const rawCreatedAt = decision.eventCreatedAt;
  const outcome = usageEventOutcome(decision);
  if (
    typeof id !== "string"
    || !/^[1-9]\d*$/.test(id)
    || typeof rawCreatedAt !== "string"
    || !Number.isFinite(Date.parse(rawCreatedAt))
    || outcome === null
  ) {
    throw new Error("Supabase usage decision omitted its committed event identity");
  }
  const mirrored = await replicateUsageEventDurably({
    id,
    userId,
    route,
    ipHash,
    outcome,
    createdAt: new Date(rawCreatedAt).toISOString(),
  }, user);
  if (!mirrored) throw new Error("D1 did not accept the usage event replica");
}

/**
 * The `usage_quota_authority` branch: D1 is the sole decision authority, no
 * Supabase RPC is called, and nothing is mirrored — there is no separate
 * Supabase write left to mirror from. See lib/cloudflare/usage-quota-
 * authority.ts for the atomicity this depends on.
 *
 * `usageFailOpen()` still governs an ordinary D1 outage, exactly as it
 * governs an ordinary Supabase outage in the branch below — two backends
 * does not mean two default answers to "what if it's down". It does **not**
 * govern `CloudflareIdSequenceNotSeededError`: that failure mode means the
 * owner turned this domain's mode to `cloudflare` before running the id-
 * counter seed SQL from the pull request that added this file, and failing
 * open for it would silently uncap every paid route for as long as the
 * mistake went unnoticed — the exact failure this whole design exists to
 * rule out. It always fails closed, regardless of the flag.
 */
async function checkAiUsageOnCloudflare(
  user: SessionUser | null,
  userId: string | null,
  ipHash: string | null,
  route: AiRoute,
): Promise<Response | null> {
  let isAdmin: boolean;
  let monthly: number | null;
  let weekly: number | null;
  try {
    const entitlement = await resolveEntitlement(userId, user?.email ?? null);
    isAdmin = entitlement.tier === "admin";
    monthly = MONTHLY_AI_CAPS[entitlement.tier][route];
    weekly = WEEKLY_AI_CAPS[entitlement.tier][route];
  } catch (err) {
    logInternal("checkAiUsage/cloudflare-entitlement", err);
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  let decision: UsageAuthorityDecision;
  try {
    decision = await admitUsageEventOnCloudflare({
      user,
      userId,
      ipHash,
      route,
      isAdmin,
      caps: { monthly, weekly, ip: IP_DAILY_CEILING, anonymous: ANONYMOUS_DAILY_AI_CALLS },
      monthWindowSeconds: MONTH_WINDOW_SECONDS,
      windowSeconds: USAGE_WINDOW_SECONDS,
    });
  } catch (err) {
    logInternal("checkAiUsage/cloudflare-authority", err);
    if (err instanceof CloudflareIdSequenceNotSeededError) {
      return safeJsonError(MESSAGES.unavailable, 503);
    }
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  /*
    This branch is deliberately not phrased the same way the Supabase branch
    below phrases its own "allowed means null" return. A source-text test
    elsewhere in this repo locates that exact phrasing to prove the Supabase
    branch returns only after its mirror attempt runs, using the first match
    in the file — an identical phrasing up here would shadow it.
  */
  if (!decision.allowed) {
    return decision.reason === "rate_limited"
      ? safeJsonError(MESSAGES.rateLimited, 429)
      : safeJsonError(MESSAGES.quotaExceeded, 429);
  }
  return null;
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

  const cloudflareUsageAuthority = domainWritesToCloudflareOnly(USAGE_QUOTA_AUTHORITY_DOMAIN);
  if (!accountRuntimeEnabled() || (!cloudflareUsageAuthority && !supabaseConfigured())) {
    // The flag is on but the backend is not configured. This is a deployment
    // mistake, and the two ways to be wrong about it are opposite: allow, and
    // the meter is decorative; refuse, and the app is down. Which one is
    // chosen is explicit rather than incidental.
    logInternal("checkAiUsage", new Error("ACCOUNTS_ENABLED=1 but Supabase is not configured"));
    return usageFailOpen() ? null : safeJsonError(MESSAGES.unavailable, 503);
  }

  /*
    Once this domain is D1-authoritative, no usage write reaches Supabase. The
    learner barrier must therefore protect only the remaining Supabase branch:
    applying it before the D1 branch would turn a successfully completed
    cutover into an outage for every AI route.
  */
  if (!cloudflareUsageAuthority && await cutoverWriteBarrierArmed("learner")) {
    logInternal("checkAiUsage", new Error("cutover write barrier is armed for learner writes"));
    return safeJsonError(MESSAGES.unavailable, 503);
  }

  let user: SessionUser | null = null;
  let userId: string | null = null;
  let ipHash: string | null = null;
  try {
    const [resolvedUser, hash] = await Promise.all([getSessionUser(req), hashIp(clientIp(req))]);
    user = resolvedUser;

    /*
      ADMIN_EMAILS is an entitlement source in its own right. The feature gate
      already recognises it, but the database meter can only see the profile
      row. Without this server-side check, an owner configured through the
      environment passes the tutor paywall and is then incorrectly metered as
      a free account. The email is taken only from the verified bearer token;
      no request field or client header can claim this exemption.
    */
    if (isAdminEmail(user?.email)) return null;

    userId = user?.id ?? null;
    ipHash = hash;
  } catch (err) {
    // An unverifiable token is an anonymous caller, not an error: the meter
    // still runs, at the anonymous allowance and against the address.
    logInternal("checkAiUsage/session", err);
  }

  if (cloudflareUsageAuthority) {
    return checkAiUsageOnCloudflare(user, userId, ipHash, route);
  }

  let decision: UsageDecision | null;
  // Only a mirrored write needs the committed event's identity back, so the
  // RPC choice asks the same mirror question the write below does.
  const shouldMirror = mirrorsWritesToCloudflare();
  try {
    const args = {
      p_user_id: userId,
      p_ip_hash: ipHash,
      p_route: route,
      p_window_seconds: USAGE_WINDOW_SECONDS,
      p_limits: limitsForDatabase(),
    };
    decision = shouldMirror
      ? await rpc<UsageDecision | null>("check_and_record_usage_with_event", args)
      : await rpc<UsageDecision | null>("check_and_record_usage", args);
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

  if (shouldMirror) {
    try {
      await mirrorUsageDecision(decision, user, userId, route, ipHash);
    } catch (err) {
      // Supabase has already committed the authoritative decision. A replica
      // outage is observable and repairable, but it must not turn that valid
      // decision into a false failure returned to the learner.
      logInternal("checkAiUsage/cloudflare-replica", err);
    }
  }

  if (decision.allowed) return null;

  if (decision.reason === "rate_limited") {
    return safeJsonError(MESSAGES.rateLimited, 429);
  }
  return safeJsonError(MESSAGES.quotaExceeded, 429);
}
