import { assertServerOnly } from "./server-only";
import { supabaseConfig } from "./env";
import { readAccountKind } from "./account-identity";
import { cutoverWriteBarrierArmed } from "@/lib/cloudflare/write-barrier";
import type {
  ProgressSnapshotExpectation,
  ProgressSnapshotMutation,
} from "@/lib/progress/server-snapshots";
/* Type-only, so nothing from the billing lane is imported at runtime and the
   dependency stays one-way: billing reads this file, not the other way round. */
import type { AccessGrant } from "@/lib/billing/access";

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

  ---------------------------------------------------------------------------
  Cutover write barrier

  Once an owner arms lib/cloudflare/write-barrier.ts's "learner" barrier,
  every write below refuses rather than reaching Supabase — see that file for
  why a D1-durable barrier, not an environment variable, is what closes a
  Workers deploy's split-brain window. Each guarded function checks it first
  and returns its own ordinary failure value, matching how every other
  failure in that function is already reported; nothing here invents a new
  shape a caller has to learn.

  Supabase Auth (every call to `/auth/v1/*` — sendMagicLink,
  enabledOAuthProviders, refreshAccessToken, signInWithPassword,
  signInWithGoogleIdToken, signUpWithPassword, userFromAccessToken, and the
  admin-user calls inside deleteAccount/supabaseAuthUserState) is exempt on
  purpose and deliberately never checks the barrier. Login and Google sign-in
  are not migrating away from Supabase — there is no D1 identity provider to
  move them to — so gating them here would only break sign-in. Do not "fix"
  that by adding a check to any of them.
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
 * Calls a Postgres function and reports what happened, body and all.
 *
 * `rpc` above deliberately throws away the response body, because PostgREST
 * names columns and constraints in it and none of that belongs in an answer to
 * a learner. This one keeps it, and is used from exactly one place: the
 * owner-only diagnostics route.
 *
 * That distinction is the whole reason it is a separate function rather than a
 * flag on `rpc`. A flag would sit there waiting for somebody to pass it from a
 * route that answers the public.
 */
export async function rpcDiagnostic(
  fn: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; detail: string }> {
  let res: Response;
  try {
    res = await request(`/rest/v1/rpc/${fn}`, {
      method: "POST",
      body: JSON.stringify(args),
      asServiceRole: true,
    });
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
  const body = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, detail: body.slice(0, 600) };
}

