import { assertServerOnly } from "./server-only";
import {
  accountsEnabled,
  appleSignInAppOrigin,
  appleSignInKeyId,
  appleSignInPrivateKey,
  appleSignInServicesId,
  appleSignInTeamId,
} from "./env";
import { APPLE_NATIVE_AUDIENCE } from "./apple-token";
import { randomSessionToken, sha256Hex } from "./native-session";
import { requireBandUpCloudflareBindings, type BandUpCloudflareBindings } from "@/lib/cloudflare/bindings";

/*
  The web half of Sign in with Apple: sending somebody to Apple, and turning
  what comes back into an identity token this Worker can verify.

  It is lib/auth/google-oauth-server.ts with three differences, and all three
  are Apple's rather than choices made here.

  ---------------------------------------------------------------------------
  The client secret is not a secret

  Google hands you a fixed string and you send it with the code. Apple hands you
  a signing key and you mint a fresh, short-lived JWT for every exchange: ES256,
  `iss` the team id, `sub` the Services ID, `aud` Apple itself, and the key id in
  the header so Apple knows which of your keys to check it against. So the thing
  in the environment is not the credential Apple sees; it is the thing that
  makes the credential Apple sees.

  This is the part of the file most likely to be wrong on a machine other than
  this one, so it is worth saying which way it fails: an ES256 signature is the
  raw 64-byte r‖s pair, and OpenSSL — which is to say Node's `crypto` — produces
  a DER-wrapped one instead, which JWS does not accept. Every Node
  implementation of this therefore carries a DER-to-r‖s converter. Web Crypto
  emits r‖s natively, so there is nothing here to convert and nothing to get
  wrong. Running on Workers is, for once, the easier road.

  ---------------------------------------------------------------------------
  Apple answers with a POST, not a redirect

  Asking for a name or an email address obliges the request to carry
  `response_mode=form_post`, and Apple then returns the authorization by POSTing
  a form to the callback rather than by redirecting to it with a query string.
  The callback route is a POST handler for that reason and only that reason.

  It has a pleasant side effect. The code and the state never appear in a URL at
  all, so they cannot reach an access log, a Referer header or a browser
  history — which is the same property the fragment buys the *outgoing* half of
  this flow, arrived at from the other direction.

  ---------------------------------------------------------------------------
  The name comes once, or never

  Apple sends the learner's name in that form post the very first time they
  authorize this app, in a `user` field that is JSON rather than a claim in the
  token. It is never sent again. Not on the next sign-in, not on request, and
  not after the app is removed and re-added unless the learner first revokes it
  entirely in their Apple ID settings. If it is not captured in that one request
  it is gone for good, so parseAppleUserField below reads it and the callback
  hands it to the identity resolver to store on a profile that has no name yet.
*/

const MODULE = "lib/auth/apple-oauth-server.ts";
const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";

/** Apple's own audience for a client secret — the token endpoint, not BandUp. */
const APPLE_TOKEN_AUDIENCE = "https://appleid.apple.com";

const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;

/**
 * How long a minted client secret is good for.
 *
 * Apple's ceiling is six months, and libraries that mint one at deploy time use
 * most of it. A fresh one per exchange costs a single P-256 signature — tens of
 * microseconds — so there is nothing to buy with a long life and a stale secret
 * sitting in memory to lose by it. Ten minutes is enough for a slow exchange and
 * short enough that a captured one is worthless by the time it is read.
 */
const CLIENT_SECRET_LIFETIME_SECONDS = 10 * 60;

interface AppleOAuthConfig {
  servicesId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  appOrigin: string;
}

interface TransactionRow {
  nonce: string;
  redirect_origin: string;
}

export interface AppleOAuthTokenResponse {
  idToken: string;
}

