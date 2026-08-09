import { COSTED_ROUTES, type CostedRoute } from "@/lib/ai/models";
import { DAILY_AI_CAPS, MONTHLY_AI_CAPS, SELLABLE_TIERS, type Tier } from "@/lib/billing/tiers";

/*
  What each bucket may spend, and over what window.

  Policy lives in the application rather than in the database so that changing
  an allowance is a deploy, not a migration against a live database. The
  database is the mechanism — it counts and it decides atomically — but it is
  told the numbers.

  The per-tier numbers are not written here. They come from
  lib/billing/tiers.ts, which is also what the pricing page reads, because a
  page that promises 100 tutor questions while the meter enforces 50 is a
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

  ---------------------------------------------------------------------------
  One allowance per route, over two windows

  The allowance used to be a single pool shared across every route: twenty
  requests a day, spend them how you like. It was easier to explain and it could
  not be costed, because the five routes differ in price by a factor of thirty —
  see the note in lib/billing/tiers.ts. Now each route has its own allowance, and
  each allowance is checked over two windows:

    monthly  a rolling 30 days. This is the one that bounds the money, and it is
             the number the pricing page prints.

    daily    a rolling 24 hours, at roughly a fifth of the month. It cannot make
             the bill smaller — the monthly cap already did that — it stops one
             account draining a month of allowance in an afternoon and colliding
             with the upstream API's own rate limits.
*/

export const AI_ROUTES = COSTED_ROUTES;

export type AiRoute = CostedRoute;

/** A rolling 24 hours, not a calendar day: no midnight cliff, no timezone argument. */
export const USAGE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * A rolling 30 days, for the same reason. "A month" is not a fixed length and
 * a calendar month would hand a subscriber who joined on the 28th three days of
 * allowance for a month of money.
 */
export const MONTH_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * Zero, deliberately.
 *
 * It was 5. The reasoning then was that a visitor should be able to try a
 * feature before deciding an account was worth it, which is a fair instinct
 * and the wrong trade here. An unauthenticated caller is one nobody can ban,
 * bill or rate-limit by identity — only by address, and addresses are cheap.
 * Five calls each, across the five most expensive routes in the app, is a
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

/** The shape of `p_limits` that supabase/migrations/0012_route_limits.sql reads. */
export const LIMITS_SCHEMA_VERSION = 2;

type RouteCaps = Record<CostedRoute, number | null>;

/*
  A copy, two levels deep, and that is the point rather than tidiness.

  This object is handed to the meter, and a shallow copy would share the
  per-tier records with lib/billing/tiers.ts — so anything holding the payload
  could write through it and change the policy the pricing page reads. The
  catalogue is the definition; nothing downstream of it gets a handle on it.
*/
function capsFor(source: Record<Tier, RouteCaps>): Record<string, RouteCaps> {
  const out: Record<string, RouteCaps> = {};
  for (const tier of [...SELLABLE_TIERS, "admin"] as const) out[tier] = { ...source[tier] };
  return out;
}

/**
 * The jsonb object `check_and_record_usage` meters from.
 *
 * ---------------------------------------------------------------------------
 * Why the flat per-tier numbers are all zero
 *
 * They are the *old* shape, kept only so that a database which has not had
 * 0012_route_limits.sql applied fails safely. The old function reads
 * `p_limits ->> tier` as a single number and knows nothing about `monthly` or
 * `daily`; handed a zero it refuses every AI request for every paying tier,
 * which is inconvenient and cannot cost the owner a penny. The alternatives are
 * both worse: omit the key and the old function reads it as unlimited, and put
 * a real number there and the caps are silently the wrong ones.
 *
 * `admin` stays null — unlimited — so that when this happens the owner's own
 * account still works and the diagnostics panel can say what is wrong.
 */
export function limitsForDatabase(): Record<string, unknown> {
  return {
    schema: LIMITS_SCHEMA_VERSION,

    // Fail-closed fallback for a database still on the pre-0012 function.
    free: 0,
    standard: 0,
    plus: 0,
    pro: 0,
    admin: null,

    anonymous: ANONYMOUS_DAILY_AI_CALLS,
    ip: IP_DAILY_CEILING,
    month_seconds: MONTH_WINDOW_SECONDS,
    monthly: capsFor(MONTHLY_AI_CAPS),
    daily: capsFor(DAILY_AI_CAPS),
  };
}

export function isAiRoute(value: string): value is AiRoute {
  return (AI_ROUTES as readonly string[]).includes(value);
}
