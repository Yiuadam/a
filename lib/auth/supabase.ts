import { assertServerOnly } from "./server-only";
import { supabaseConfig } from "./env";

/*
  A deliberately small Supabase client.

  The official SDK is not used here, for two reasons. It is a sizeable
  dependency for what phase 1 needs, which is two HTTP calls; and a general
  purpose query builder in the same module as the service-role key invites
  someone later to write an arbitrary query with it. What is exported instead
  is a fixed set of named operations. There is no `from(table).select()` here,
  so there is no way to reach a table this file did not intend to expose.

  The service role bypasses Row Level Security. Everything in this file is
  therefore load-bearing for security, and everything in it is server-only.
*/

const MODULE = "lib/auth/supabase.ts";

/** Whether the accounts backend is configured at all. */
export function supabaseConfigured(): boolean {
  return supabaseConfig() !== null;
}

class SupabaseError extends Error {}

async function request(
  path: string,
  init: RequestInit & { asServiceRole?: boolean; bearer?: string },
): Promise<Response> {
  assertServerOnly(MODULE);
  const config = supabaseConfig();
  if (!config) throw new SupabaseError("accounts backend is not configured");

  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // PostgREST and GoTrue both require the anon key as `apikey`; the bearer
  // decides what the request is actually allowed to do.
  headers.set("apikey", init.asServiceRole ? config.serviceRoleKey : config.anonKey);
  headers.set(
    "Authorization",
    `Bearer ${init.asServiceRole ? config.serviceRoleKey : (init.bearer ?? config.anonKey)}`,
  );

  // A hung Supabase must not hold an AI route open until its own timeout.
  const abort = AbortSignal.timeout(8000);

  const res = await fetch(`${config.url}${path}`, {
    ...init,
    headers,
    signal: abort,
    cache: "no-store",
  });
  return res;
}

/** Calls a Postgres function. Only the service role may call any of ours. */
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await request(`/rest/v1/rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
    asServiceRole: true,
  });
  if (!res.ok) {
    // The response body from PostgREST can name columns and constraints. It is
    // read for the server log and never returned to a caller.
    throw new SupabaseError(`rpc ${fn} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Emails a one-time sign-in link.
 *
 * This is the whole of account recovery, and it is worth being explicit about
 * why an OAuth-only app needs it. If the only ways in are Google and Apple,
 * then losing the Google account loses the BandUp account with it — the study
 * plan, the placement result, every saved word — and there is no one to appeal
 * to, because the app never knew the user by anything except that identity. A
 * link sent to the address on file is the second door.
 *
 * Supabase matches on email, so a link sent to the address a Google identity
 * already carries signs into that same account rather than making a second
 * one.
 *
 * Returns true when the request was accepted. It deliberately does not report
 * whether the address is registered — see the route for why that matters.
 */
export async function sendMagicLink(email: string, redirectTo: string): Promise<boolean> {
  let res: Response;
  try {
    res = await request(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: "POST",
      // `should_create_user: false` is the difference between recovering an
      // account and quietly minting one. Someone typing an address they never
      // registered should be told nothing and given nothing, not handed a new
      // empty account under an address they may not own.
      body: JSON.stringify({ email, should_create_user: false }),
    });
  } catch {
    return false;
  }
  return res.ok;
}

/**
 * Which OAuth providers the Supabase project actually has configured.
 *
 * Asked rather than configured. The alternative was a second environment
 * variable listing them, which is a copy of the truth that drifts the moment
 * someone enables a provider in the dashboard and forgets the deploy — and
 * drift here means a sign-in button that goes to an error page.
 *
 * Returns null when the answer cannot be obtained, which the caller renders as
 * "sign-in is unavailable" rather than guessing. A guess is how a learner ends
 * up tapping Apple on a project where Apple was never set up.
 */
export async function enabledOAuthProviders(): Promise<string[] | null> {
  let res: Response;
  try {
    res = await request("/auth/v1/settings", { method: "GET" });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const external = (body as { external?: Record<string, unknown> }).external;
  if (!external || typeof external !== "object") return null;

  return Object.entries(external)
    .filter(([, on]) => on === true)
    .map(([name]) => name);
}

export interface RefreshedSession {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  email: string | null;
}

/**
 * Trades a refresh token for a new access token.
 *
 * Mediated here rather than done in the browser for the same reason sign-in
 * is: GoTrue wants the anon key as `apikey`, and no Supabase credential is
 * allowed into a client bundle. Returns null for a spent or forged token —
 * the caller signs the user out rather than retrying, because a refresh token
 * the issuer has rejected does not improve on a second attempt.
 */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshedSession | null> {
  if (!refreshToken || refreshToken.length > 4096) return null;

  let res: Response;
  try {
    res = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const session = body as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    user?: { email?: unknown };
  };
  if (typeof session.access_token !== "string" || session.access_token.length === 0) return null;

  return {
    accessToken: session.access_token,
    refreshToken: typeof session.refresh_token === "string" ? session.refresh_token : null,
    expiresIn: typeof session.expires_in === "number" ? session.expires_in : null,
    email: typeof session.user?.email === "string" ? session.user.email : null,
  };
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

/**
 * Exchanges an access token for the user it belongs to, by asking Supabase.
 *
 * The token is never decoded locally and never trusted for its contents. A JWT
 * is a base64 string that anyone can write; the only thing that makes it mean
 * anything is that the issuer agrees. So the issuer is asked.
 *
 * Returns null for any token that is absent, malformed, expired or revoked —
 * the caller then treats the request as anonymous, which is a state the system
 * already has to handle safely.
 */
export async function userFromAccessToken(token: string): Promise<AuthedUser | null> {
  if (!token || token.length > 4096) return null;
  let res: Response;
  try {
    res = await request("/auth/v1/user", { method: "GET", bearer: token });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const user = body as { id?: unknown; email?: unknown };
  if (typeof user.id !== "string" || user.id.length === 0) return null;
  return { id: user.id, email: typeof user.email === "string" ? user.email : null };
}
