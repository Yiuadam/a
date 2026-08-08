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

  The allowance is one pool shared across all of them rather than a separate
  budget per feature, and the tutor chat is the first route where that is a
  visible trade-off: a learner can spend a day's allowance on questions and
  have none left to get an essay marked. It is still one pool. Splitting it
  would mean a learner who wants only marking is capped below what their tier
  paid for, and it would mean explaining five numbers instead of one — so the
  chat page and /billing both say plainly that the count is shared, which is
  the honest version of the same fact.
*/

export const AI_ROUTES = [
  "define",
  "generate",
  "grade/writing",
  "grade/speaking",
  /*
    The tutor chat, metered per question asked rather than per conversation.
    A conversation has no end a server can observe — a learner who comes back
    an hour later is still in the same thread — so "per conversation" would be
    a limit on nothing. Note that this string is also an allowed value of
    usage_events_route_check; see supabase/migrations/0007_chat_route.sql.
  */
  "chat",
] as const;

export type AiRoute = (typeof AI_ROUTES)[number];

/** A rolling 24 hours, not a calendar day: no midnight cliff, no timezone argument. */
export const USAGE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Zero, deliberately.
 *
 * It was 5. The reasoning then was that a visitor should be able to try a
 * feature before deciding an account was worth it, which is a fair instinct
 * and the wrong trade here. An unauthenticated caller is one nobody can ban,
 * bill or rate-limit by identity — only by address, and addresses are cheap.
 * Five calls each, across the four most expensive routes in the app, is a
 * standing invitation to spend the owner's API budget from a script, and the
 * owner carries that cost with nothing to show for it.
 *
 * What a visitor gets instead is everything that costs nothing to serve: the
 * placement test, the study plan, a listening and a reading paper, and every
 * grammar and vocabulary drill. All of those are marked against an answer key
 * from the bundle, so they work perfectly with no model behind them. That is a
 * real trial of the app, not a crippled one — it just isn't a trial of the AI.
 */
export const ANONYMOUS_DAILY_AI_CALLS = 0;

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
