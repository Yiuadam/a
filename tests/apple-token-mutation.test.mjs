/*
  Mutation-testing follow-up for lib/auth/apple-token.ts.

  tests/apple-signin.test.mjs already proves the shape of a correct sign-in and
  the claim checks a relying party is obliged to make (audience, issuer, nonce,
  expiry). What is missing there — and what a mutation run found — is the
  defensive edge around those checks: the exact length boundaries, the
  fallback values used when a claim is the wrong type, the base64url decoder's
  own guard, and the JWKS lookup's failure paths. Those are covered here,
  against the same kind of RS256 token the existing file signs, so a verifier
  that merely decoded the payload without checking the signature would still
  fail every rejection case below.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const appleToken = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "apple-token.ts")).href
);

const SERVICES_ID = "com.yiuadam.bandup.web";
const BUNDLE_ID = "com.yiuadam.bandup";
const AUDIENCES = [SERVICES_ID, BUNDLE_ID];
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

/** Stands in for https://appleid.apple.com/auth/keys for the length of one call. */
async function withAppleKeys(work, keys = [PUBLIC_JWK]) {
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

/** Signs the exact bytes handed to it — used to sign deliberately malformed parts too. */
async function signRaw(unsigned) {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    KEY_PAIR.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return base64Url(signature);
}

function applePayload(overrides = {}) {
  return {
    iss: "https://appleid.apple.com",
    aud: SERVICES_ID,
    sub: "001234.7f3c9a2b5e6d4f18a0c7.1234",
    iat: NOW_SECONDS - 5,
    exp: NOW_SECONDS + 600,
    nonce: "a-web-flow-nonce",
    email: "learner@example.test",
    email_verified: true,
    is_private_email: false,
    ...overrides,
  };
}

async function signedAppleToken(payload, header = {}) {
  const headerPart = jsonPart({ alg: "RS256", kid: PUBLIC_JWK.kid, ...header });
  const body = jsonPart(payload);
  const unsigned = `${headerPart}.${body}`;
  return `${unsigned}.${await signRaw(unsigned)}`;
}

/** Builds a token from already-encoded parts, signing whatever the caller hands it. */
async function tokenFromParts(headerPart, payloadPart) {
  const unsigned = `${headerPart}.${payloadPart}`;
  return `${unsigned}.${await signRaw(unsigned)}`;
}

async function verify(token, nonce = "a-web-flow-nonce", audiences = AUDIENCES, now = NOW, encoding = "raw") {
  return appleToken.verifyAppleIdToken(token, audiences, nonce, now, encoding);
}

/* --------------------------------------------------------------------------
   assertServerOnly / MODULE
   -------------------------------------------------------------------------- */

test("verifyAppleIdToken refuses to run outside a server component", async () => {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    await assert.rejects(
      () => verify("a.b.c"),
      /lib\/auth\/apple-token\.ts is server-only and must not be imported from a client component\./,
    );
  } finally {
    delete globalThis.window;
  }
});

/* --------------------------------------------------------------------------
   The base64url decoder's own guard (reached through the header, payload and
   signature segments — decodeBase64Url is not exported on its own).

   atob() strips ASCII whitespace before decoding rather than rejecting it, so
   a segment that slips whitespace past the `^[A-Za-z0-9_-]+$` guard decodes
   to exactly the same bytes as the clean segment would. Inserting a multiple
   of four whitespace characters keeps the computed padding count the same as
   the clean content's, so the decode does not fail for an unrelated reason —
   this is what makes the anchors on that regex, and not just its character
   class, worth checking on their own.
   -------------------------------------------------------------------------- */

function insertWhitespace(clean, at) {
  return clean.slice(0, at) + "    " + clean.slice(at);
}

test("a base64url segment carrying whitespace is refused, whichever end it is on", async () => {
  await withAppleKeys(async () => {
    const cleanHeader = jsonPart({ alg: "RS256", kid: PUBLIC_JWK.kid });
    const cleanPayload = jsonPart(applePayload());

    // Leading whitespace: only unanchored-at-the-start matching would accept it.
    const leading = insertWhitespace(cleanHeader, 0);
    assert.equal(await verify(await tokenFromParts(leading, cleanPayload)), null);

    // Trailing whitespace: only unanchored-at-the-end matching would accept it.
    const trailing = insertWhitespace(cleanHeader, cleanHeader.length);
    assert.equal(await verify(await tokenFromParts(trailing, cleanPayload)), null);

    // Embedded whitespace in the payload segment, for good measure — the same
    // guard is shared by every segment the decoder ever sees.
    const embedded = insertWhitespace(cleanPayload, 4);
    assert.equal(await verify(await tokenFromParts(cleanHeader, embedded)), null);

    // The sanity check: the two clean segments really do verify on their own,
    // so the rejections above are the whitespace and nothing else.
    assert.ok(await verify(await tokenFromParts(cleanHeader, cleanPayload)));
  });
});

