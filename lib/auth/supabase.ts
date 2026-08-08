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
