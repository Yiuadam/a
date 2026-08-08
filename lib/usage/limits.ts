/*
  What each tier may spend, and over what window.

  Policy lives here rather than in the database so that changing an allowance
  is a deploy, not a migration against a live database. The database is the
  mechanism — it counts and it decides atomically — but it is told the numbers.

  What is *not* metered, and never will be: the placement test, the study plan,
  the bundled reading and listening tests, the grammar drills and the vocabulary
  drills. Those are static content served from the bundle. They cost nothing per
  use, so charging for them would be charging for nothing.

  Only the four routes that call an AI model are metered, because those are the
  four that spend money per request.
*/

export const AI_ROUTES = ["define", "generate", "grade/writing", "grade/speaking"] as const;

export type AiRoute = (typeof AI_ROUTES)[number];

/** A rolling 24 hours, not a calendar day: no midnight cliff, no timezone argument. */
export const USAGE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Per-bucket allowances within the window. `null` means unlimited.
 *
 * `admin` is null because the owner has to be able to exercise the app without
 * tripping a limit built for other people — and because an admin flag that
 * still throttled would be a flag that did nothing.
 *
 * `anonymous` is small but not zero: phase 1 must not break a visitor who has
 * never signed in, and phase 2 rolls login out gradually. It is enough to try
 * the feature and see why it is worth an account.
 */
export const USAGE_LIMITS: Record<"free" | "pro" | "admin" | "anonymous" | "ip", number | null> = {
  free: 20,
  pro: 500,
  admin: null,
  anonymous: 5,
  ip: 60,
};

/**
 * The per-address ceiling exists so that "no account" is not a way to spend
 * the owner's API budget. It applies to signed-in users too — one address is
 * one address, however many accounts are driven from it — with admins exempt.
 */
export function limitsForDatabase(): Record<string, number | null> {
  return { ...USAGE_LIMITS };
}

export function isAiRoute(value: string): value is AiRoute {
  return (AI_ROUTES as readonly string[]).includes(value);
}
