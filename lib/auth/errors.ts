import { NextResponse } from "next/server";

/*
  Responses from this system say what the caller needs to do and nothing about
  how the server is built. No stack traces, no database messages, no key
  fragments, no upstream status codes. See ACCOUNTS.md, threat 7.

  The detail is not discarded — it goes to the server log, where it is useful
  and where the person reading it is already trusted.
*/

/** Messages are written for a learner, not for whoever deployed the app. */
export const MESSAGES = {
  /*
    Deliberately does not say which allowance, because this one message is
    returned by five routes and the route the learner is standing in is the one
    they already know about. It also does not say "resets tomorrow": each
    allowance rolls over 30 days, one request at a time, and /billing is where
    that is drawn properly.
  */
  quotaExceeded:
    "You've used this month's allowance for this. Your billing page shows what's left of the others — and practice tests, drills and your study plan are never limited.",
  /*
    "This week" rather than "today": the second ceiling is a rolling seven days
    now, and telling somebody to come back tomorrow when the answer is Thursday
    is worse than saying nothing.
  */
  rateLimited:
    "You've used this week's allowance for this. It refills a week after each request, so some of it comes back tomorrow — your billing page shows when.",
  unavailable: "The AI tutor is briefly unavailable. Please try again in a minute.",
  // The account endpoints are not the AI tutor, so they say something true of
  // themselves — and equally uninformative about why.
  accountUnavailable: "Account details aren't available right now. Please try again in a minute.",
  signInRequired: "Please sign in to use this.",
} as const;

/**
 * Logs the real cause server-side and returns a response that carries none of
 * it. `where` is a fixed string from the call site, never user input.
 */
export function logInternal(where: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[accounts] ${where}: ${detail}`);
}

export function safeJsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
