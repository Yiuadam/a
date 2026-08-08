import { TIERS } from "@/lib/billing/tiers";

/*
  What each bucket may spend, and over what window.

  Policy lives in the application rather than in the database so that changing
  an allowance is a deploy, not a migration against a live database. The
  database is the mechanism — it counts and it decides atomically — but it is
  told the numbers.

  The per-tier numbers are no longer written here. They come from
  lib/billing/tiers.ts, which is also what the pricing page reads, because a
  page that promises 500 requests a day while the meter enforces 200 is a
  support ticket that arrives once per subscriber. There is one figure and both
  read it.

  The two buckets below that are *not* tiers stay here, because they are
  properties of the meter rather than of anything a learner can buy. Nobody
  subscribes to "anonymous" and nobody subscribes to an IP address.

  What is *not* metered, and never will be: the placement test, the study plan,
  the bundled reading and listening tests, the grammar drills and the vocabulary
  drills. Those are static content served from the bundle. They cost nothing per
  use, so charging for them would be charging for nothing.

  Only the routes that call an AI model are metered, because those are the ones
  that spend money per request.
*/

export const AI_ROUTES = ["define", "generate", "grade/writing", "grade/speaking"] as const;

export type AiRoute = (typeof AI_ROUTES)[number];

/** A rolling 24 hours, not a calendar day: no midnight cliff, no timezone argument. */
export const USAGE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Small but not zero. Phase 1 must not break a visitor who has never signed
 * in, and login rolls out gradually, so an anonymous caller gets enough to try
 * a feature and see why it is worth an account.
 */
export const ANONYMOUS_DAILY_AI_CALLS = 5;

/**
 * The per-address ceiling exists so that "no account" is not a way to spend the
 * owner's API budget. It applies to signed-in users too — one address is one
 * address, however many accounts are driven from it — with admins exempt,
 * because the owner working from a single address would otherwise trip it.
 */
export const IP_DAILY_CEILING = 60;

/**
 * Per-bucket allowances within the window. `null` means unlimited.
 *
 * `admin` is null because the owner has to be able to exercise the app without
 * tripping a limit built for other people — and because an admin flag that
 * still throttled would be a flag that did nothing.
 */
export const USAGE_LIMITS: Record<"free" | "pro" | "admin" | "anonymous" | "ip", number | null> = {
  free: TIERS.free.dailyAiCalls,
  pro: TIERS.pro.dailyAiCalls,
  admin: TIERS.admin.dailyAiCalls,
  anonymous: ANONYMOUS_DAILY_AI_CALLS,
  ip: IP_DAILY_CEILING,
};

/** The jsonb object `check_and_record_usage` meters from. */
export function limitsForDatabase(): Record<string, number | null> {
  return { ...USAGE_LIMITS };
}

export function isAiRoute(value: string): value is AiRoute {
  return (AI_ROUTES as readonly string[]).includes(value);
}
