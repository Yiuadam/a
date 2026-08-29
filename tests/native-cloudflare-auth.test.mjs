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

async function signedNativeToken(payload, secret, header = { alg: "HS256", typ: "JWT" }) {
  const headerPart = jsonPart(header);
  const body = jsonPart(payload);
  const unsigned = `${headerPart}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(signature)}`;
}

function nativePayload(now, overrides = {}) {
  const issuedAt = Math.floor(now / 1000);
  return {
    iss: "bandup.cloudflare",
    aud: "bandup-api",
    sub: "11111111-1111-4111-8111-111111111111",
    email: "learner@example.test",
    sid: "session-11111111-1111-4111-8111-111111111111",
    iat: issuedAt,
    exp: issuedAt + nativeSession.ACCESS_TOKEN_SECONDS,
    ...overrides,
  };
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

test("native session rejects malformed headers and every invalid signed claim", async () => {
  const secret = "a dedicated test session signing secret";
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const invalidClaims = [
    { iss: "someone-else" },
    { aud: "another-api" },
    { sub: "too-short" },
    { sub: 42 },
    { sub: "a".repeat(81) },
    { email: 42 },
    { sid: "too-short" },
    { sid: 42 },
    { iat: Math.floor(now / 1000) + 0.5 },
    { exp: Math.floor(now / 1000) + 0.5 },
    { exp: Math.floor(now / 1000) },
  ];

  for (const overrides of invalidClaims) {
    const token = await signedNativeToken(nativePayload(now, overrides), secret);
    assert.equal(await nativeSession.verifyNativeAccessToken(token, secret, now + 1), null, JSON.stringify(overrides));
  }

  for (const header of [{ alg: "none", typ: "JWT" }, { alg: "HS256", typ: "not-a-jwt" }]) {
    const token = await signedNativeToken(nativePayload(now), secret, header);
    assert.equal(await nativeSession.verifyNativeAccessToken(token, secret, now + 1), null, JSON.stringify(header));
  }

  assert.equal(await nativeSession.verifyNativeAccessToken("", secret, now), null);
  assert.equal(await nativeSession.verifyNativeAccessToken("header.payload", secret, now), null);
  assert.equal(await nativeSession.verifyNativeAccessToken("not-base64.payload.signature", secret, now), null);
  assert.equal(await nativeSession.verifyNativeAccessToken("a".repeat(4097), secret, now), null);
  assert.equal(nativeSession.looksLikeNativeAccessToken("not-a-token"), false);
  assert.match(nativeSession.randomSessionToken(12), /^[A-Za-z0-9_-]{16}$/);
  assert.equal(await nativeSession.sha256Hex("BandUp"), "83337a9ccf5b0b83163f1795e2a9101c04d56867afcbddcc720ec04e18ac348e");
});

test("native session accepts externally signed boundary claims and rejects an unscoped token", async () => {
  const secret = "a dedicated test session signing secret";
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const boundary = nativePayload(now, {
    sub: "u".repeat(16),
    sid: "s".repeat(16),
    email: null,
  });
  const minimum = await signedNativeToken(boundary, secret);
  assert.deepEqual(await nativeSession.verifyNativeAccessToken(minimum, secret, now), {
    user: { id: boundary.sub, email: null, createdAt: null },
    sessionId: boundary.sid,
    expiresAt: boundary.exp * 1000,
  });

  const maximum = nativePayload(now, { sub: "u".repeat(80) });
  assert.equal((await nativeSession.verifyNativeAccessToken(
    await signedNativeToken(maximum, secret),
    secret,
    now,
  ))?.user.id, maximum.sub);

  const equalTimes = nativePayload(now, { exp: Math.floor(now / 1000) });
  assert.equal(await nativeSession.verifyNativeAccessToken(
    await signedNativeToken(equalTimes, secret),
    now,
  ), null);
  assert.equal(nativeSession.looksLikeNativeAccessToken(
    `header.${jsonPart({ iss: "bandup.cloudflare", aud: "somewhere-else" })}.signature`,
  ), false);
  assert.notEqual(nativeSession.randomSessionToken(12), nativeSession.randomSessionToken(12));
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

    const invalidClaims = [
      { sub: "" },
      { sub: "a".repeat(256) },
      { email: "x" },
      { email: "a".repeat(250) + "@example.test" },
      { email_verified: false },
      { aud: "another-client" },
      { iss: "not-google" },
      { exp: Math.floor(now / 1000) },
      { nonce: "not-the-right-nonce" },
    ];
    for (const overrides of invalidClaims) {
      const invalid = await signedGoogleToken({ ...payload, ...overrides });
      assert.equal(await google.verifyGoogleIdToken(invalid, payload.aud, nonce, now), null, JSON.stringify(overrides));
    }

    const wrongHeader = `${jsonPart({ alg: "none", typ: "JWT", kid: GOOGLE_PUBLIC_JWK.kid })}.${token.split(".")[1]}.${token.split(".")[2]}`;
    assert.equal(await google.verifyGoogleIdToken(wrongHeader, payload.aud, nonce, now), null);
    assert.equal(await google.verifyGoogleIdToken("", payload.aud, nonce, now), null);
    assert.equal(await google.verifyGoogleIdToken("a.b.c", payload.aud, nonce, now), null);
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), null);
    assert.equal(await google.verifyGoogleIdToken(token, "", nonce, now), null);
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, "", now), null);
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, "n".repeat(257), now), null);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("Google identity verification fails closed when key discovery is malformed or untrusted", async () => {
  const savedFetch = globalThis.fetch;
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const nonce = "the-browser-only-raw-nonce";
  const payload = {
    iss: "accounts.google.com",
    aud: "bandup-google-client.apps.googleusercontent.com",
    sub: "google-user-subject-123",
    email: "learner@example.test",
    email_verified: "true",
    exp: Math.floor(now / 1000) + 600,
    nonce: nonce,
  };
  const token = await signedGoogleToken(payload);
  const invalidKeys = [
    { ...GOOGLE_PUBLIC_JWK, kid: "another-key" },
    { ...GOOGLE_PUBLIC_JWK, kty: "EC" },
    { ...GOOGLE_PUBLIC_JWK, alg: "ES256" },
    { ...GOOGLE_PUBLIC_JWK, use: "enc" },
  ];
  try {
    for (const key of invalidKeys) {
      globalThis.fetch = async () => Response.json({ keys: [key] });
      assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), null);
    }
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), null);
    globalThis.fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), null);
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), null);
    globalThis.fetch = async () => Response.json({ keys: {} });
    assert.equal(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), null);
    globalThis.fetch = async () => Response.json({ keys: [GOOGLE_PUBLIC_JWK] });
    assert.deepEqual(await google.verifyGoogleIdToken(token, payload.aud, nonce, now, "raw"), {
      subject: payload.sub,
      email: payload.email,
      emailVerified: true,
    });

    const shortSubject = { ...payload, sub: "x" };
    const longSubject = { ...payload, sub: "x".repeat(255) };
    const shortEmail = { ...payload, email: "a@b" };
    const longEmail = { ...payload, email: `${"a".repeat(241)}@example.test` };
    for (const boundary of [shortSubject, longSubject, shortEmail, longEmail]) {
      const boundaryToken = await signedGoogleToken(boundary);
      assert.equal((await google.verifyGoogleIdToken(boundaryToken, payload.aud, nonce, now, "raw"))?.subject, boundary.sub);
    }
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
  const identityCard = readFileSync(join(process.cwd(), "components", "admin", "CloudflareIdentityReadiness.tsx"), "utf8");
  const passwordProofMigration = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0021_native_password_migration_proof.sql"), "utf8");
  const passwordProofRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "cloudflare", "password-import", "proof", "route.ts"), "utf8");
  const capabilityImportRoute = readFileSync(join(process.cwd(), "app", "api", "internal", "native-password-source-import", "route.ts"), "utf8");

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
  assert.match(source, /listSupabaseAuthProviderSummary/);
  assert.match(source, /identity\.user_id/);
  assert.match(source, /user\.identities === null/);
  assert.match(source, /admin Auth identity details are unavailable/);
  assert.match(audit, /mappedUserId === identity\.userId/);
  assert.doesNotMatch(audit, /lower\(email\)|identityEmail.*existingEmail/i);
  assert.match(auditRoute, /isAdminEmail\(actor\.email\)/);
  assert.match(auditRoute, /Cache-Control": "private, no-store/);
  assert.match(identityCard, /Cloudflare account identity/);
  assert.match(identityCard, /Copy audited Google mappings/);
  assert.match(identityCard, /readyForNativeAuthCutover/);
  assert.match(identityCard, /No native sign-in setting was changed/);
  assert.match(passwordProofMigration, /native_password_migration_proofs/);
  assert.match(passwordProofMigration, /migration_source/);
  assert.match(passwordProofRoute, /body\.confirm !== true/);
  assert.match(capabilityImportRoute, /NATIVE_PASSWORD_IMPORT_CAPABILITY/);
  assert.match(capabilityImportRoute, /importNativePasswordCredentialBatch/);
  assert.match(capabilityImportRoute, /certifyNativePasswordMigration/);
  assert.match(capabilityImportRoute, /nativeIdentityReadinessReport/);
  assert.match(capabilityImportRoute, /backfillNativeGoogleIdentities/);
  assert.match(capabilityImportRoute, /cloudflareMigrationReadinessReport/);
  assert.match(capabilityImportRoute, /stripeCutoverReadinessReport/);
  assert.match(capabilityImportRoute, /operation === "billing_audit"/);
  assert.match(capabilityImportRoute, /operation === "application_drift"/);
  assert.match(capabilityImportRoute, /cloudflareDomainDriftReport/);
  assert.match(capabilityImportRoute, /cloudflarePayloadParityReport/);
  assert.match(capabilityImportRoute, /operation === "identity_backfill"/);
  assert.doesNotMatch(capabilityImportRoute, /console\.log|logInternal/);
  assert.match(passwordProofRoute, /isAdminEmail\(actor\.email\)/);
  assert.match(passwordProofRoute, /Cache-Control": "private, no-store/);
  assert.doesNotMatch(passwordProofRoute, /console\.log|logInternal/);
  assert.match(accountStatus, /domainReadsFromCloudflare\("usage_quota_authority"\)/);
  assert.match(accountStatus, /currentCloudflareAccessGrants/);
  assert.match(cloudflareStatus, /FROM usage_events/);
  assert.match(cloudflareStatus, /FROM subscriptions/);
});