/** The name Apple sends exactly once, if it sent one at all. */
export interface AppleFirstAuthorizationName {
  givenName: string | null;
  familyName: string | null;
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function config(): AppleOAuthConfig | null {
  assertServerOnly(MODULE);
  const servicesId = appleSignInServicesId();
  const teamId = appleSignInTeamId();
  const keyId = appleSignInKeyId();
  const privateKey = appleSignInPrivateKey();
  const appOrigin = appleSignInAppOrigin();
  return servicesId && teamId && keyId && privateKey && appOrigin
    ? { servicesId, teamId, keyId, privateKey, appOrigin }
    : null;
}

/**
 * True only when this Worker holds every value the web flow needs.
 *
 * The whole of Sign in with Apple hangs off this one answer, and it is false in
 * the deployment this was written for. Nothing anywhere renders an Apple button
 * unless it is true — which is the house rule for a half-configured feature: no
 * button at all beats a button that fails on the first tap, because a learner
 * reads the second as the app being broken rather than as the door not being
 * open yet. Its Google counterpart, googleOAuthServerFlowConfigured, is checked
 * the same way and named on the owner's diagnostics panel for the same reason.
 */
export function appleOAuthServerFlowConfigured(): boolean {
  assertServerOnly(MODULE);
  return accountsEnabled() && config() !== null;
}

/**
 * The audiences an Apple identity token may name and still be ours.
 *
 * Two, and exactly two: the Services ID that identifies the website to Apple,
 * and the bundle id that identifies the app. They are different clients of the
 * same Apple team and Apple addresses each token to whichever asked for it, so
 * a verifier that knew only one of them would reject every sign-in from the
 * other platform. Returns an empty list when nothing is configured, and
 * verifyAppleIdToken refuses everything on an empty list rather than falling
 * back to accepting anything.
 */
export function appleTokenAudiences(): string[] {
  assertServerOnly(MODULE);
  const servicesId = appleSignInServicesId();
  return servicesId ? [servicesId, APPLE_NATIVE_AUDIENCE] : [];
}

/**
 * The .p8 file's contents, as the bytes crypto.subtle wants.
 *
 * Two spellings of the same key have to be read here. A .p8 pasted into a
 * terminal keeps its real line breaks; the same file pasted through a form, a
 * JSON blob or a CI secret editor often arrives with the two characters `\` and
 * `n` where each break was. Both are the same key and both should work, because
 * the alternative is a deployment that fails with a signature Apple rejects and
 * no hint as to why.
 *
 * Whitespace is then discarded wholesale rather than trimmed line by line, so
 * a trailing space or a stray carriage return cannot become a base64 character.
 */
function pkcs8FromPem(pem: string): ArrayBuffer | null {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length < 32) return null;
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch {
    return null;
  }
}

/**
 * Mints the JWT Apple accepts in place of a client secret.
 *
 * Exported so it can be tested against a key generated here rather than against
 * Apple's — nothing about the shape of this token depends on whose key signed
 * it, which is what makes it testable at all without a developer account.
 *
 * Returns null rather than throwing on an unreadable key, so a malformed .p8
 * degrades into "sign-in could not be completed" like every other missing
 * credential instead of a 500 that names the file.
 */
export async function appleClientSecret(
  settings: {
    servicesId: string;
    teamId: string;
    keyId: string;
    privateKey: string;
  },
  now = Date.now(),
): Promise<string | null> {
  assertServerOnly(MODULE);
  const pkcs8 = pkcs8FromPem(settings.privateKey);
  if (!pkcs8) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    return null;
  }

  const issuedAt = Math.floor(now / 1000);
  /*
    `sub` is the Services ID rather than the team id, and this is the one line
    in the file where getting it backwards produces something that looks
    plausible: `iss` names who issued the secret (the team) and `sub` names
    which client it is for. Apple rejects the swap with an
    invalid_client that says nothing about which half was wrong.
  */
  const header = { alg: "ES256", kid: settings.keyId, typ: "JWT" };
  const payload = {
    iss: settings.teamId,
    iat: issuedAt,
    exp: issuedAt + CLIENT_SECRET_LIFETIME_SECONDS,
    aud: APPLE_TOKEN_AUDIENCE,
    sub: settings.servicesId,
  };
  const unsigned = `${encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)))}`
    + `.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;

  let signature: ArrayBuffer;
  try {
    /*
      Web Crypto returns the raw r‖s pair that JWS ES256 is defined in terms of.
      This is the line a Node implementation would have to follow with a DER
      unwrap; see the note at the top of the file.
    */
    signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(unsigned),
    );
  } catch {
    return null;
  }
  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * Starts the Apple handshake with a one-time D1 state, the same shape the
 * Google server flow uses.
 *
 * The state is opaque and high-entropy and only its SHA-256 digest is stored,
 * so a database export cannot be replayed as a pending sign-in. The nonce goes
 * to Apple in the authorize request and comes back inside the signed identity
 * token, which is what ties the token to this one attempt.
 */
export async function startAppleOAuthServerFlow(
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
  // As with Google: the callback address is configuration, never the Host
  // header, because a persisted return address taken from a request is an open
  // redirect with extra steps.
  if (requestOrigin !== settings.appOrigin) return null;

  const state = randomSessionToken(32);
  const nonce = randomSessionToken(32);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await bindings.db.prepare(`
    DELETE FROM app_apple_oauth_transactions
     WHERE expires_at <= ?
  `).bind(stamp(now)).run();
  const stored = await bindings.db.prepare(`
    INSERT INTO app_apple_oauth_transactions (
      state_sha256, nonce, redirect_origin, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    await sha256Hex(state),
    nonce,
    settings.appOrigin,
    stamp(now),
    stamp(now + TRANSACTION_LIFETIME_MS),
  ).run();
  if (!stored.success) throw new Error("Apple OAuth state could not be stored");

  const target = new URL(APPLE_AUTHORIZE_URL);
  target.searchParams.set("client_id", settings.servicesId);
  target.searchParams.set("redirect_uri", appleCallbackUrl(settings.appOrigin));
  target.searchParams.set("response_type", "code");
  /*
    Asking for the name as well as the address, because this request is the only
    one that will ever be answered with it — see the note at the top. Asking for
    a scope at all is what obliges the form_post below; the two go together and
    Apple refuses the combination of a scope with the default response mode.
  */
  target.searchParams.set("scope", "name email");
  target.searchParams.set("response_mode", "form_post");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  return target.toString();
}

