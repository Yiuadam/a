/*
  Mutation-testing follow-up for lib/auth/google-token.ts.

  tests/native-cloudflare-auth.test.mjs and tests/mutation-native-auth-boundaries.test.mjs
  already prove the shape of a correct verification and most of the claim
  boundaries (subject and email length, audience, issuer, expiry, nonce). What
  is missing — and what a mutation run found — is the defensive edge this file
  shares with lib/auth/apple-token.ts: the base64url decoder's own guard, the
  JWKS lookup's failure paths, the fallback values used when a claim is the
  wrong type, and a couple of size boundaries nothing exercises yet.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const googleToken = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "google-token.ts")).href
);

const AUDIENCE = "bandup-web.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function jsonPart(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

const KEY_PAIR = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const PUBLIC_JWK = await crypto.subtle.exportKey("jwk", KEY_PAIR.publicKey);
PUBLIC_JWK.kid = "bandup-mutation-test-key";
PUBLIC_JWK.use = "sig";
PUBLIC_JWK.alg = "RS256";

async function withGoogleKeys(work, keys = [PUBLIC_JWK]) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ keys });
  };
  try {
    return await work(calls);
  } finally {
    globalThis.fetch = saved;
  }
}

async function signRaw(unsigned) {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    KEY_PAIR.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return base64Url(signature);
}

function googlePayload(overrides = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    sub: "google-subject-123",
    email: "learner@example.test",
    email_verified: true,
    exp: NOW_SECONDS + 600,
    nonce: "a-raw-web-nonce",
    ...overrides,
  };
}

async function signedGoogleToken(payload, header = {}) {
  const headerPart = jsonPart({ alg: "RS256", kid: PUBLIC_JWK.kid, ...header });
  const body = jsonPart(payload);
  const unsigned = `${headerPart}.${body}`;
  return `${unsigned}.${await signRaw(unsigned)}`;
}

async function tokenFromParts(headerPart, payloadPart) {
  const unsigned = `${headerPart}.${payloadPart}`;
  return `${unsigned}.${await signRaw(unsigned)}`;
}

async function verify(token, nonce = "a-raw-web-nonce", audience = AUDIENCE, now = NOW, encoding = "raw") {
  return googleToken.verifyGoogleIdToken(token, audience, nonce, now, encoding);
}

/* --------------------------------------------------------------------------
   assertServerOnly / MODULE
   -------------------------------------------------------------------------- */

test("verifyGoogleIdToken refuses to run outside a server component", async () => {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    await assert.rejects(
      () => verify("a.b.c"),
      /lib\/auth\/google-token\.ts is server-only and must not be imported from a client component\./,
    );
  } finally {
    delete globalThis.window;
  }
});

/* --------------------------------------------------------------------------
   The base64url decoder's own guard — see the identical test in
   tests/apple-token-mutation.test.mjs for why exactly four inserted
   whitespace characters is what makes this observable at all.
   -------------------------------------------------------------------------- */

function insertWhitespace(clean, at) {
  return clean.slice(0, at) + "    " + clean.slice(at);
}

test("a base64url segment carrying whitespace is refused, whichever end it is on", async () => {
  await withGoogleKeys(async () => {
    const cleanHeader = jsonPart({ alg: "RS256", kid: PUBLIC_JWK.kid });
    const cleanPayload = jsonPart(googlePayload());

    const leading = insertWhitespace(cleanHeader, 0);
    assert.equal(await verify(await tokenFromParts(leading, cleanPayload)), null);

    const trailing = insertWhitespace(cleanHeader, cleanHeader.length);
    assert.equal(await verify(await tokenFromParts(trailing, cleanPayload)), null);

    assert.ok(await verify(await tokenFromParts(cleanHeader, cleanPayload)));
  });
});

/* --------------------------------------------------------------------------
   verificationKey: the JWKS fetch and the candidate-matching predicate.
   -------------------------------------------------------------------------- */

test("Google's JWKS is asked for with the long-lived cache Workers is meant to serve from", async () => {
  await withGoogleKeys(async (calls) => {
    assert.ok(await verify(await signedGoogleToken(googlePayload())));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.googleapis.com/oauth2/v3/certs");
    assert.deepEqual(calls[0].init, { cache: "force-cache" });
  });
});

