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
  quotaExceeded:
    "You've used all of today's AI feedback. It resets tomorrow — practice tests, drills and your study plan are always unlimited.",
  rateLimited: "That's a lot of requests at once. Please wait a moment and try again.",
  unavailable: "The AI tutor is briefly unavailable. Please try again in a minute.",
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
