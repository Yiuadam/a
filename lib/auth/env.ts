import { assertServerOnly } from "./server-only";
import { normaliseUsername } from "./usernames";

/*
  Every environment variable the accounts system reads, in one place.

  Two rules are enforced here rather than left to memory:

  1. Secrets are read through `process.env[name]` with a *computed* key. A
     computed key is invisible to the bundler's static replacement of
     `process.env.FOO`, so there is no expression in this file that a client
     build could ever turn into a literal string. The only variables written
     as static property accesses are the NEXT_PUBLIC_ ones, which are public
     by definition.

  2. Reading any of them calls `assertServerOnly` first, so a client component
     that imports this module throws immediately instead of silently receiving
     `undefined` and taking a wrong branch.

  ACCOUNTS.md, threat 4.
*/

const MODULE = "lib/auth/env.ts";

/** Names that must never appear in a client bundle. Asserted in CI. */
export const SERVER_ONLY_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "AVATAR_URL_SIGNING_KEY",
  "USAGE_IP_HASH_SALT",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "APPLE_IAP_ISSUER_ID",
  "APPLE_IAP_KEY_ID",
  "APPLE_IAP_PRIVATE_KEY",
  "APPLE_SIGNIN_SERVICES_ID",
  "APPLE_SIGNIN_TEAM_ID",
  "APPLE_SIGNIN_KEY_ID",
  "APPLE_SIGNIN_PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "BANDUP_SESSION_SIGNING_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "ANTHROPIC_ADMIN_KEY",
  "ANTHROPIC_WORKSPACE_ID",
  "ADMIN_EMAILS",
  "ADMIN_USERNAME",
] as const;

function secret(name: (typeof SERVER_ONLY_ENV_VARS)[number]): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Google OAuth client id used by Google Identity Services in the browser.
 *
 * A client id is public (Google embeds it in every authorization request), but
 * it still comes through the server so there is one runtime configuration for
 * local, preview and production builds. Keeping it out of NEXT_PUBLIC_* also
 * avoids baking a production identity into the iOS bundle.
 */
export function googleClientId(): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env["GOOGLE_CLIENT_ID"];
  return value && value.length > 0 ? value : undefined;
}

/**
 * The iOS application's own Google OAuth client, if one has been created.
 *
 * A separate client from the web one, and it has to be: Google issues an ID
 * token to a specific audience, and a token minted for an iOS client carries
 * that client as its `aud` rather than the website's. Both are accepted at
 * /api/auth/google/token for exactly that reason.
 *
 * It is public in the same way the web client ID is — an iOS OAuth client has
 * no secret at all, because a secret shipped inside an app is not one. It is
 * read from the environment rather than hard-coded only so a fork or a second
 * deployment can carry its own.
 */
export function googleIosClientId(): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env["GOOGLE_IOS_CLIENT_ID"];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Confidential credential for BandUp's server-side Google authorization-code
 * exchange. It is used only by the Worker, never by a browser or the iOS
 * bundle. The normal Google Identity Services button does not need it.
 */
export function googleOAuthClientSecret(): string | undefined {
  return secret("GOOGLE_OAUTH_CLIENT_SECRET");
}

/**
 * The one HTTPS origin registered as the callback home for this Worker.
 *
 * The request Host header is deliberately not trusted for an OAuth redirect:
 * persisting an attacker-controlled return address would turn the callback
 * into an open redirect. Each Worker environment declares its own fixed
 * public origin in Wrangler instead.
 */
export function googleOAuthAppOrigin(): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env["GOOGLE_OAUTH_APP_ORIGIN"];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/*
  ---------------------------------------------------------------------------
  Sign in with Apple, and the four credentials it needs.

  Read this before touching any of them: there are already three variables in
  this file whose names begin APPLE_, and they have nothing whatever to do with
  signing in. APPLE_IAP_ISSUER_ID, APPLE_IAP_KEY_ID and APPLE_IAP_PRIVATE_KEY
  are an App Store Connect API key for in-app purchase — a different key, from a
  different page of a different console, with a different issuer. The two sets
  are not interchangeable in either direction, and the failure if they are
  crossed is quiet: an App Store Connect key will produce a client secret Apple
  simply rejects, which surfaces as "sign-in could not be completed" and nothing
  else. So they are spelled APPLE_SIGNIN_* throughout, never APPLE_*, and the
  IAP three keep their own prefix.

  What each one is, and where it comes from:

  APPLE_SIGNIN_SERVICES_ID is the identifier of a Services ID — the *web*
  client, created under Certificates, Identifiers & Profiles -> Identifiers ->
  Services IDs. It looks like a reverse-DNS string (com.yiuadam.bandup.web),
  and it must NOT be the app's bundle id, which identifies the native client
  instead. Both are audiences an Apple identity token may legitimately carry;
  see lib/auth/apple-token.ts, which accepts exactly those two and nothing else.

  APPLE_SIGNIN_TEAM_ID is the ten-character team identifier shown at the top
  right of the developer account, and it is what Apple checks the client secret
  was issued by.

  APPLE_SIGNIN_KEY_ID and APPLE_SIGNIN_PRIVATE_KEY are the halves of one Sign in
  with Apple key, created under Keys with that capability enabled. The private
  half downloads once, as a .p8 file, and Apple will not give it out again.

  All four require membership of the paid Apple Developer Program. None of them
  is set in this deployment, which is the state this code was written for: every
  entry point below reports "not configured" and no Apple button is offered at
  all. See lib/auth/apple-oauth-server.ts for what that costs and what it buys.
*/

