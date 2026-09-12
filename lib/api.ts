"use client";

/*
  On the web the app and its API share an origin, so a relative path is right.
  Inside the iOS app the UI is served from the bundle (capacitor://) and has no
  server of its own, so requests must go to the deployed API instead. The base
  URL is baked in at build time by scripts/build-mobile.mjs.
*/
import { authedFetch } from "./account";

const BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/**
 * POST JSON and surface the API's error message rather than a bare status.
 *
 * authedFetch rather than fetch, and that is not a detail. Every AI route is
 * metered by *who is calling*, and identity travels in one place only: the
 * Authorization header. A plain fetch carries no header, so the server sees an
 * anonymous caller — and an anonymous caller's daily allowance is zero, by
 * design (lib/usage/limits.ts).
 *
 * The failure that produces is a nasty one to read from the outside: a
 * signed-in learner, on their first attempt of the day, is told they have used
 * all of today's AI feedback. Nothing is broken, no limit has been reached, and
 * the message is exactly right for the request that actually arrived. Three
 * routes shipped that way — generate, grade/writing and grade/speaking — while
 * the tutor, which used authedFetch, worked.
 */
/**
 * A failed POST, carrying the status the caller needs to tell two very
 * different things apart.
 *
 * A 402 means the plan does not include this — nothing is wrong and asking
 * again will fail in exactly the same way. Anything else is the server, the
 * model or the connection having a bad moment, and asking again is the right
 * thing to offer. Without the status a caller can only see that marking did
 * not happen, which is how a candidate came to be told their essays were not
 * marked with no way to try again.
 *
 * `status` is 0 when the request never reached a server at all.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  /** Whether asking again could plausibly get a different answer. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/*
  How long postJSON waits for a route to answer before giving up from the
  client side — so a hung connection ends in a message rather than a spinner
  nobody can stop watching. lib/anthropic.ts bounds its own worst case to
  well inside this, so most of it is headroom: the network hop each way, and
  the requireFeature/checkAiUsage checks either side of the model call.
*/
const TIMEOUT_MS = 60_000;

export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await authedFetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      /*
        Without this, a connection that hangs — the model stalling, a
        response that never arrives with nothing telling the socket so —
        holds this promise open for as long as the platform allows, which is
        long enough that "usually under a minute" (the marking screens' own
        copy) becomes a wait measured in tens of minutes. See the catch
        below for what a learner is told when it fires.
      */
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    /*
      A timeout is not "never reached the server" — it reached it and the
      answer never came back — and it earns its own sentence rather than the
      network-failure one below: "check your connection" is the wrong advice
      for a learner whose connection was never the problem.
    */
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ApiError(
      timedOut
        ? "Marking took too long. Your work is still here — try again."
        : "Couldn't reach the server. Check your connection and try again.",
      0,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError("The server returned an unexpected response. Please try again.", res.status);
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "Something went wrong. Please try again.";
    throw new ApiError(message, res.status);
  }
  return payload as T;
}
