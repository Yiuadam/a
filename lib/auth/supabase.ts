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

export interface Profile {
  displayName: string | null;
  avatarPath: string | null;
  birthDate: string | null;
  email: string | null;
}

function readProfileRow(row: Record<string, unknown>): Profile {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    displayName: str(row.display_name),
    avatarPath: str(row.avatar_path),
    birthDate: str(row.birth_date),
    email: str(row.email),
  };
}

/** The caller's own profile row. Null when it cannot be read. */
export async function getProfile(userId: string): Promise<Profile | null> {
  let res: Response;
  try {
    res = await request(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}` +
        `&select=display_name,avatar_path,birth_date,email`,
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const rows = (await res.json()) as Record<string, unknown>[];
    return Array.isArray(rows) && rows[0] ? readProfileRow(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Writes the fields a learner is allowed to change about themselves.
 *
 * The allow-list is the point. `role` lives in this same table and decides
 * whether an account has a usage limit at all, so a patch built from whatever
 * keys arrived in the request body would be a way to grant yourself admin
 * (ACCOUNTS.md, threat 1). Only these four names ever reach the database, and
 * an explicit null clears a field rather than being ignored.
 */
export async function updateProfile(
  userId: string,
  fields: Partial<Pick<Profile, "displayName" | "birthDate" | "avatarPath">>,
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if ("displayName" in fields) patch.display_name = fields.displayName;
  if ("birthDate" in fields) patch.birth_date = fields.birthDate;
  if ("avatarPath" in fields) patch.avatar_path = fields.avatarPath;
  if (Object.keys(patch).length === 0) return true;

  try {
    const res = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      asServiceRole: true,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Stores an avatar. `path` is always inside the caller's own folder. */
export async function uploadAvatar(
  path: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<boolean> {
  const config = supabaseConfig();
  if (!config) return false;
  try {
    const res = await fetch(`${config.url}/storage/v1/object/avatars/${path}`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A short-lived URL for an avatar in the private bucket.
 *
 * Signed rather than public because nobody but the owner ever sees these — the
 * app has no profile pages, no leaderboards and no comments — so a permanent
 * public URL would expose a picture for no benefit. An hour is long enough for
 * a session and short enough that a leaked link stops working.
 */
export async function signedAvatarUrl(path: string, expiresIn = 3600): Promise<string | null> {
  const config = supabaseConfig();
  if (!config) return null;
  let res: Response;
  try {
    res = await request(`/storage/v1/object/sign/avatars/${path}`, {
      method: "POST",
      asServiceRole: true,
      body: JSON.stringify({ expiresIn }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { signedURL?: unknown; signedUrl?: unknown };
    const rel = body.signedURL ?? body.signedUrl;
    return typeof rel === "string" ? `${config.url}/storage/v1${rel.replace(/^\/storage\/v1/, "")}` : null;
  } catch {
    return null;
  }
}

/** Removes an avatar. Used when a learner clears their picture. */
export async function deleteAvatar(path: string): Promise<boolean> {
  const config = supabaseConfig();
  if (!config) return false;
  try {
    const res = await fetch(`${config.url}/storage/v1/object/avatars/${path}`, {
      method: "DELETE",
      headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Deletes an account and everything attached to it.
 *
 * Apple requires this. Guideline 5.1.1(v): an app that lets someone create an
 * account must let them delete it from inside the app — not by emailing
 * support, not by visiting a website. It is a common rejection and it is also
 * simply right.
 *
 * Deleting the auth user is the whole job for the database, because every
 * table that references it does so with `on delete cascade`: the profile, the
 * usage events, the progress snapshots and any subscription row all go with
 * it. Storage does not cascade, so the avatar is removed first — an orphaned
 * picture in a bucket is exactly the kind of thing a deletion is supposed to
 * remove.
 */
export async function deleteAccount(userId: string, avatarPath: string | null): Promise<boolean> {
  const config = supabaseConfig();
  if (!config) return false;

  // Before the user row goes, or the path is unrecoverable.
  if (avatarPath) await deleteAvatar(avatarPath);

  try {
    const res = await request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      asServiceRole: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ProgressSnapshot {
  storeKey: string;
  payload: unknown;
  clientUpdatedAt: string | null;
}

/*
  The three localStorage keys a snapshot may hold, mirrored from the CHECK
  constraint in 0001_accounts_core.sql.

  Duplicated on purpose. The database is the authority and will reject anything
  else, but a request that has already crossed the network to be refused is a
  worse error than one refused here — and the failure it produces is a 500 with
  a Postgres constraint name in it, which threat 7 says must never leave.
*/
const PROGRESS_KEYS = ["ielts-prep-v1", "bandup.drills.v1", "bandup.lookups.v1"];

export function isProgressKey(key: unknown): key is string {
  return typeof key === "string" && PROGRESS_KEYS.includes(key);
}

/** Everything this user has synced. An account with nothing returns []. */
export async function getProgressSnapshots(userId: string): Promise<ProgressSnapshot[] | null> {
  let res: Response;
  try {
    res = await request(
      `/rest/v1/progress_snapshots?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=store_key,payload,client_updated_at`,
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let rows: unknown;
  try {
    rows = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  return rows.map((r) => {
    const row = r as { store_key?: unknown; payload?: unknown; client_updated_at?: unknown };
    return {
      storeKey: String(row.store_key ?? ""),
      payload: row.payload,
      clientUpdatedAt:
        typeof row.client_updated_at === "string" ? row.client_updated_at : null,
    };
  });
}

/**
 * Writes one snapshot, replacing whatever was there.
 *
 * Replacing rather than appending is safe only because the caller merges
 * first: sync.ts reads the account, merges it with the browser, and writes the
 * union back. A client that wrote its raw local state here would overwrite the
 * other device — which is the exact harm ACCOUNTS.md threat 5 is about.
 */
export async function putProgressSnapshot(
  userId: string,
  storeKey: string,
  payload: unknown,
  clientUpdatedAt: string,
): Promise<boolean> {
  if (!isProgressKey(storeKey)) return false;
  try {
    const res = await request("/rest/v1/progress_snapshots?on_conflict=user_id,store_key", {
      method: "POST",
      asServiceRole: true,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        store_key: storeKey,
        payload,
        client_updated_at: clientUpdatedAt,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
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