test("a JWKS fetch that fails, or answers with the wrong shape, yields no key", async () => {
  const token = await signedGoogleToken(googlePayload());
  const savedFetch = globalThis.fetch;
  try {
    // The body is the real, matching key — the only thing wrong is the
    // status — so bypassing the status check would still find it.
    globalThis.fetch = async () => Response.json({ keys: [PUBLIC_JWK] }, { status: 503 });
    assert.equal(await verify(token), null, "a non-OK JWKS response was accepted");

    globalThis.fetch = async () => new Response("not json", { status: 200 });
    assert.equal(await verify(token), null, "unparsable JSON was accepted");

    globalThis.fetch = async () => Response.json({ keys: "not-an-array" });
    assert.equal(await verify(token), null, "a non-array keys field was accepted");

    // A JSON body that parses cleanly to `null` is a clean parse, not a
    // throw — reading `.keys` off it has to stay optional rather than crash.
    globalThis.fetch = async () => Response.json(null);
    assert.equal(await verify(token), null, "a JSON-null JWKS body crashed instead of failing closed");

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await verify(token), null, "a network failure was accepted");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("a JWKS key is matched on kid, and a kid that is present but wrong is a miss", async () => {
  const token = await signedGoogleToken(googlePayload());
  await withGoogleKeys(async () => {
    assert.equal(await verify(token), null);
  }, [{ ...PUBLIC_JWK, kid: "some-other-key" }]);
});

/* --------------------------------------------------------------------------
   The verifyGoogleIdToken guard clauses.
   -------------------------------------------------------------------------- */

test("a blank entry in the caller's own audience list is dropped, not treated as a client of ours", async () => {
  await withGoogleKeys(async () => {
    const emptyAudienceToken = await signedGoogleToken(googlePayload({ aud: "" }));
    assert.equal(await verify(emptyAudienceToken, "a-raw-web-nonce", [AUDIENCE, ""]), null);
    assert.ok(await verify(await signedGoogleToken(googlePayload()), "a-raw-web-nonce", [AUDIENCE, ""]));
  });
});

test("a single string audience and a one-element array audience behave the same way", async () => {
  await withGoogleKeys(async () => {
    const token = await signedGoogleToken(googlePayload());
    assert.ok(await verify(token, "a-raw-web-nonce", AUDIENCE));
    assert.ok(await verify(token, "a-raw-web-nonce", [AUDIENCE]));
  });
});

test("a token longer than 16,384 characters is refused even if it is otherwise perfectly valid", async () => {
  await withGoogleKeys(async () => {
    const oversized = await signedGoogleToken(googlePayload({ padding: "x".repeat(17_000) }));
    assert.ok(oversized.length > 16_384);
    assert.equal(await verify(oversized), null);
  });
});

test("a token exactly at the 16,384-character cap is still accepted — the check is a strict '>'", async () => {
  await withGoogleKeys(async () => {
    const target = 16_384;
    let padLength = 0;
    let token = await signedGoogleToken(googlePayload({ padding: "" }));
    padLength = target - token.length;
    token = await signedGoogleToken(googlePayload({ padding: "x".repeat(Math.max(0, padLength)) }));
    for (let guard = 0; token.length !== target && guard < 8; guard += 1) {
      padLength += target - token.length;
      token = await signedGoogleToken(googlePayload({ padding: "x".repeat(Math.max(0, padLength)) }));
    }
    assert.equal(token.length, target, "could not land the fixture on the exact boundary length");
    assert.ok(await verify(token));
  });
});

test("an empty raw nonce is refused rather than matched against a token with none of its own", async () => {
  await withGoogleKeys(async () => {
    const noNonceToken = await signedGoogleToken(googlePayload({ nonce: undefined }));
    assert.equal(await verify(noNonceToken, ""), null);
  });
});

test("a token with no nonce claim never verifies, whatever placeholder a broken fallback might use", async () => {
  await withGoogleKeys(async () => {
    const noNonce = { ...googlePayload() };
    delete noNonce.nonce;
    const token = await signedGoogleToken(noNonce);
    assert.equal(await verify(token, "Stryker was here!"), null);
  });
});

test("a raw nonce over 256 characters is refused even when it matches the token exactly", async () => {
  await withGoogleKeys(async () => {
    const longNonce = "n".repeat(300);
    const token = await signedGoogleToken(googlePayload({ nonce: longNonce }));
    assert.equal(await verify(token, longNonce), null);
  });
});

test("a raw nonce of exactly 256 characters is accepted — the check is a strict '>'", async () => {
  await withGoogleKeys(async () => {
    const boundaryNonce = "n".repeat(256);
    const token = await signedGoogleToken(googlePayload({ nonce: boundaryNonce }));
    assert.ok(await verify(token, boundaryNonce));
  });
});

test("a token that is not three dot-separated parts is refused", async () => {
  await withGoogleKeys(async () => {
    for (const shape of ["", "one-part", "two.parts", "a.b.c.d"]) {
      assert.equal(await verify(shape), null, shape);
    }
    const valid = await signedGoogleToken(googlePayload());
    assert.equal(await verify(`${valid}.trailing-garbage`), null);
  });
});

test("an algorithm other than RS256 is refused even when the signature is genuinely valid", async () => {
  // Signed for real with the RSA key, but the header claims a different
  // algorithm — the classic algorithm-confusion shape. The signature check
  // alone cannot catch this, because it verifies whatever bytes were signed
  // regardless of what the header says they mean.
  await withGoogleKeys(async () => {
    const token = await signedGoogleToken(googlePayload(), { alg: "HS256" });
    assert.equal(await verify(token), null);
  });
});

test("a forged payload under a genuine signature is refused", async () => {
  await withGoogleKeys(async () => {
    const token = await signedGoogleToken(googlePayload());
    const [header, , signature] = token.split(".");
    const forged = [header, jsonPart(googlePayload({ sub: "somebody-elses-subject" })), signature].join(".");
    assert.equal(await verify(forged), null);
  });
});

/* --------------------------------------------------------------------------
   Claim fallbacks: the subject, email and nonce placeholders used when a
   claim is the wrong type, and the email trim.
   -------------------------------------------------------------------------- */

test("a token with no subject at all is refused rather than defaulting to a placeholder", async () => {
  await withGoogleKeys(async () => {
    const noSubject = { ...googlePayload() };
    delete noSubject.sub;
    assert.equal(await verify(await signedGoogleToken(noSubject)), null);
  });
});

test("a token with no email at all is refused rather than defaulting to a placeholder", async () => {
  await withGoogleKeys(async () => {
    const noEmail = { ...googlePayload() };
    delete noEmail.email;
    assert.equal(await verify(await signedGoogleToken(noEmail)), null);
  });
});

test("a present email is trimmed and lower-cased", async () => {
  await withGoogleKeys(async () => {
    const identity = await verify(await signedGoogleToken(googlePayload({ email: "  Learner@Example.TEST  " })));
    assert.equal(identity?.email, "learner@example.test");
  });
});
