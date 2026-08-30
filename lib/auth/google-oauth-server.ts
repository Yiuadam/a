import { assertServerOnly } from "./server-only";
import {
  accountsEnabled,
  googleClientId,
  googleOAuthAppOrigin,
  googleOAuthClientSecret,
} from "./env";
import { randomSessionToken, sha256Hex } from "./native-session";
import { requireBandUpCloudflareBindings, type BandUpCloudflareBindings } from "@/lib/cloudflare/bindings";

const MODULE = "lib/auth/google-oauth-server.ts";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  appOrigin: string;
}

interface TransactionRow {
  nonce: string;
  redirect_origin: string;
}

export interface GoogleOAuthTokenResponse {
  idToken: string;
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function config(): GoogleOAuthConfig | null {
  assertServerOnly(MODULE);
  const clientId = googleClientId();
  const clientSecret = googleOAuthClientSecret();
  const appOrigin = googleOAuthAppOrigin();
  return clientId && clientSecret && appOrigin ? { clientId, clientSecret, appOrigin } : null;
}

/** True only when the worker has every server-only value for the direct flow. */
export function googleOAuthServerFlowConfigured(): boolean {
  assertServerOnly(MODULE);
  return accountsEnabled() && config() !== null;
}

/**
 * Starts an OpenID Connect server flow using an opaque, one-time D1 state.
 *
 * This is intentionally a redirect flow rather than a client-side token
 * exchange. The Worker alone holds the Google web-client secret, and the
 * response returns only a BandUp session in the callback fragment.
 */
export async function startGoogleOAuthServerFlow(
  request: Request,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<string | null> {
  assertServerOnly(MODULE);
  const settings = config();
  if (!accountsEnabled() || !settings) return null;

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return null;
  }
  // OAuth responses must never be sent to an origin derived from Host.
  if (requestOrigin !== settings.appOrigin) return null;

  const state = randomSessionToken(32);
  const nonce = randomSessionToken(32);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  // These opaque rows expire after ten minutes; collecting them on the next
  // start keeps the one-time-state table bounded without a separate cron.
  await bindings.db.prepare(`
    DELETE FROM app_google_oauth_transactions
     WHERE expires_at <= ?
  `).bind(stamp(now)).run();
  const stored = await bindings.db.prepare(`
    INSERT INTO app_google_oauth_transactions (
      state_sha256, nonce, redirect_origin, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    await sha256Hex(state),
    nonce,
    settings.appOrigin,
    stamp(now),
    stamp(now + TRANSACTION_LIFETIME_MS),
  ).run();
  if (!stored.success) throw new Error("Google OAuth state could not be stored");

  const callback = new URL("/api/auth/google/callback", settings.appOrigin).toString();
  const target = new URL(GOOGLE_AUTHORIZE_URL);
  target.searchParams.set("client_id", settings.clientId);
  target.searchParams.set("redirect_uri", callback);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("prompt", "select_account");
  return target.toString();
}

/**
 * Atomically consumes the one-time state before an authorization code is
 * exchanged. A duplicate callback therefore cannot create a second session.
 */
export async function consumeGoogleOAuthState(
  state: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<{ nonce: string; appOrigin: string } | null> {
  assertServerOnly(MODULE);
  if (!state || state.length > 256) return null;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const hash = await sha256Hex(state);
  const row = await bindings.db.prepare(`
    SELECT nonce, redirect_origin
      FROM app_google_oauth_transactions
     WHERE state_sha256 = ?
       AND consumed_at IS NULL
       AND expires_at > ?
     LIMIT 1
  `).bind(hash, stamp(now)).first<TransactionRow>();
  if (!row || typeof row.nonce !== "string" || typeof row.redirect_origin !== "string") return null;

  const consumed = await bindings.db.prepare(`
    UPDATE app_google_oauth_transactions
       SET consumed_at = ?
     WHERE state_sha256 = ?
       AND consumed_at IS NULL
       AND expires_at > ?
  `).bind(stamp(now), hash, stamp(now)).run();
  if (!consumed.success || consumed.meta.changes !== 1) return null;

  const settings = config();
  // D1 is trusted storage, but preserve the fixed-origin invariant at this
  // boundary too so a malformed row cannot become an open redirect.
  if (!settings || row.redirect_origin !== settings.appOrigin) return null;
  return { nonce: row.nonce, appOrigin: row.redirect_origin };
}

/** Exchanges Google's one-time code without ever exposing the client secret. */
export async function exchangeGoogleAuthorizationCode(
  code: string,
  appOrigin: string,
): Promise<GoogleOAuthTokenResponse | null> {
  assertServerOnly(MODULE);
  const settings = config();
  if (!settings || appOrigin !== settings.appOrigin || !code || code.length > 4_096) return null;

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: new URL("/api/auth/google/callback", settings.appOrigin).toString(),
        grant_type: "authorization_code",
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: { id_token?: unknown } | null = null;
  try {
    body = await response.json() as { id_token?: unknown };
  } catch {
    return null;
  }
  return typeof body?.id_token === "string" && body.id_token.length <= 16_384
    ? { idToken: body.id_token }
    : null;
}

export function googleOAuthCallbackUrl(appOrigin: string, params: Record<string, string>): string {
  const target = new URL("/account/callback/", appOrigin);
  target.hash = new URLSearchParams(params).toString();
  return target.toString();
}
