/*
  Local-only native-auth boundaries used by scripts/mutation-test.mjs.  The
  Google key is generated in-process and fetch is replaced, so no provider or
  account credential is contacted.
*/
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const nativeSession = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "native-session.ts")).href,
);
const google = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "google-token.ts")).href,
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

const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
publicJwk.kid = "bandup-mutation-test-key";
publicJwk.use = "sig";
publicJwk.alg = "RS256";

async function signedGoogleToken(payload) {
  const header = jsonPart({ alg: "RS256", typ: "JWT", kid: publicJwk.kid });
  const body = jsonPart(payload);
  const unsigned = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

test("native sessions require a verified signature, valid claims and exact expiry handling", async () => {
  const secret = "a dedicated local-only mutation-test signing secret";
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const created = await nativeSession.createNativeAccessToken(
    { id: "11111111-1111-4111-8111-111111111111", email: "learner@example.test" },
    "session-11111111-1111-4111-8111-111111111111",
    secret,
    now,
  );
  assert.ok(await nativeSession.userFromNativeAccessToken(created.accessToken, secret, now + 1));
  assert.equal(await nativeSession.userFromNativeAccessToken(created.accessToken, "wrong secret", now + 1), null);
  assert.equal(await nativeSession.userFromNativeAccessToken(created.accessToken, secret, created.expiresAt), null);
  assert.equal(await nativeSession.userFromNativeAccessToken(created.accessToken, secret, now - 1), null);
  assert.equal(
    nativeSession.looksLikeNativeAccessToken(
      `${jsonPart({ alg: "HS256", typ: "JWT" })}.${jsonPart({ iss: "not-bandup", aud: "bandup-api" })}.signature`,
    ),
    false,
  );
});

test("Google ID tokens require audience, issuer, nonce and strictly future expiry", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://www.googleapis.com/oauth2/v3/certs");
    return Response.json({ keys: [publicJwk] });
  };
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const nonce = "local-only-raw-nonce";
  const audience = "bandup-google-client.apps.googleusercontent.com";
  const payload = {
    iss: "https://accounts.google.com",
    aud: audience,
    sub: "google-subject-123",
    email: "Learner@Example.Test",
    email_verified: true,
    exp: Math.floor(now / 1000) + 600,
    nonce: await sha256Hex(nonce),
  };
  try {
    assert.ok(await google.verifyGoogleIdToken(await signedGoogleToken(payload), audience, nonce, now));
    assert.equal(await google.verifyGoogleIdToken(await signedGoogleToken(payload), "wrong-client", nonce, now), null);
    assert.equal(
      await google.verifyGoogleIdToken(
        await signedGoogleToken({ ...payload, iss: "https://untrusted-issuer.example.test" }),
        audience,
        nonce,
        now,
      ),
      null,
    );
    assert.equal(await google.verifyGoogleIdToken(await signedGoogleToken(payload), audience, "wrong-nonce", now), null);
    assert.equal(
      await google.verifyGoogleIdToken(
        await signedGoogleToken({ ...payload, exp: Math.floor(now / 1000) }),
        audience,
        nonce,
        now,
      ),
      null,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});
