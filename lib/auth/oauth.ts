import { assertServerOnly } from "./server-only";
import { accountsEnabled, supabaseConfig } from "./env";
import { supabaseConfigured } from "./supabase";

/*
  Sign-in, arranged so the browser never learns how to talk to Supabase.

  The obvious way to do OAuth with Supabase is to put the project URL and the
  anon key in NEXT_PUBLIC_ variables and let supabase-js run the handshake in
  the browser. That is the documented path and the anon key is safe to publish.
  It is still not what happens here, for two reasons that are specific to this
  codebase rather than general:

  1. Phase 1 built one rule and enforced it in CI — no Supabase credential of
     any kind reaches a client bundle, asserted by tests/no-secret-leak.test.mjs
     against the real build output. Adding the first NEXT_PUBLIC_SUPABASE_*
     variable would not be a leak, but it would end the invariant that makes
     leaks detectable. An invariant with one exception is a much weaker thing
     to check than one with none.
  2. supabase-js is a dependency this lane does not otherwise need, next to a
     hand-written client that exists precisely to avoid it.

  So the redirect is mediated. The browser asks *us* to start sign-in, we build
  the authorize URL server-side and answer with a 302. Supabase's authorize
  endpoint is a plain redirect — it takes no credential — so nothing secret is
  spent doing this, and the project URL stays server-side.

  ---------------------------------------------------------------------------
  Where the tokens come back

  GoTrue returns the session in the URL *fragment*:

      /account/callback/#access_token=...&refresh_token=...&expires_in=3600

  A fragment is never transmitted to any server. It does not appear in our
  access logs, in Vercel's, or in a Referer header. The client reads it, stores
  it, and strips it from the address bar.

  This is the implicit flow rather than PKCE. PKCE is the stronger choice for
  an app with a server session, because the code is exchanged server-to-server
  and never touches the browser. It is the wrong choice *here*: the verifier
  has to be held across the redirect, which means a cookie, and phase 1 chose
  bearer tokens over cookies deliberately so that one scheme works both on the
  web and inside the iOS WebView, where a cross-site cookie is simply not sent
  (ACCOUNTS.md, threat 6). Reaching for PKCE would mean introducing the cookie
  path that decision exists to avoid, on the one flow that must work on iOS.

  The cost is real and worth naming: the access token passes through the
  browser's address bar for the instant before the callback clears it, so it
  can land in session history. It cannot land in a server log. Given the token
  is short-lived and the alternative is a cookie that iOS will not send, this
  is the trade taken.
*/

const MODULE = "lib/auth/oauth.ts";

/*
  The providers this app offers, as a closed set.

  A provider name arriving in a query string is attacker-controlled. Passed
  through to Supabase unchecked it is at best a confusing error and at worst a
  way to drive users at an identity provider nobody chose. The allowlist means
  an unknown value is rejected here rather than interpreted there.
*/
export const OAUTH_PROVIDERS = ["google", "apple"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** Human-readable names, used in error messages and in the sign-in buttons. */
export const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: "Google",
  apple: "Apple",
};

/** Where Supabase sends the browser once the provider is done with it. */
export const CALLBACK_PATH = "/account/callback/";

/**
 * The absolute URL Supabase should return the browser to.
 *
 * Built from the request's own origin rather than from configuration, so the
 * preview deployments each send users back to themselves instead of all
 * funnelling into production. Supabase will refuse any redirect_to that is not
 * in the project's allow list, which is what stops this being an open redirect
 * — the check that matters is theirs, and it is a good deal stricter than
 * anything this function could do with a header it does not control.
 */
export function callbackUrl(origin: string): string {
  return new URL(CALLBACK_PATH, origin).toString();
}

/**
 * The URL that starts a provider handshake.
 *
 * Returns null when accounts are off or unconfigured, which the caller turns
 * into a 404-shaped answer: an endpoint that behaves differently before it is
 * configured tells a prober the feature exists and is merely switched off.
 */
export function authorizeUrl(provider: OAuthProvider, origin: string): string | null {
  assertServerOnly(MODULE);
  if (!accountsEnabled() || !supabaseConfigured()) return null;

  const config = supabaseConfig();
  if (!config) return null;

  const url = new URL(`${config.url}/auth/v1/authorize`);
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", callbackUrl(origin));
  return url.toString();
}