export interface AppSettingRecord {
  key: string;
  value: unknown;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Fixed service-role read used by the temporary Cloudflare parity bridge.
 *
 * This intentionally exposes one named operation rather than a generic table
 * query. The caller needs the authoritative Postgres clock as well as the JSON
 * value; `get_app_setting` returns only the value and cannot prove that an
 * ordered D1 replica has caught up.
 */
export async function getAppSettingRecord(key: string): Promise<AppSettingRecord | null> {
  if (key.length < 1 || key.length > 120 || key.includes("\0")) {
    throw new SupabaseError("app setting key is invalid");
  }
  const res = await request(
    `/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}`
      + "&select=key,value,updated_at,updated_by&limit=1",
    { method: "GET", asServiceRole: true },
  );
  if (!res.ok) throw new SupabaseError(`app setting read failed with ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  if (
    row.key !== key
    || typeof row.updated_at !== "string"
    || !Number.isFinite(Date.parse(row.updated_at))
    || (row.updated_by !== null && typeof row.updated_by !== "string")
  ) {
    throw new SupabaseError("app setting response is invalid");
  }
  return {
    key,
    value: row.value,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
  };
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
  username: string | null;
  accountKind: import("./account-identity").AccountKind | null;
  avatarPath: string | null;
  birthDate: string | null;
  email: string | null;
  /** Authoritative profile row clock used to order the temporary D1 mirror. */
  updatedAt: string | null;
}

/**
 * Read only the retired account-kind value while saving identity. Unlike the
 * optional profile presentation read, storage failures throw so callers can
 * fail closed instead of confusing an outage with an empty legacy field.
 */
export async function getAccountKind(
  userId: string,
): Promise<import("./account-identity").AccountKind | null> {
  const res = await request(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=account_kind`,
    { method: "GET", asServiceRole: true },
  );
  if (!res.ok) throw new SupabaseError(`profile account kind read failed with ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  if (!Array.isArray(rows)) throw new SupabaseError("profile account kind response is invalid");
  return rows[0] ? readAccountKind(rows[0].account_kind) : null;
}

function readProfileRow(row: Record<string, unknown>, username: string | null): Profile {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    displayName: str(row.display_name),
    username,
    accountKind: readAccountKind(row.account_kind),
    avatarPath: str(row.avatar_path),
    birthDate: str(row.birth_date),
    email: str(row.email),
    updatedAt: str(row.updated_at),
  };
}

/** The caller's own profile row. Null when it cannot be read. */
export async function getProfile(userId: string): Promise<Profile | null> {
  let res: Response;
  let usernameRes: Response;
  try {
    [res, usernameRes] = await Promise.all([request(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}` +
        `&select=display_name,avatar_path,birth_date,email,account_kind,updated_at`,
      { method: "GET", asServiceRole: true },
    ), request(
      `/rest/v1/usernames?user_id=eq.${encodeURIComponent(userId)}&select=username`,
      { method: "GET", asServiceRole: true },
    )]);
  } catch {
    return null;
  }
  if (!res.ok || !usernameRes.ok) return null;
  try {
    const rows = (await res.json()) as Record<string, unknown>[];
    const usernames = (await usernameRes.json()) as { username?: unknown }[];
    const username = typeof usernames?.[0]?.username === "string" ? usernames[0].username : null;
    return Array.isArray(rows) && rows[0] ? readProfileRow(rows[0], username) : null;
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
  fields: Partial<Pick<Profile, "displayName" | "birthDate" | "avatarPath" | "accountKind">>,
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if ("displayName" in fields) patch.display_name = fields.displayName;
  if ("birthDate" in fields) patch.birth_date = fields.birthDate;
  if ("avatarPath" in fields) patch.avatar_path = fields.avatarPath;
  if ("accountKind" in fields) patch.account_kind = fields.accountKind;
  if (Object.keys(patch).length === 0) return true;
  if (await cutoverWriteBarrierArmed("learner")) return false;

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

export type AccountIdentityStatus =
  | "ok"
  | "invalid_display_name"
  | "invalid_account_kind"
  | "invalid_username"
  | "reserved_username"
  | "taken_username"
  | "missing_profile";

export async function setAccountIdentity(
  userId: string,
  displayName: string,
  username: string,
  accountKind: import("./account-identity").AccountKind,
  birthDate: string | null,
): Promise<AccountIdentityStatus> {
  // Every caller of this function already wraps it in a try/catch that turns
  // a throw into "unavailable" — see lib/cloudflare/data-router.ts.
  if (await cutoverWriteBarrierArmed("learner")) {
    throw new SupabaseError("cutover write barrier is armed for learner writes");
  }
  return rpc<AccountIdentityStatus>("set_account_identity", {
    p_user_id: userId,
    p_display_name: displayName,
    p_username: username,
    p_account_kind: accountKind,
    p_birth_date: birthDate,
  });
}

export type UsernameClaimStatus = "ok" | "invalid" | "reserved" | "taken";

/** Atomically claims or changes one username through the service-role RPC. */
export async function claimUsername(
  userId: string,
  username: string,
): Promise<UsernameClaimStatus> {
  // Every caller of this function already wraps it in a try/catch that turns
  // a throw into "unavailable" — see lib/cloudflare/data-router.ts.
  if (await cutoverWriteBarrierArmed("learner")) {
    throw new SupabaseError("cutover write barrier is armed for learner writes");
  }
  return rpc<UsernameClaimStatus>("claim_username", {
    p_user_id: userId,
    p_username: username,
  });
}

export async function emailForUsername(username: string): Promise<string | null> {
  try {
    return await rpc<string | null>("email_for_username", { p_username: username });
  } catch {
    return null;
  }
}

/**
 * The rows that are currently granting an account something, as a fixed read of
 * five columns and nothing else.
 *
 * It exists so that a billing screen can say whether what somebody holds renews
 * or runs out — a card subscription does the first and a wallet pass the second,
 * and `resolve_entitlement` returns the same shape for both. lib/billing/access.ts
 * decides which from these five fields.
 *
 * Deliberately not a new database function: adding one means a migration, a
 * migration cannot be previewed, and every fact needed is already in the row.
 *
 * The filter is the granting half of `resolve_entitlement`'s own condition. A row
 * whose period has already ended is dropped by the caller's date comparison
 * rather than by a `now()` written into a query string here.
 *
 * Never a user id from a request body: the caller has one a bearer token
 * resolved to.
 */
export async function currentAccessGrants(userId: string): Promise<AccessGrant[]> {
  if (!isUuid(userId)) return [];
  const res = await request(
    `/rest/v1/subscriptions?user_id=eq.${userId}&status=in.(active,trialing)` +
      "&select=provider,tier,external_price_id,current_period_end,cancel_at_period_end" +
      "&limit=50",
    { method: "GET", asServiceRole: true },
  );
  if (!res.ok) throw new SupabaseError(`subscription lookup failed with ${res.status}`);
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    const text = (value: unknown) =>
      typeof value === "string" && value.length > 0 ? value : null;
    return {
      provider: text(record.provider) ?? "",
      tier: text(record.tier) ?? "",
      priceId: text(record.external_price_id),
      currentPeriodEnd: text(record.current_period_end),
      cancelAtPeriodEnd: record.cancel_at_period_end === true,
    };
  });
}