/* --------------------------------------------------------------------------
   jsonPart's object-shape guard.
   -------------------------------------------------------------------------- */

test("a header or payload that decodes to something other than a plain object is refused", async () => {
  await withAppleKeys(async () => {
    for (const notAnObject of ['"just a string"', "42", "true", "null", "[1,2,3]"]) {
      const headerPart = base64Url(Buffer.from(notAnObject));
      const payloadPart = jsonPart(applePayload());
      assert.equal(
        await verify(await tokenFromParts(headerPart, payloadPart)),
        null,
        `header ${notAnObject} was accepted`,
      );
    }
  });
});

/* --------------------------------------------------------------------------
   verificationKey: the JWKS fetch and the candidate-matching predicate.
   -------------------------------------------------------------------------- */

test("Apple's JWKS is asked for with the long-lived cache Workers is meant to serve from", async () => {
  await withAppleKeys(async (calls) => {
    assert.ok(await verify(await signedAppleToken(applePayload())));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://appleid.apple.com/auth/keys");
    assert.deepEqual(calls[0].init, { cache: "force-cache" });
  });
});

test("a JWKS fetch that fails, or answers with the wrong shape, yields no key", async () => {
  const token = await signedAppleToken(applePayload());
  const savedFetch = globalThis.fetch;
  try {
    // The body is the real, matching key — the only thing wrong with this
    // response is the status. If that were not checked, the otherwise-valid
    // body would still be parsed and the token would verify.
    globalThis.fetch = async () => Response.json({ keys: [PUBLIC_JWK] }, { status: 503 });
    assert.equal(await verify(token), null, "a non-OK JWKS response was accepted");

    globalThis.fetch = async () => new Response("not json", { status: 200 });
    assert.equal(await verify(token), null, "unparsable JSON was accepted");

    globalThis.fetch = async () => Response.json({ keys: "not-an-array" });
    assert.equal(await verify(token), null, "a non-array keys field was accepted");

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await verify(token), null, "a network failure was accepted");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("a JWKS entry that is not a plain object is skipped rather than matched or crashing", async () => {
  const token = await signedAppleToken(applePayload());
  await withAppleKeys(async () => {
    assert.ok(await verify(token), "the real key, listed after junk entries, should still be found");
  }, [null, "not-a-key", 42, true, ["also", "not", "a", "key"], PUBLIC_JWK]);
});

test("a JWKS key is matched on both kid and kty, and either one being wrong is a miss", async () => {
  const token = await signedAppleToken(applePayload());
  for (const wrongKey of [
    { ...PUBLIC_JWK, kid: "some-other-key" },
    { ...PUBLIC_JWK, kty: "EC" },
  ]) {
    await withAppleKeys(async () => {
      assert.equal(await verify(token), null, JSON.stringify(wrongKey));
    }, [wrongKey]);
  }
  // A kid collision on a key that is not actually RSA must not be treated as
  // "close enough" — the algorithm is pinned by kty here and by the header's
  // own `alg` a second time, deliberately redundantly.
  await withAppleKeys(async () => {
    assert.equal(
      await verify(token),
      null,
      "a key sharing the kid but not the kty verified",
    );
  }, [{ ...PUBLIC_JWK, kty: "EC" }]);
});

test("an unimportable JWKS entry — the right shape, the wrong algorithm's fields — yields no key", async () => {
  const token = await signedAppleToken(applePayload());
  await withAppleKeys(async () => {
    assert.equal(await verify(token), null);
  }, [{ ...PUBLIC_JWK, n: "not-valid-base64url-modulus!!" }]);
});

/* --------------------------------------------------------------------------
   The verifyAppleIdToken guard clauses: the audience filter and the
   token/audience/nonce size checks that run before anything is even parsed.
   -------------------------------------------------------------------------- */

test("a blank entry in the caller's own audience list is dropped, not treated as a client of ours", async () => {
  await withAppleKeys(async () => {
    // "" is filtered out of the expected set. If it were not, a token minted
    // with an empty `aud` — never a real Apple client, but not impossible to
    // construct — would verify.
    const emptyAudienceToken = await signedAppleToken(applePayload({ aud: "" }));
    assert.equal(await verify(emptyAudienceToken, "a-web-flow-nonce", [SERVICES_ID, ""]), null);
    // The real client id in the same list still works.
    assert.ok(await verify(await signedAppleToken(applePayload()), "a-web-flow-nonce", [SERVICES_ID, ""]));
  });
});

test("a token longer than 16,384 characters is refused even if it is otherwise perfectly valid", async () => {
  await withAppleKeys(async () => {
    // A harmless padding claim, long enough on its own to push the whole
    // token over the cap.
    const oversized = await signedAppleToken(applePayload({ padding: "x".repeat(17_000) }));
    assert.ok(oversized.length > 16_384);
    assert.equal(await verify(oversized), null);
  });
});

test("a token exactly at the 16,384-character cap is still accepted — the check is a strict '>'", async () => {
  await withAppleKeys(async () => {
    const target = 16_384;
    let padLength = 0;
    let token = await signedAppleToken(applePayload({ padding: "" }));
    // The signature length is fixed for a given key, so one linear correction
    // to the padding claim lands on the exact target length.
    padLength = target - token.length;
    token = await signedAppleToken(applePayload({ padding: "x".repeat(Math.max(0, padLength)) }));
    // Base64 rounds in groups of 4, so nudge padLength until the length is
    // exact rather than assuming the first guess landed precisely.
    for (let guard = 0; token.length !== target && guard < 8; guard += 1) {
      padLength += target - token.length;
      token = await signedAppleToken(applePayload({ padding: "x".repeat(Math.max(0, padLength)) }));
    }
    assert.equal(token.length, target, "could not land the fixture on the exact boundary length");
    assert.ok(await verify(token), "a token at exactly the cap, not over it, was refused");
  });
});

test("an empty raw nonce is refused rather than matched against a token with none of its own", async () => {
  await withAppleKeys(async () => {
    // Without the nonce claim, the token's own nonce falls back to "" too —
    // exactly what an empty rawNonce would coincidentally equal, which is why
    // an empty rawNonce has to be refused before any comparison is made.
    const noNonceToken = await signedAppleToken(applePayload({ nonce: undefined }));
    assert.equal(await verify(noNonceToken, ""), null);
  });
});

test("a token with no nonce claim never verifies, whatever placeholder a broken fallback might use", async () => {
  await withAppleKeys(async () => {
    // A non-string (here: absent) nonce claim has to fall back to a value that
    // cannot coincidentally equal a caller-supplied rawNonce. This pins that
    // fallback to a value nobody would plausibly pass in as their own nonce —
    // not just to the empty string — by supplying that exact, unusual string
    // as the rawNonce and confirming it still does not verify.
    const noNonce = { ...applePayload() };
    delete noNonce.nonce;
    const token = await signedAppleToken(noNonce);
    assert.equal(await verify(token, "Stryker was here!"), null);
  });
});

test("a raw nonce over 256 characters is refused even when it matches the token exactly", async () => {
  await withAppleKeys(async () => {
    const longNonce = "n".repeat(300);
    const token = await signedAppleToken(applePayload({ nonce: longNonce }));
    assert.equal(await verify(token, longNonce), null);
  });
});

test("a raw nonce of exactly 256 characters is accepted — the check is a strict '>'", async () => {
  await withAppleKeys(async () => {
    const boundaryNonce = "n".repeat(256);
    const token = await signedAppleToken(applePayload({ nonce: boundaryNonce }));
    assert.ok(await verify(token, boundaryNonce));
  });
});

test("a token that is not three dot-separated parts is refused", async () => {
  await withAppleKeys(async () => {
    for (const shape of ["", "one-part", "two.parts", "a.b.c.d"]) {
      assert.equal(await verify(shape), null, shape);
    }
    // A fourth, trailing part has to be refused on its own — not merely
    // ignored — even though the first three are a perfectly valid, correctly
    // signed token on their own (destructuring only the first three parts
    // would otherwise quietly accept it).
    const valid = await signedAppleToken(applePayload());
    assert.equal(await verify(`${valid}.trailing-garbage`), null);
  });
});

/* --------------------------------------------------------------------------
   Claim checks: the subject, the nonce type fallback, the length boundaries,
   the clock-skew and max-age fences, and the email fallback and boundary.
   -------------------------------------------------------------------------- */

test("a token with no subject at all is refused rather than defaulting to a placeholder", async () => {
  await withAppleKeys(async () => {
    const noSubject = { ...applePayload() };
    delete noSubject.sub;
    const token = await signedAppleToken(noSubject);
    assert.equal(await verify(token), null);
  });
});

test("a one-character subject is accepted and an empty one is not — the floor is a strict '<'", async () => {
  await withAppleKeys(async () => {
    assert.equal(await verify(await signedAppleToken(applePayload({ sub: "" }))), null);
    assert.ok(await verify(await signedAppleToken(applePayload({ sub: "x" }))));
  });
});

test("a 255-character subject is accepted and a 256-character one is not — the ceiling is a strict '>'", async () => {
  await withAppleKeys(async () => {
    assert.ok(await verify(await signedAppleToken(applePayload({ sub: "x".repeat(255) }))));
    assert.equal(await verify(await signedAppleToken(applePayload({ sub: "x".repeat(256) }))), null);
  });
});

test("a token expiring this very second is already refused, and one second later is accepted", async () => {
  await withAppleKeys(async () => {
    // exp <= now is the rejection, so a token whose expiry is the current
    // second is already stale rather than good for one more instant.
    assert.equal(await verify(await signedAppleToken(applePayload({ exp: NOW_SECONDS }))), null);
    assert.ok(await verify(await signedAppleToken(applePayload({ exp: NOW_SECONDS + 1 }))));
  });
});

test("iat is allowed exactly 120 seconds into the future and refused one second past that", async () => {
  await withAppleKeys(async () => {
    assert.ok(await verify(await signedAppleToken(applePayload({ iat: NOW_SECONDS + 120 }))));
    assert.equal(await verify(await signedAppleToken(applePayload({ iat: NOW_SECONDS + 121 }))), null);
  });
});

test("iat is allowed exactly one hour old and refused one second past that", async () => {
  await withAppleKeys(async () => {
    assert.ok(await verify(await signedAppleToken(applePayload({ iat: NOW_SECONDS - 3_600 }))));
    assert.equal(await verify(await signedAppleToken(applePayload({ iat: NOW_SECONDS - 3_601 }))), null);
  });
});

test("nonce_supported is only ever a rejection when it is literally false", async () => {
  await withAppleKeys(async () => {
    // Every case below keeps the nonce itself matching, so nonce_supported is
    // the only thing that could cause a rejection.
    // Omitted (the ordinary case for every real device) verifies normally.
    assert.ok(await verify(await signedAppleToken(applePayload())));
    // The string "false" is not the boolean false, and must not be treated as one.
    assert.ok(await verify(await signedAppleToken(applePayload({ nonce_supported: "false" }))));
    // Nor is the boolean true a rejection — only literal false is.
    assert.ok(await verify(await signedAppleToken(applePayload({ nonce_supported: true }))));
    // The boolean false is what actually turns a sign-in away.
    assert.equal(
      await verify(await signedAppleToken(applePayload({ nonce_supported: false }))),
      null,
    );
  });
});

test("a present email is trimmed and lower-cased, and a missing one never becomes a placeholder string", async () => {
  await withAppleKeys(async () => {
    const identity = await verify(
      await signedAppleToken(applePayload({ email: "  Learner@Example.TEST  " })),
    );
    assert.equal(identity?.email, "learner@example.test");

    const noEmail = { ...applePayload() };
    delete noEmail.email;
    const identity2 = await verify(await signedAppleToken(noEmail));
    assert.equal(identity2?.subject, "001234.7f3c9a2b5e6d4f18a0c7.1234");
    assert.equal(identity2?.email, null);
    assert.equal(identity2?.emailVerified, false);
  });
});

test("email length is fenced at 3 and 254 characters, both boundaries strict", async () => {
  await withAppleKeys(async () => {
    // 2 characters: too short to be a real address, refused outright by
    // returning a null email rather than the exchange failing — a learner
    // with no address on file is a normal state.
    const twoChar = await verify(await signedAppleToken(applePayload({ email: "a@" })));
    assert.equal(twoChar?.email, null);
    const threeChar = await verify(await signedAppleToken(applePayload({ email: "a@b" })));
    assert.equal(threeChar?.email, "a@b");

    const local = "a".repeat(254 - "@example.test".length);
    const at254 = await verify(await signedAppleToken(applePayload({ email: `${local}@example.test` })));
    assert.equal(at254?.email?.length, 254);
    const at255 = await verify(
      await signedAppleToken(applePayload({ email: `x${local}@example.test` })),
    );
    assert.equal(at255?.email, null);
  });
});

test("emailVerified is only ever true when there is an email to verify", async () => {
  await withAppleKeys(async () => {
    const noEmail = { ...applePayload() };
    delete noEmail.email;
    delete noEmail.email_verified;
    const identity = await verify(await signedAppleToken({ ...noEmail, email_verified: true }));
    // email_verified was asked for, but there is no email for it to describe.
    assert.equal(identity?.email, null);
    assert.equal(identity?.emailVerified, false);
  });
});