/** The one address Apple is registered to return an authorization to. */
export function appleCallbackUrl(appOrigin: string): string {
  return new URL("/api/auth/apple/callback", appOrigin).toString();
}

/**
 * Atomically consumes the one-time state before the code is exchanged, so a
 * replayed form post cannot create a second session.
 */
export async function consumeAppleOAuthState(
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
      FROM app_apple_oauth_transactions
     WHERE state_sha256 = ?
       AND consumed_at IS NULL
       AND expires_at > ?
     LIMIT 1
  `).bind(hash, stamp(now)).first<TransactionRow>();
  if (!row || typeof row.nonce !== "string" || typeof row.redirect_origin !== "string") return null;

  const consumed = await bindings.db.prepare(`
    UPDATE app_apple_oauth_transactions
       SET consumed_at = ?
     WHERE state_sha256 = ?
       AND consumed_at IS NULL
       AND expires_at > ?
  `).bind(stamp(now), hash, stamp(now)).run();
  if (!consumed.success || consumed.meta.changes !== 1) return null;

  const settings = config();
  if (!settings || row.redirect_origin !== settings.appOrigin) return null;
  return { nonce: row.nonce, appOrigin: row.redirect_origin };
}

/**
 * Exchanges Apple's one-time code for the identity token, signing the exchange
 * with a freshly minted client secret.
 *
 * `redirect_uri` is sent again here even though the code already came back to
 * it; Apple checks the two agree, which is what stops a code intercepted at one
 * registered callback being redeemed against another.
 */
export async function exchangeAppleAuthorizationCode(
  code: string,
  appOrigin: string,
  now = Date.now(),
): Promise<AppleOAuthTokenResponse | null> {
  assertServerOnly(MODULE);
  const settings = config();
  if (!settings || appOrigin !== settings.appOrigin || !code || code.length > 4_096) return null;

  const clientSecret = await appleClientSecret(settings, now);
  if (!clientSecret) return null;

  let response: Response;
  try {
    response = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: settings.servicesId,
        client_secret: clientSecret,
        redirect_uri: appleCallbackUrl(settings.appOrigin),
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

/**
 * Reads the name out of the `user` field of Apple's first-authorization form
 * post, and returns nothing rather than throwing on anything unexpected.
 *
 * This is attacker-shaped input in the ordinary sense — it arrives in a form
 * body, it is not covered by the identity token's signature, and it is the one
 * part of this exchange Apple does not vouch for. So it is treated as a display
 * string and nothing more: length-capped, never used to identify anybody, never
 * matched against an existing account. The worst a forged one can do is put a
 * wrong name on a profile whose owner can change it, which is the same power
 * the profile screen already gives them.
 */
export function parseAppleUserField(raw: string | null): AppleFirstAuthorizationName | null {
  if (!raw || raw.length > 4_096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const name = (parsed as { name?: unknown }).name;
  if (!name || typeof name !== "object" || Array.isArray(name)) return null;
  const part = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().slice(0, 60);
    return trimmed.length > 0 ? trimmed : null;
  };
  const givenName = part((name as { firstName?: unknown }).firstName);
  const familyName = part((name as { lastName?: unknown }).lastName);
  return givenName || familyName ? { givenName, familyName } : null;
}

/**
 * The two halves of a name as one display string, in the order most of the
 * world writes them.
 *
 * Wrong for a good part of BandUp's learners, who write the family name first,
 * and knowingly so: Apple gives two labelled fields and no indication of the
 * order they belong in, so any single joining is a guess. This one is a
 * starting value on a field the learner can edit, not a claim about their name,
 * and it is only ever written where there is nothing already.
 */
export function appleDisplayName(name: AppleFirstAuthorizationName | null): string | null {
  if (!name) return null;
  const joined = [name.givenName, name.familyName].filter(Boolean).join(" ").trim();
  return joined.length > 0 ? joined.slice(0, 60) : null;
}

export function appleOAuthCallbackUrl(appOrigin: string, params: Record<string, string>): string {
  const target = new URL("/account/callback/", appOrigin);
  target.hash = new URLSearchParams(params).toString();
  return target.toString();
}