/**
 * The Services ID, which is the client id of the *web* Sign in with Apple flow.
 *
 * Public in the same sense a Google client id is — Apple sees it in every
 * authorize request — and read through the server for the same reason: one
 * runtime configuration for local, preview and production, and no production
 * identity baked into the iOS bundle.
 */
export function appleSignInServicesId(): string | undefined {
  return secret("APPLE_SIGNIN_SERVICES_ID");
}

/** The developer team the Sign in with Apple key belongs to. */
export function appleSignInTeamId(): string | undefined {
  return secret("APPLE_SIGNIN_TEAM_ID");
}

/** Which Sign in with Apple key signed a client secret, named in its JWT header. */
export function appleSignInKeyId(): string | undefined {
  return secret("APPLE_SIGNIN_KEY_ID");
}

/**
 * The contents of the .p8 file, PEM and all.
 *
 * Confidential in the strongest sense in this file: it does not merely
 * authenticate BandUp to Apple, it *is* BandUp as far as Apple's token endpoint
 * is concerned, and it cannot be rotated without a visit to the developer
 * console. It is never sent anywhere; it only ever signs the short-lived client
 * secret in lib/auth/apple-oauth-server.ts.
 *
 * Newlines are left exactly as they arrive. A .p8 pasted into a Cloudflare
 * secret sometimes keeps its real line breaks and sometimes arrives with the
 * two characters `\` and `n` where each break was, depending on how it was
 * pasted; the PEM reader handles both rather than this accessor guessing.
 */
export function appleSignInPrivateKey(): string | undefined {
  return secret("APPLE_SIGNIN_PRIVATE_KEY");
}

/**
 * The one HTTPS origin Apple is told to return the browser to.
 *
 * The same reasoning as GOOGLE_OAUTH_APP_ORIGIN above, and a separate variable
 * rather than a share of that one on purpose: the two are registered
 * independently with two different providers, and a deployment that has told
 * Apple about one host and Google about another is a state this should be able
 * to express rather than one it silently gets wrong. It lives in wrangler.jsonc
 * beside its Google counterpart and survives a deploy.
 */
export function appleSignInAppOrigin(): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env["APPLE_SIGNIN_APP_ORIGIN"];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The accounts system as a whole. Off by default, and off is the state in
 * which the app behaves exactly as it did before any of this existed.
 *
 * Note that this is *not* a NEXT_PUBLIC_ variable. The flag is a server
 * decision. Phase 2's UI learns the answer by asking /api/account/status,
 * which keeps one source of truth instead of two that can disagree.
 */
export function accountsEnabled(): boolean {
  assertServerOnly(MODULE);
  return process.env["ACCOUNTS_ENABLED"] === "1";
}

/**
 * Enables the Cloudflare-native identity path after its D1 migration has been
 * verified. Kept off until an owner explicitly enables it; Supabase remains
 * the compatibility path while existing account IDs are linked.
 */
export function nativeAuthEnabled(): boolean {
  assertServerOnly(MODULE);
  return String(process.env["CLOUDFLARE_NATIVE_AUTH"] ?? "") === "1";
}

/** HMAC key for BandUp's short-lived access tokens and rotating refresh tokens. */
export function bandUpSessionSigningKey(): string | undefined {
  return secret("BANDUP_SESSION_SIGNING_KEY");
}

/**
 * What the meter does when the database cannot be reached.
 *
 * The default is to refuse the call. Failing open would mean an attacker who
 * can make Supabase unavailable gets unlimited access to a paid API, which is
 * the opposite of what the meter is for. Set USAGE_FAIL_OPEN=1 to prefer
 * availability over cost control.
 */