export interface StripeSubscriptionReplica {
  id: string;
  userId: string;
  status: string;
  tier: string;
  customerId: string | null;
  subscriptionId: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  providerEventAt: string | null;
  verifiedAt: string;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fixed service-role read of the Stripe row that Supabase just committed.
 * Duplicate and stale webhook deliveries use this current row for D1 repair,
 * rather than replaying the older delivery as though it were authoritative.
 */
export async function stripeSubscriptionReplica(
  externalSubscriptionId: string,
): Promise<StripeSubscriptionReplica | null> {
  if (!externalSubscriptionId || externalSubscriptionId.length > 255) return null;
  try {
    const res = await request(
      "/rest/v1/subscriptions?provider=eq.stripe" +
        `&external_subscription_id=eq.${encodeURIComponent(externalSubscriptionId)}` +
        "&select=id,user_id,status,tier,external_customer_id,external_subscription_id," +
        "external_price_id,current_period_end,cancel_at_period_end,provider_event_at," +
        "verified_at,raw,created_at,updated_at&limit=1",
      { method: "GET", asServiceRole: true },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Record<string, unknown>[];
    const row = Array.isArray(rows) ? rows[0] : null;
    const required = [
      row?.id,
      row?.user_id,
      row?.status,
      row?.tier,
      row?.external_subscription_id,
      row?.verified_at,
      row?.created_at,
      row?.updated_at,
    ];
    if (!row || required.some((value) => typeof value !== "string" || value.length === 0)) {
      return null;
    }
    const optional = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
    return {
      id: row.id as string,
      userId: row.user_id as string,
      status: row.status as string,
      tier: row.tier as string,
      customerId: optional(row.external_customer_id),
      subscriptionId: row.external_subscription_id as string,
      priceId: optional(row.external_price_id),
      currentPeriodEnd: optional(row.current_period_end),
      cancelAtPeriodEnd: row.cancel_at_period_end === true,
      providerEventAt: optional(row.provider_event_at),
      verifiedAt: row.verified_at as string,
      raw: row.raw,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  } catch {
    return null;
  }
}

/*
  ---------------------------------------------------------------------------
  The promotional Pro trial

  Three fixed operations, in the same spirit as everything else in this file:
  named, narrow, and impossible to point at another table. A promo row is an
  ordinary `subscriptions` row with provider 'promo', so `resolve_entitlement`
  in supabase/migrations/0026 picks it up with no new resolution logic and no
  second place where an entitlement can be decided.
*/

const PROMO_PROVIDER = "promo";

/** The all-zero uuid. Not a real account, and cannot become one. */
const NO_SUCH_USER = "00000000-0000-0000-0000-000000000000";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** What PostgREST said went wrong, as much of it as a decision needs. */
interface PostgrestFailure {
  code: string;
  message: string;
}

async function failureFrom(res: Response): Promise<PostgrestFailure> {
  const body = (await res.json().catch(() => null)) as
    | { code?: unknown; message?: unknown; details?: unknown }
    | null;
  const text = [body?.message, body?.details].filter((part) => typeof part === "string").join(" ");
  return { code: typeof body?.code === "string" ? body.code : "", message: text };
}

/**
 * Whether the database will accept a promo subscription row at all.
 *
 * `subscriptions_provider_check` in 0001 allows only 'stripe' and 'apple', and
 * widening it is a hand-run ALTER the owner has to decide to apply. Until they
 * do, the offer must not be shown — a button that can only fail is worse than
 * no button — so this asks the database rather than assuming either answer.
 *
 * It asks by attempting an insert that cannot succeed: the row names a user id
 * that does not exist. Postgres evaluates CHECK constraints when the row is
 * formed and foreign keys afterwards, in an after-trigger, so the two failures
 * are distinguishable and neither writes anything.
 *
 *   23514 on the provider check  the ALTER has not been run
 *   23503 (foreign key)          the provider was accepted; the ALTER has run
 *
 * Anything else is read as "not yet", because the safe direction for an
 * unrecognised answer is to leave the offer hidden.
 */
export async function promoProviderAllowed(): Promise<boolean> {
  try {
    const res = await request("/rest/v1/subscriptions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: NO_SUCH_USER,
        provider: PROMO_PROVIDER,
        status: "active",
        tier: "pro",
      }),
      asServiceRole: true,
    });
    /*
      Not expected: the foreign key should have refused it. If some future
      schema drops that key, the probe would have written a stray row, so it is
      removed again rather than left behind.
    */
    if (res.ok) {
      await request(
        `/rest/v1/subscriptions?user_id=eq.${NO_SUCH_USER}&provider=eq.${PROMO_PROVIDER}`,
        { method: "DELETE", asServiceRole: true },
      ).catch(() => undefined);
      return true;
    }
    const failure = await failureFrom(res);
    if (failure.code === "23503") return true;
    return false;
  } catch {
    return false;
  }
}

/*
  ---------------------------------------------------------------------------
  Giving the trial up, and the one status that says who did it

  A learner may hand the trial back, and if they change their mind the offer
  comes back. That only works if "the learner set it down" and "the owner
  withdrew the trial" are different marks on the row, because the second must
  never turn back into an offer. Both used to be `status = 'canceled'`.

  So a released grant is `status = 'paused'`, and the column is the status
  itself for four reasons:

    * it needs nothing new. `subscriptions_status_check` in
      supabase/migrations/0001 already permits 'paused', so this ships without a
      migration and without a second thing for the owner to run;
    * it does not grant. `resolve_entitlement` counts only 'active' and
      'trialing', so a paused row leaves the account on the free plan the
      moment it is written, with no other code consulted;
    * it is true. The row is intact and can be made active again, which is what
      a paused subscription is. 'expired' would claim a period ended and a promo
      row has no period; 'refunded' would claim money moved and none did;
      `cancel_at_period_end` would claim a period end there isn't; and 'canceled'
      is the one value that has to keep meaning "over for good", because that is
      what the owner's sweep writes;
    * it keeps the record. Deleting the row instead would leave a released
      account indistinguishable from one that never accepted — so after the
      owner ended the trial, that account could take out a *fresh* grant and
      quietly undo their decision. A paused row cannot: see
      `resumePromoSubscription`, which will only ever revive a paused row.

  The consequence for the owner is one word in their SQL, and it is written out
  in the pull request: the sweep that ends the trial for everybody has to reach
  released rows as well as live ones —

    update public.subscriptions set status = 'canceled', updated_at = now()
     where provider = 'promo' and status in ('active', 'paused');

  `updated_at` is left to `subscriptions_touch_updated_at` (0001) in the writes
  below, which sets it on every update; naming it here as well would only give
  the trigger something to overwrite.
*/
const PROMO_RELEASED_STATUS = "paused";

