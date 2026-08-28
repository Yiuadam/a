/*
  The native identity seam is deliberately tested without a real Google or D1
  account. A real provider token is a signed JWT; generating one here proves
  that the Worker verifies the signature and the claims rather than merely
  decoding a base64 payload that anyone could forge.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const nativeSession = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "native-session.ts")).href
);
const google = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "google-token.ts")).href
);

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function jsonPart(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

const GOOGLE_KEY_PAIR = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const GOOGLE_PUBLIC_JWK = await crypto.subtle.exportKey("jwk", GOOGLE_KEY_PAIR.publicKey);
GOOGLE_PUBLIC_JWK.kid = "bandup-test-google-key";
GOOGLE_PUBLIC_JWK.use = "sig";
GOOGLE_PUBLIC_JWK.alg = "RS256";

async function signedGoogleToken(payload) {
  const header = jsonPart({ alg: "RS256", typ: "JWT", kid: GOOGLE_PUBLIC_JWK.kid });
  const body = jsonPart(payload);
  const unsigned = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    GOOGLE_KEY_PAIR.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

test("BandUp-native access tokens are signed, scoped and short-lived", async () => {
  const secret = "a dedicated test session signing secret";
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const created = await nativeSession.createNativeAccessToken(
    { id: "11111111-1111-4111-8111-111111111111", email: "learner@example.test" },
    "session-11111111-1111-4111-8111-111111111111",
    secret,
    now,
  );
  const user = await nativeSession.userFromNativeAccessToken(created.accessToken, secret, now + 5_000);
  assert.deepEqual(user, {
    id: "11111111-1111-4111-8111-111111111111",
    email: "learner@example.test",
    createdAt: null,
  });
  assert.equal(nativeSession.looksLikeNativeAccessToken(created.accessToken), true);
  assert.equal(
    await nativeSession.userFromNativeAccessToken(created.accessToken, "the wrong key", now + 5_000),
    null,
  );
  assert.equal(
    await nativeSession.userFromNativeAccessToken(
      created.accessToken,
      secret,
      created.expiresAt,
    ),
    null,
  );
  const tampered = `${created.accessToken.slice(0, -1)}${created.accessToken.endsWith("a") ? "b" : "a"}`;
  assert.equal(await nativeSession.userFromNativeAccessToken(tampered, secret, now + 5_000), null);
  assert.equal(await nativeSession.userFromNativeAccessToken(created.accessToken, secret, now - 1), null);
});

test("Google credentials require a real Google signature, audience, issuer, expiry and nonce", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://www.googleapis.com/oauth2/v3/certs");
    return Response.json({ keys: [GOOGLE_PUBLIC_JWK] });
  };
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const nonce = "the-browser-only-raw-nonce";
  const payload = {
    iss: "https://accounts.google.com",
    aud: "bandup-google-client.apps.googleusercontent.com",
    sub: "google-user-subject-123",
    email: "Learner@Example.Test",
    email_verified: true,
    exp: Math.floor(now / 1000) + 600,
    nonce: await sha256Hex(nonce),
  };
  try {
    const token = await signedGoogleToken(payload);
    assert.deepEqual(
      await google.verifyGoogleIdToken(token, payload.aud, nonce, now),
      { subject: payload.sub, email: "learner@example.test", emailVerified: true },
    );
    assert.equal(await google.verifyGoogleIdToken(token, "wrong-client", nonce, now), null);
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, "wrong-nonce", now), null);
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now + 601_000), null);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("the identity migration preserves app_users IDs and keeps the native path disabled by default", () => {
  const migration = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0015_cloudflare_identity.sql"), "utf8");
  const production = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");
  const preview = readFileSync(join(process.cwd(), "wrangler.preview.jsonc"), "utf8");
  const session = readFileSync(join(process.cwd(), "lib", "auth", "session.ts"), "utf8");
  const route = readFileSync(join(process.cwd(), "app", "api", "auth", "google", "token", "route.ts"), "utf8");
  const identity = readFileSync(join(process.cwd(), "lib", "cloudflare", "native-identity.ts"), "utf8");
  const deletion = readFileSync(join(process.cwd(), "app", "api", "account", "delete", "route.ts"), "utf8");
  const readiness = readFileSync(join(process.cwd(), "lib", "cloudflare", "native-auth-readiness.ts"), "utf8");
  const audit = readFileSync(join(process.cwd(), "lib", "cloudflare", "native-identity-audit.ts"), "utf8");
  const source = readFileSync(join(process.cwd(), "lib", "auth", "supabase.ts"), "utf8");
  const auditRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "cloudflare", "identity-readiness", "route.ts"), "utf8");
  const accountStatus = readFileSync(join(process.cwd(), "app", "api", "account", "status", "route.ts"), "utf8");
  const cloudflareStatus = readFileSync(join(process.cwd(), "lib", "cloudflare", "account-status.ts"), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_user_identities/);
  assert.match(migration, /REFERENCES app_users\(id\)/);
  assert.doesNotMatch(migration, /UPDATE\s+app_users\s+SET\s+id\s*=/i);
  assert.match(migration, /refresh_token_sha256/);
  assert.match(production, /"CLOUDFLARE_NATIVE_AUTH": "0"/);
  assert.match(preview, /"CLOUDFLARE_NATIVE_AUTH": "0"/);
  assert.match(session, /looksLikeNativeAccessToken/);
  assert.match(route, /verifyGoogleIdToken/);
  assert.match(route, /createGoogleNativeSession/);
  assert.match(identity, /if \(existingEmail\) return null;/);
  assert.match(identity, /await bindings\.db\.batch\(/);
  assert.doesNotMatch(identity, /ON CONFLICT\(provider, provider_subject\) DO NOTHING/);
  assert.match(identity, /userFromNativeBrowserSessionToken/);
  assert.match(identity, /FROM app_auth_sessions[\s\S]*s\.revoked_at IS NULL[\s\S]*u\.deleted_at IS NULL/);
  assert.match(deletion, /isNativeSessionRequest/);
  assert.match(deletion, /if \(!nativeSession && !\(await deleteAccount/);
  assert.match(readiness, /writesToCloudflareOnly\(\) && organizationWritesToCloudflareOnly\(\)/);
  assert.match(readiness, /nativeAuthEnabled\(\) && nativeAuthDataAuthority\(\)\.ready/);
  assert.match(source, /auth\/v1\/admin\/users\?page=\$\{page\}&per_page=/);
  assert.match(source, /identity\.provider !== "google"/);
  assert.match(source, /identity\.provider_id/);
  assert.match(source, /identity\.user_id/);
  assert.match(source, /user\.identities === null/);
  assert.match(source, /admin Auth identity details are unavailable/);
  assert.match(audit, /mappedUserId === identity\.userId/);
  assert.doesNotMatch(audit, /lower\(email\)|identityEmail.*existingEmail/i);
  assert.match(auditRoute, /isAdminEmail\(actor\.email\)/);
  assert.match(auditRoute, /Cache-Control": "private, no-store/);
  assert.match(accountStatus, /domainReadsFromCloudflare\("usage_quota_authority"\)/);
  assert.match(accountStatus, /currentCloudflareAccessGrants/);
  assert.match(cloudflareStatus, /FROM usage_events/);
  assert.match(cloudflareStatus, /FROM subscriptions/);
});
