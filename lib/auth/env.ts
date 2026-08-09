import { assertServerOnly } from "./server-only";

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
  "USAGE_IP_HASH_SALT",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "APPLE_IAP_ISSUER_ID",
  "APPLE_IAP_KEY_ID",
  "APPLE_IAP_PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "ADMIN_EMAILS",
  "ADMIN_USERNAME",
] as const;

function secret(name: (typeof SERVER_ONLY_ENV_VARS)[number]): string | undefined {
  assertServerOnly(MODULE);
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
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
  const raw = secret("ADMIN_USERNAME");
  return raw ? raw.trim().toLowerCase() : null;
}

/**
 * Resolves whatever was typed in the identifier box to an email address.
 *
 * Returns the input unchanged when it already looks like an address, the
 * owner's address when it matches ADMIN_USERNAME, and null when it is a name
 * this deployment does not know — which the caller must answer exactly as it
 * answers a wrong password, or the form becomes a way to enumerate usernames.
 */
export function emailForIdentifier(identifier: string): string | null {
  assertServerOnly(MODULE);
  const value = identifier.trim();
  if (value.includes("@")) return value.toLowerCase();

  const username = adminUsername();
  if (username && value.toLowerCase() === username) return adminEmails()[0] ?? null;
  return null;
}