/** What this account's promo rows say, in the only terms this feature needs. */
export type PromoRowState =
  /** No promo row: never offered, or never answered. */
  | "none"
  /** A row that still grants Pro. */
  | "holding"
  /** The learner handed it back. The offer may be made again. */
  | "released"
  /** Over, by the owner's decision. The offer must never be made again. */
  | "ended";

/**
 * Reads this account's promo rows and reduces them to one answer.
 *
 * Nothing stops an account holding two promo rows — a retried accept in the
 * wrong millisecond would do it — so every row is read and the *least*
 * generous conclusion wins: one 'canceled' row anywhere means ended, whatever
 * else is there. The safe direction for a disagreement is the one that does not
 * hand out an entitlement the owner withdrew.
 */
export async function promoSubscriptionState(userId: string): Promise<PromoRowState> {
  if (!isUuid(userId)) return "none";
  const res = await request(
    `/rest/v1/subscriptions?user_id=eq.${userId}&provider=eq.${PROMO_PROVIDER}` +
      "&select=status",
    { method: "GET", asServiceRole: true },
  );
  if (!res.ok) throw new SupabaseError(`promo lookup failed with ${res.status}`);
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows) || rows.length === 0) return "none";

  const statuses = rows.map((row) => (row as { status?: unknown }).status);
  if (statuses.some((s) => s !== "active" && s !== "trialing" && s !== PROMO_RELEASED_STATUS)) {
    return "ended";
  }
  if (statuses.some((s) => s === "active" || s === "trialing")) return "holding";
  return "released";
}

export type PromoUpdateOutcome =
  /** The row moved. */
  | "changed"
  /** No row was in the status this update requires. Nothing was written. */
  | "no-match"
  /** A CHECK refused it — the provider widening has been rolled back. */
  | "unsupported"
  | "failed";

/**
 * Records the update, or says why not, without letting PostgREST's words out.
 *
 * `return=representation` is what makes "no row matched" distinguishable from
 * "one row moved": both are a 200, and the difference is the length of the
 * array. That is the whole point of writing these as conditional updates — the
 * WHERE carries the policy, so two requests racing cannot both win.
 */