export function usageFailOpen(): boolean {
  assertServerOnly(MODULE);
  return process.env["USAGE_FAIL_OPEN"] === "1";
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
}

/**
 * Returns null rather than throwing when the backend is unconfigured, so the
 * caller can decide. With the flag off nobody asks; with the flag on, a
 * missing configuration is a server error and never a silent free pass.
 */
export function supabaseConfig(): SupabaseConfig | null {
  const url = secret("SUPABASE_URL");
  const serviceRoleKey = secret("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = secret("SUPABASE_ANON_KEY");
  if (!url || !serviceRoleKey || !anonKey) return null;
  return { url: url.replace(/\/$/, ""), serviceRoleKey, anonKey };
}

/** HMAC key for short-lived private R2 avatar delivery grants. */
export function avatarUrlSigningKey(): string | undefined {
  return secret("AVATAR_URL_SIGNING_KEY");
}

/**
 * Salt for hashing client IP addresses before they are stored.
 *
 * Absent, IP-based rate limiting is skipped rather than performed on an
 * unsalted hash: an unsalted hash of an IPv4 address is trivially reversible
 * by enumerating the whole space, so it would be a plaintext IP log wearing a
 * disguise.
 */
export function ipHashSalt(): string | undefined {
  return secret("USAGE_IP_HASH_SALT");
}

/**
 * Origins allowed to send credentialed cross-origin requests to the API.
 *
 * Empty by default, which grants no cross-origin access at all. The iOS build
 * needs its Capacitor origin listed here before it can send an Authorization
 * header — see ACCOUNTS.md, threat 6.
 */
export function allowedOrigins(): string[] {
  assertServerOnly(MODULE);
  const raw = process.env["ACCOUNTS_ALLOWED_ORIGINS"];
  if (!raw) return [];
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}


/**
 * Addresses that are the owner, comma-separated.
 *
 * Exists so that promoting an account does not require opening a SQL editor.
 * Whoever can set this variable already has the service-role key and could
 * write the row directly, so it grants nothing that was not already theirs —
 * it just spells it in the place the other secrets live.
 *
 * Lower-cased and trimmed, because an address a person types into a login form
 * and an address they type into a Cloudflare secret will not match otherwise.
 */
export function adminEmails(): string[] {
  assertServerOnly(MODULE);
  return (secret("ADMIN_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

/** Read-only organization billing key for Anthropic's Cost Report API. */
export function anthropicAdminKey(): string | undefined {
  return secret("ANTHROPIC_ADMIN_KEY");
}

/** Optional workspace filter when the organization key covers more than BandUp. */
export function anthropicWorkspaceId(): string | undefined {
  return secret("ANTHROPIC_WORKSPACE_ID");
}

/**
 * A name the owner can type instead of an email address.
 *
 * Supabase knows every account by its email, and that does not change here —
 * this resolves to `ADMIN_EMAILS[0]` on the server before the password is ever
 * checked, so there is no second kind of account and no second way to be
 * authenticated. It is a nicer thing to type on a phone, and nothing more.
 *
 * Note what it deliberately is not: a way to hide which address is the owner's.
 * Anyone can put an address into the form and find out whether it has a
 * password by the same means as before. A username is convenience, and treating
 * it as a secret would be the kind of security that is only felt.
 */
export function adminUsername(): string | null {
  assertServerOnly(MODULE);
  /*
    Put through the same rules a learner's username would face, rather than
    trimmed and trusted. A value with an @ in it could never be reached — the
    sign-in form sends anything with an @ down the email path — so it would
    silently lock the owner out of the door they had just configured, and the
    only symptom would be a wrong password. Returning null is not better, but
    it is at least the same failure the form already knows how to describe.
  */
  return normaliseUsername(secret("ADMIN_USERNAME"));
}

export function emailForIdentifier(identifier: string): string | null {
  assertServerOnly(MODULE);
  const value = identifier.trim();
  if (value.includes("@")) return value.toLowerCase();

  /*
    Normalised on both sides, so the comparison is between two canonical forms
    and never between a typed string and a stored one. A name that is not a
    valid username at all fails here rather than being compared — which is why
    an empty box, a string of spaces and "ad am" all resolve to nothing.
  */
  const typed = normaliseUsername(value);
  if (typed === null) return null;

  const username = adminUsername();
  if (username !== null && typed === username) return adminEmails()[0] ?? null;
  return null;
}