async function promoStatusUpdate(
  query: string,
  body: Record<string, unknown>,
): Promise<PromoUpdateOutcome> {
  try {
    const res = await request(query, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
      asServiceRole: true,
    });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) && rows.length > 0 ? "changed" : "no-match";
    }
    const failure = await failureFrom(res);
    if (failure.code === "23514" || /subscriptions_\w+_check/.test(failure.message)) {
      return "unsupported";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

/**
 * Hands the trial back: a live promo row becomes paused, so the account is on
 * the free plan again and the offer may be made to it again.
 *
 * Postgres re-checks a row's constraints on update, `provider` included, so
 * this reports `unsupported` if the provider widening has been rolled back
 * under a grant that is still standing.
 */
export function releasePromoSubscription(userId: string): Promise<PromoUpdateOutcome> {
  if (!isUuid(userId)) return Promise.resolve("failed");
  return promoStatusUpdate(
    `/rest/v1/subscriptions?user_id=eq.${userId}&provider=eq.${PROMO_PROVIDER}` +
      "&status=in.(active,trialing)",
    { status: PROMO_RELEASED_STATUS },
  );
}

/**
 * Starts a released trial again.
 *
 * Only a paused row is touched. If the owner has ended the trial in the
 * meantime the row is 'canceled', nothing matches, and the answer is `no-match`
 * — which the caller turns into "the trial has ended" rather than into a second
 * grant. The whole reversibility rule lives in that WHERE clause.
 */
export function resumePromoSubscription(userId: string): Promise<PromoUpdateOutcome> {
  if (!isUuid(userId)) return Promise.resolve("failed");
  return promoStatusUpdate(
    `/rest/v1/subscriptions?user_id=eq.${userId}&provider=eq.${PROMO_PROVIDER}` +
      `&status=eq.${PROMO_RELEASED_STATUS}`,
    {
      status: "active",
      /*
        `raw` says when the grant that is standing now began, so it is rewritten
        rather than left describing a trial that was handed back. The status is
        the record of whose decision the row is in; this is the record of when.
      */
      raw: { kind: "free-pro-trial", acceptedAt: new Date().toISOString(), restarted: true },
    },
  );
}

export type PromoInsertOutcome = "inserted" | "exists" | "unsupported" | "failed" | "barred";

/**
 * Writes the promo row: Pro, active, with no period end, so
 * `resolve_entitlement` treats it as current until somebody changes its status.
 *
 * `unsupported` is the honest answer when the provider check has not been
 * widened yet, and the route turns it into a sentence rather than a 500.
 * `barred` is the same shape of honest answer for a domain the owner has
 * armed a cutover write barrier for — lib/billing/promo.ts's `acceptPromo`
 * does not special-case it, so it falls through to exactly the same
 * `PROMO_MESSAGES.failed` sentence as `unsupported` does; the distinct value
 * exists only so a server log can tell the two apart.
 */
export async function insertPromoSubscription(userId: string): Promise<PromoInsertOutcome> {
  if (!isUuid(userId)) return "failed";
  if (await cutoverWriteBarrierArmed("learner")) return "barred";
  try {
    const res = await request("/rest/v1/subscriptions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        provider: PROMO_PROVIDER,
        status: "active",
        tier: "pro",
        current_period_end: null,
        /*
          Why the row exists, kept with the row. Every other subscription can be
          explained by a provider payload; this one can only be explained by us.
        */
        raw: { kind: "free-pro-trial", acceptedAt: new Date().toISOString() },
      }),
      asServiceRole: true,
    });
    if (res.ok) return "inserted";
    const failure = await failureFrom(res);
    if (failure.code === "23514" || /subscriptions_provider_check/.test(failure.message)) {
      return "unsupported";
    }
    if (failure.code === "23505") return "exists";
    return "failed";
  } catch {
    return "failed";
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
  if (await cutoverWriteBarrierArmed("learner")) return false;
  try {
    const res = await fetch(`${config.url}/storage/v1/object/avatars/${path}`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": contentType,
        // Every upload gets a new random path, so this object is immutable.
        // Let the browser/CDN reuse it instead of downloading the avatar again
        // on every page while its signed URL remains valid.
        "Cache-Control": "max-age=31536000, immutable",
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
  if (await cutoverWriteBarrierArmed("learner")) return false;
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

  /*
    Before the user row goes, or the path is unrecoverable. `deleteAvatar`
    checks the barrier and returns false without deleting anything once one is
    armed, which is accepted here rather than propagated: the admin DELETE
    below is the exempt Supabase Auth action Apple's deletion requirement
    actually needs, an orphaned Storage object is not a new failure mode this
    file did not already have on a network error, and the cascade in Postgres
    removes every application-data row regardless of whether the object was
    pre-deleted.
  */
  if (avatarPath) await deleteAvatar(avatarPath);

  try {
    const res = await request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      asServiceRole: true,
    });
    // Repeating an account deletion is idempotent. A 404 confirms the same
    // terminal state as a successful DELETE and is not a cleanup failure.
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export type SupabaseAuthUserState = "exists" | "deleted" | "unknown";

/**
 * Owner-only recovery probe for an account DELETE whose network result was
 * ambiguous. A 404 is the only non-success response that proves the identity
 * no longer exists; every other failure remains unknown and must fail closed.
 */
export async function supabaseAuthUserState(userId: string): Promise<SupabaseAuthUserState> {
  if (!userId || userId.length > 80) return "unknown";
  try {
    const res = await request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "GET",
      asServiceRole: true,
    });
    if (res.ok) return "exists";
    if (res.status === 404) return "deleted";
    return "unknown";
  } catch {
    return "unknown";
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

/*
  ---------------------------------------------------------------------------
  Cloudflare drift backfill: one exact row, by its exact key

  lib/cloudflare/domain-drift.ts already names which row is wrong. These four
  reads answer the follow-up question — what does that one row actually hold
  right now — for exactly the domains the backfill in
  lib/cloudflare/domain-backfill.ts repairs. Each is as narrow as every other
  fixed read in this file: one table, one row, by its exact key, with only the
  columns the corresponding D1 mirror writer needs. None of them list, none of
  them accept a caller-built filter, and a key that fails its own shape check
  is never sent to Postgres at all.
*/

export interface CloudflareBackfillProgressSnapshotRow {
  userId: string;
  storeKey: string;
  payload: unknown;
  /** Postgres `updated_at`: the source clock domain-drift.ts orders by. */
  updatedAt: string;
}

/** The one progress row named by a `<user_id>/<store_key>` drift key. */
export async function cloudflareBackfillProgressSnapshotRow(
  userId: string,
  storeKey: string,
): Promise<CloudflareBackfillProgressSnapshotRow | null> {
  if (!isUuid(userId) || !isProgressKey(storeKey)) return null;
  let res: Response;
  try {
    res = await request(
      `/rest/v1/progress_snapshots?user_id=eq.${encodeURIComponent(userId)}` +
        `&store_key=eq.${encodeURIComponent(storeKey)}` +
        "&select=payload,updated_at&limit=1",
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => null)) as Record<string, unknown>[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row.updated_at !== "string") return null;
  return { userId, storeKey, payload: row.payload, updatedAt: row.updated_at };
}

const BACKFILL_ID = /^[0-9]{1,20}$/;

export interface CloudflareBackfillUsageEventRow {
  id: string;
  userId: string | null;
  route: string;
  ipHash: string | null;
  outcome: string;
  createdAt: string;
}

/** The one usage event named by its decimal Supabase identity value. */
export async function cloudflareBackfillUsageEventRow(
  id: string,
): Promise<CloudflareBackfillUsageEventRow | null> {
  if (!BACKFILL_ID.test(id)) return null;
  let res: Response;
  try {
    res = await request(
      `/rest/v1/usage_events?id=eq.${encodeURIComponent(id)}` +
        "&select=user_id,route,ip_hash,outcome,created_at&limit=1",
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => null)) as Record<string, unknown>[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (
    !row || typeof row.route !== "string" || typeof row.outcome !== "string"
    || typeof row.created_at !== "string"
  ) {
    return null;
  }
  return {
    id,
    userId: typeof row.user_id === "string" ? row.user_id : null,
    route: row.route,
    ipHash: typeof row.ip_hash === "string" ? row.ip_hash : null,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

export interface CloudflareBackfillAiCostEventRow {
  id: string;
  source: string;
  providerRequestId: string | null;
  externalReference: string | null;
  route: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheCreation5mInputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: string;
  occurredAt: string;
  recordedAt: string;
}

/** The one AI cost event named by its decimal Supabase identity value. */
export async function cloudflareBackfillAiCostEventRow(
  id: string,
): Promise<CloudflareBackfillAiCostEventRow | null> {
  if (!BACKFILL_ID.test(id)) return null;
  let res: Response;
  try {
    res = await request(
      `/rest/v1/ai_cost_events?id=eq.${encodeURIComponent(id)}` +
        "&select=source,provider_request_id,external_reference,route,model,input_tokens," +
        "output_tokens,cache_creation_input_tokens,cache_creation_5m_input_tokens," +
        "cache_creation_1h_input_tokens,cache_read_input_tokens,cost_usd,occurred_at," +
        "recorded_at&limit=1",
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => null)) as Record<string, unknown>[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (
    !row || typeof row.source !== "string" || row.cost_usd === null
    || typeof row.cost_usd === "undefined"
    || typeof row.occurred_at !== "string" || typeof row.recorded_at !== "string"
  ) {
    return null;
  }
  const int = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const text = (value: unknown) => typeof value === "string" ? value : null;
  return {
    id,
    source: row.source,
    providerRequestId: text(row.provider_request_id),
    externalReference: text(row.external_reference),
    route: text(row.route),
    model: text(row.model),
    inputTokens: int(row.input_tokens),
    outputTokens: int(row.output_tokens),
    cacheCreationInputTokens: int(row.cache_creation_input_tokens),
    cacheCreation5mInputTokens: int(row.cache_creation_5m_input_tokens),
    cacheCreation1hInputTokens: int(row.cache_creation_1h_input_tokens),
    cacheReadInputTokens: int(row.cache_read_input_tokens),
    costUsd: String(row.cost_usd),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

export interface CloudflareBackfillSubscriptionRow {
  id: string;
  userId: string;
  provider: string;
  status: string;
  tier: string;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  providerEventAt: string | null;
  verifiedAt: string;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * The one subscription named by its Supabase primary key.
 *
 * Deliberately separate from `stripeSubscriptionReplica` above: that lookup
 * is keyed by `external_subscription_id` and assumes the row is Stripe's,
 * because it exists only to answer a Stripe webhook. A backfill is handed a
 * Supabase row id by domain-drift.ts and must not assume its provider, so
 * this reads `provider` back rather than hard-coding it.
 */
export async function cloudflareBackfillSubscriptionRow(
  id: string,
): Promise<CloudflareBackfillSubscriptionRow | null> {
  if (!isUuid(id)) return null;
  let res: Response;
  try {
    res = await request(
      `/rest/v1/subscriptions?id=eq.${encodeURIComponent(id)}` +
        "&select=user_id,provider,status,tier,external_customer_id,external_subscription_id," +
        "external_price_id,current_period_end,cancel_at_period_end,provider_event_at," +
        "verified_at,raw,created_at,updated_at&limit=1",
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => null)) as Record<string, unknown>[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  const required = [row?.user_id, row?.provider, row?.status, row?.tier, row?.verified_at, row?.created_at, row?.updated_at];
  if (!row || required.some((value) => typeof value !== "string" || value.length === 0)) return null;
  const optional = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
  return {
    id,
    userId: row.user_id as string,
    provider: row.provider as string,
    status: row.status as string,
    tier: row.tier as string,
    customerId: optional(row.external_customer_id),
    subscriptionId: optional(row.external_subscription_id),
    priceId: optional(row.external_price_id),
    currentPeriodEnd: optional(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    providerEventAt: optional(row.provider_event_at),
    verifiedAt: row.verified_at as string,
    raw: row.raw,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Delete named progress rows for one learner, rather than emptying them.
 *
 * A plain PostgREST delete, not an RPC: there is no compare-and-swap to do
 * here. The caller has already committed the emptied, tombstoned payload
 * through compare_and_swap_progress_snapshots above, so a row that another
 * device rewrote in the meantime is a row holding work that postdates the
 * clear — and the tombstone on the profile, which this deliberately never
 * touches, is what decides whether that work survives. Deleting by user and
 * store key alone is therefore correct and idempotent: a row already gone
 * deletes cleanly.
 *
 * `isProgressKey` is applied here rather than trusted from the caller. This
 * builds a filter from its argument, and the one thing that must never be
 * possible is a key from a request body widening it.
 */
export async function deleteProgressSnapshots(
  userId: string,
  storeKeys: string[],
): Promise<boolean> {
  const keys = storeKeys.filter(isProgressKey);
  if (keys.length !== storeKeys.length) return false;
  if (keys.length === 0) return true;
  if (await cutoverWriteBarrierArmed("learner")) return false;
  const inList = keys.map((key) => `"${encodeURIComponent(key)}"`).join(",");
  try {
    const res = await request(
      `/rest/v1/progress_snapshots?user_id=eq.${encodeURIComponent(userId)}` +
        `&store_key=in.(${inList})`,
      { method: "DELETE", asServiceRole: true },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export type ProgressSnapshotCasResult =
  | { status: "committed"; at: string }
  | { status: "conflict" }
  | { status: "unavailable" };

/**
 * Atomically compare and replace one to three progress snapshots.
 *
 * The database function takes a per-user transaction lock before comparing
 * the expected payloads. A second device that raced the route therefore gets
 * `conflict`; the route re-reads, merges that device's work, and retries. The
 * function also writes the whole submitted set in one transaction, so a
 * provider failure cannot commit just one of the three sync keys.
 */
export async function compareAndSwapProgressSnapshots(
  userId: string,
  expected: ProgressSnapshotExpectation[],
  snapshots: ProgressSnapshotMutation[],
): Promise<ProgressSnapshotCasResult> {
  if (await cutoverWriteBarrierArmed("learner")) return { status: "unavailable" };
  try {
    const response = await rpc<unknown>("compare_and_swap_progress_snapshots", {
      p_user_id: userId,
      p_expected: expected,
      p_snapshots: snapshots,
    });
    const committedAt = typeof response === "string"
      ? response
      : Array.isArray(response)
        && typeof (response[0] as { compare_and_swap_progress_snapshots?: unknown } | undefined)
          ?.compare_and_swap_progress_snapshots === "string"
          ? (response[0] as { compare_and_swap_progress_snapshots: string })
              .compare_and_swap_progress_snapshots
          : response === null
            || (Array.isArray(response)
              && (response[0] as { compare_and_swap_progress_snapshots?: unknown } | undefined)
                ?.compare_and_swap_progress_snapshots === null)
              ? null
              : undefined;
    if (committedAt === null) return { status: "conflict" };
    if (typeof committedAt !== "string" || !Number.isFinite(Date.parse(committedAt))) {
      return { status: "unavailable" };
    }
    return { status: "committed", at: committedAt };
  } catch {
    return { status: "unavailable" };
  }
}

export type OrganizationHistoryClearPolicy =
  | "allowed"
  | "restricted"
  | "not-installed"
  | "unavailable";

/**
 * Whether this learner currently belongs to an organization as a student.
 *
 * This is deliberately a fixed, server-only query rather than trusting the
 * client portal response. It is used at the progress write boundary, where a
 * hidden button is not access control. `not-installed` is distinct from a
 * database outage: before the organization migration exists there cannot be
 * an organization membership to protect, while an unexpected failure must
 * not be treated as permission to delete.
 */
export async function organizationHistoryClearPolicy(
  userId: string,
): Promise<OrganizationHistoryClearPolicy> {
  let res: Response;
  try {
    res = await request(
      `/rest/v1/organization_memberships?user_id=eq.${encodeURIComponent(userId)}` +
        "&role=eq.student&status=in.(active,leave_requested,suspended)&select=id&limit=1",
      { method: "GET", asServiceRole: true },
    );
  } catch {
    return "unavailable";
  }

  // PostgREST returns 404 when a relation is absent from the schema cache.
  // That is the pre-migration state, not an outage or an authorization result.
  if (res.status === 404) return "not-installed";
  if (!res.ok) return "unavailable";

  try {
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return "unavailable";
    return rows.length > 0 ? "restricted" : "allowed";
  } catch {
    return "unavailable";
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

/**
 * Signs in with an email address and a password.
 *
 * Mediated by the server for the same reason the refresh is: GoTrue wants the
 * anon key as `apikey`, and no Supabase credential belongs in a client bundle.
 *
 * Returns null for every failure — wrong password, no such account, account
 * with no password set, upstream outage. The caller must not distinguish them
 * in what it sends back, because "no such account" is the answer that turns a
 * login form into a way to ask whether a given person uses this app.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<RefreshedSession | null> {
  /*
    Bounded before it leaves this process. GoTrue hashes the password with
    bcrypt, and bcrypt's cost is paid by whoever runs it — an unbounded field
    here is a way to spend the auth server's CPU from an unauthenticated form.
  */
  if (!email || email.length > 254) return null;
  if (!password || password.length > 200) return null;

  let res: Response;
  try {
    res = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
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

/**
 * Exchanges a Google Identity Services credential for the ordinary Supabase
 * session the rest of BandUp already understands.
 *
 * Google talks directly to bandup.life in the browser; only the signed Google
 * ID token and the one-use nonce reach this endpoint. This removes the visible
 * Supabase project domain from the account chooser without moving identity or
 * profiles out of Supabase Auth.
 */
export async function signInWithGoogleIdToken(
  idToken: string,
  nonce: string,
): Promise<RefreshedSession | null> {
  if (!idToken || idToken.length > 16_384) return null;
  if (!nonce || nonce.length > 256) return null;

  let res: Response;
  try {
    res = await request("/auth/v1/token?grant_type=id_token", {
      method: "POST",
      body: JSON.stringify({
        provider: "google",
        id_token: idToken,
        nonce,
      }),
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

export type SignUpOutcome = "session" | "confirm" | "taken" | "weak" | "failed";

export interface SignUpResult {
  outcome: SignUpOutcome;
  /** Present only when the project is set to sign people in immediately. */
  session: RefreshedSession | null;
}

/**
 * Creates an account from an email address and a password.
 *
 * Two good outcomes, and which one happens is a Supabase project setting
 * rather than anything this code decides: with email confirmation on, GoTrue
 * returns a user and no session and posts a confirmation link; with it off, a
 * session comes straight back. Both are reported so the page can say which
 * one happened rather than guessing and being wrong half the time.
 */
export async function signUpWithPassword(
  email: string,
  password: string,
  redirectTo: string,
): Promise<SignUpResult> {
  const fail: SignUpResult = { outcome: "failed", session: null };
  if (!email || email.length > 254) return fail;
  if (!password || password.length > 200) return fail;

  let res: Response;
  try {
    res = await request("/auth/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, options: { emailRedirectTo: redirectTo } }),
    });
  } catch {
    return fail;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    /*
      GoTrue's own words are read here and never returned. The two cases worth
      separating are the ones a person can act on: a password the project
      considers too weak, and an address that already has an account.
    */
    const code = (body as { error_code?: unknown; msg?: unknown } | null)?.error_code;
    if (code === "weak_password") return { outcome: "weak", session: null };
    if (res.status === 422 || res.status === 400) return { outcome: "taken", session: null };
    return fail;
  }

  const parsed = body as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    user?: { email?: unknown };
  } | null;

  if (parsed && typeof parsed.access_token === "string" && parsed.access_token.length > 0) {
    return {
      outcome: "session",
      session: {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
        expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : null,
        email: typeof parsed.user?.email === "string" ? parsed.user.email : null,
      },
    };
  }

  /*
    A 200 with no token is the confirmation path, and it is also what GoTrue
    returns for an address that already exists when the project is set to hide
    that fact. Reporting "check your inbox" for both is the correct answer to
    each: one has mail waiting, and the other already has an account and will
    not learn so from here.
  */
  return { outcome: "confirm", session: null };
}

export interface AuthedUser {
  id: string;
  email: string | null;
  /** Supabase Auth registration time; application databases only mirror it. */
  createdAt?: string | null;
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
/*
  null means "not signed in"; a throw means "could not find out". The two must
  never be collapsed into one, because every caller of getSessionUser treats a
  null user as license to answer with the anonymous/free case — see
  lib/billing/gate.ts and app/api/account/status/route.ts, both of which grant
  ANONYMOUS_ENTITLEMENT to a null user and only fail loudly (503, or the
  usage-metering fail-open switch) when this function throws.

  Before this, a network failure calling GoTrue or a 5xx from it were caught
  and folded into `return null` alongside a genuinely invalid token, so an
  outage in Supabase Auth made every signed-in, paying request look identical
  to a stranger who never signed in: silently downgraded to free, with nothing
  logged and nothing failing loudly. That is precisely the failure this file's
  own callers were written to guard against — app/api/billing/checkout/route.ts
  already wraps this call in a try/catch expecting it to throw — the throw
  just never happened.

  Only a response GoTrue itself uses to say "this token is not valid" (401,
  and 403 for a revoked/blocked one) is read as "not signed in". Anything else
  that goes wrong — the request failing outright, GoTrue answering with a
  server error, or a 200 whose body cannot be parsed as the user it promised —
  is a failure to determine identity, not an identity, and is thrown so the
  caller decides what an unknown answer means rather than being handed one.
*/
export async function userFromAccessToken(token: string): Promise<AuthedUser | null> {
  if (!token || token.length > 4096) return null;
  let res: Response;
  try {
    res = await request("/auth/v1/user", { method: "GET", bearer: token });
  } catch (err) {
    throw new SupabaseError(
      `auth/v1/user unreachable: ${err instanceof Error ? err.name : "unknown"}`,
    );
  }
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new SupabaseError(`auth/v1/user failed with ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SupabaseError("auth/v1/user returned a body that was not JSON");
  }
  const user = body as { id?: unknown; email?: unknown; created_at?: unknown };
  if (typeof user.id !== "string" || user.id.length === 0) return null;
  return {
    id: user.id,
    email: typeof user.email === "string" ? user.email : null,
    createdAt: typeof user.created_at === "string" ? user.created_at : null,
  };
}
