/*
  Sign in with Apple, tested without Apple.

  There is no way to exercise this end to end: every credential it needs comes
  with a paid Apple Developer Program membership, and there is none. So what is
  proved here is everything that does not require Apple's cooperation, which is
  more than it sounds — a real identity token is an RS256 JWT, and one signed by
  a key generated in this file is indistinguishable from Apple's to any verifier
  that is actually checking the signature. A verifier that merely base64-decoded
  the payload would pass the happy path below and fail every rejection after it.

  What is deliberately NOT proved, and cannot be: that Apple's authorize
  endpoint accepts the request built here, that Apple's token endpoint accepts
  the client secret minted here, and that a real Apple response carries the
  claims in the shapes this expects. Those are first-contact risks and they stay
  open until somebody signs in.
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

const appleToken = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "apple-token.ts")).href
);
const appleOAuth = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "apple-oauth-server.ts")).href
);

const SERVICES_ID = "com.yiuadam.bandup.web";
const BUNDLE_ID = "com.yiuadam.bandup";
const AUDIENCES = [SERVICES_ID, BUNDLE_ID];

function read(...parts) {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

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

const APPLE_KEY_PAIR = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const APPLE_PUBLIC_JWK = await crypto.subtle.exportKey("jwk", APPLE_KEY_PAIR.publicKey);
APPLE_PUBLIC_JWK.kid = "bandup-test-apple-key";
APPLE_PUBLIC_JWK.use = "sig";
APPLE_PUBLIC_JWK.alg = "RS256";

/** Stands in for https://appleid.apple.com/auth/keys for the length of one call. */
async function withAppleKeys(work, keys = [APPLE_PUBLIC_JWK]) {
  const saved = globalThis.fetch;
  let asked = null;
  globalThis.fetch = async (url) => {
    asked = String(url);
    return Response.json({ keys });
  };
  try {
    return await work(() => asked);
  } finally {
    globalThis.fetch = saved;
  }
}

async function signedAppleToken(payload, header = {}) {
  const headerPart = jsonPart({
    alg: "RS256",
    kid: APPLE_PUBLIC_JWK.kid,
    ...header,
  });
  const body = jsonPart(payload);
  const unsigned = `${headerPart}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    APPLE_KEY_PAIR.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);

function applePayload(overrides = {}) {
  return {
    iss: "https://appleid.apple.com",
    aud: SERVICES_ID,
    sub: "001234.7f3c9a2b5e6d4f18a0c7.1234",
    iat: NOW_SECONDS - 5,
    exp: NOW_SECONDS + 600,
    nonce: "a-web-flow-nonce",
    email: "Learner@Example.test",
    email_verified: "true",
    is_private_email: "false",
    ...overrides,
  };
}

test("a correctly signed Apple token yields the subject, and the subject is not the email", async () => {
  await withAppleKeys(async (asked) => {
    const token = await signedAppleToken(applePayload());
    const identity = await appleToken.verifyAppleIdToken(
      token,
      AUDIENCES,
      "a-web-flow-nonce",
      NOW,
      "raw",
    );
    assert.deepEqual(identity, {
      subject: "001234.7f3c9a2b5e6d4f18a0c7.1234",
      // Normalised the way every other address in the app is.
      email: "learner@example.test",
      emailVerified: true,
      isPrivateEmail: false,
    });
    // The key came from Apple, never from the token.
    assert.equal(asked(), "https://appleid.apple.com/auth/keys");
  });
});

test("the bundle id is accepted as an audience alongside the Services ID", async () => {
  await withAppleKeys(async () => {
    const token = await signedAppleToken(applePayload({ aud: BUNDLE_ID }));
    const identity = await appleToken.verifyAppleIdToken(
      token,
      AUDIENCES,
      "a-web-flow-nonce",
      NOW,
      "raw",
    );
    assert.equal(identity?.subject, "001234.7f3c9a2b5e6d4f18a0c7.1234");
  });
});

test("a token addressed to somebody else's client is refused", async () => {
  await withAppleKeys(async () => {
    for (const aud of [
      "com.someone.else",
      // Ours *and* somebody else's is not ours.
      [SERVICES_ID, "com.someone.else"],
      [],
      null,
      12,
    ]) {
      const token = await signedAppleToken(applePayload({ aud }));
      assert.equal(
        await appleToken.verifyAppleIdToken(token, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
        null,
        `audience ${JSON.stringify(aud)} was accepted`,
      );
    }
    // An array of exactly our own is still ours.
    const single = await signedAppleToken(applePayload({ aud: [BUNDLE_ID] }));
    assert.ok(await appleToken.verifyAppleIdToken(single, AUDIENCES, "a-web-flow-nonce", NOW, "raw"));
  });
});

test("verification is refused with no audience to check against", async () => {
  await withAppleKeys(async () => {
    const token = await signedAppleToken(applePayload());
    // An unconfigured deployment must reject everything rather than everything.
    assert.equal(
      await appleToken.verifyAppleIdToken(token, [], "a-web-flow-nonce", NOW, "raw"),
      null,
    );
  });
});

test("the signature is actually checked", async () => {
  await withAppleKeys(async () => {
    const token = await signedAppleToken(applePayload());
    const [header, , signature] = token.split(".");
    // Same signature, a payload naming somebody else.
    const forged = [header, jsonPart(applePayload({ sub: "somebody.else" })), signature].join(".");
    assert.equal(
      await appleToken.verifyAppleIdToken(forged, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
      null,
    );
  });
});

test("a key the token names but Apple does not publish is refused", async () => {
  const foreign = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const foreignJwk = await crypto.subtle.exportKey("jwk", foreign.publicKey);
  foreignJwk.kid = "not-apples-key";
  const headerPart = jsonPart({ alg: "RS256", kid: "not-apples-key" });
  const body = jsonPart(applePayload());
  const unsigned = `${headerPart}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    foreign.privateKey,
    new TextEncoder().encode(unsigned),
  );
  const token = `${unsigned}.${base64Url(signature)}`;

  // Apple's key set does not contain it, so there is nothing to verify against
  // — and the key travelling with the token is never even looked at.
  await withAppleKeys(async () => {
    assert.equal(
      await appleToken.verifyAppleIdToken(token, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
      null,
    );
  });
});

test("issuer, expiry, issue time and algorithm are all refused when wrong", async () => {
  await withAppleKeys(async () => {
    const cases = [
      ["a different issuer", applePayload({ iss: "https://appleid.apple.com.evil.test" }), {}],
      ["an issuer without its scheme", applePayload({ iss: "appleid.apple.com" }), {}],
      ["an expired token", applePayload({ exp: NOW_SECONDS - 1 }), {}],
      ["a missing expiry", applePayload({ exp: undefined }), {}],
      ["an issue time from the future", applePayload({ iat: NOW_SECONDS + 3_600 }), {}],
      ["an issue time from last week", applePayload({ iat: NOW_SECONDS - 7 * 86_400 }), {}],
      ["a missing issue time", applePayload({ iat: undefined }), {}],
      ["an unsigned token", applePayload(), { alg: "none" }],
      ["a symmetric algorithm", applePayload(), { alg: "HS256" }],
    ];
    for (const [what, payload, header] of cases) {
      const token = await signedAppleToken(payload, header);
      assert.equal(
        await appleToken.verifyAppleIdToken(token, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
        null,
        `${what} was accepted`,
      );
    }
  });
});

test("the nonce is checked, raw for the web flow and hashed for the native one", async () => {
  await withAppleKeys(async () => {
    const raw = "a-native-flow-nonce";
    const hashed = await sha256Hex(raw);

    // The native device hashes before sending, so the token carries the digest.
    const nativeToken = await signedAppleToken(applePayload({ aud: BUNDLE_ID, nonce: hashed }));
    assert.ok(await appleToken.verifyAppleIdToken(nativeToken, AUDIENCES, raw, NOW, "sha256"));
    // ...and the same token read as a raw-nonce flow does not verify.
    assert.equal(await appleToken.verifyAppleIdToken(nativeToken, AUDIENCES, raw, NOW, "raw"), null);

    // A token minted for a different attempt cannot be replayed into this one.
    const other = await signedAppleToken(applePayload({ nonce: "somebody-elses-nonce" }));
    assert.equal(
      await appleToken.verifyAppleIdToken(other, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
      null,
    );

    // A token with no nonce at all is not a token this app asked for.
    const none = await signedAppleToken(applePayload({ nonce: undefined }));
    assert.equal(
      await appleToken.verifyAppleIdToken(none, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
      null,
    );

    // Nor is one from a client old enough to say it cannot do nonces.
    const unsupported = await signedAppleToken(
      applePayload({ nonce: undefined, nonce_supported: false }),
    );
    assert.equal(
      await appleToken.verifyAppleIdToken(unsupported, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
      null,
    );
  });
});

test("a hidden address is carried through as a Private Relay address, and an absent one as null", async () => {
  await withAppleKeys(async () => {
    const relayed = await signedAppleToken(applePayload({
      email: "abc123xyz@privaterelay.appleid.com",
      is_private_email: true,
      email_verified: true,
    }));
    assert.deepEqual(
      await appleToken.verifyAppleIdToken(relayed, AUDIENCES, "a-web-flow-nonce", NOW, "raw"),
      {
        subject: "001234.7f3c9a2b5e6d4f18a0c7.1234",
        email: "abc123xyz@privaterelay.appleid.com",
        emailVerified: true,
        isPrivateEmail: true,
      },
    );

    // No address is a state the account has to survive, not a failure.
    const anonymous = await signedAppleToken(applePayload({
      email: undefined,
      email_verified: undefined,
      is_private_email: undefined,
    }));
    const identity = await appleToken.verifyAppleIdToken(
      anonymous,
      AUDIENCES,
      "a-web-flow-nonce",
      NOW,
      "raw",
    );
    assert.equal(identity?.subject, "001234.7f3c9a2b5e6d4f18a0c7.1234");
    assert.equal(identity?.email, null);
    assert.equal(identity?.emailVerified, false);
  });
});

/* --------------------------------------------------------------------------
   The client secret Apple wants in place of a static one.
   -------------------------------------------------------------------------- */

const SIGNING_KEY_PAIR = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const PKCS8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", SIGNING_KEY_PAIR.privateKey));

function pem(body, lineBreak = "\n") {
  const base64 = body.toString("base64").replace(/(.{64})/g, `$1${lineBreak}`);
  return `-----BEGIN PRIVATE KEY-----${lineBreak}${base64}${lineBreak}-----END PRIVATE KEY-----${lineBreak}`;
}

const CLIENT_SECRET_SETTINGS = {
  servicesId: SERVICES_ID,
  teamId: "ABCDE12345",
  keyId: "KEY1234567",
  privateKey: pem(PKCS8),
};

test("the client secret is an ES256 JWT Apple's own rules would accept", async () => {
  const secret = await appleOAuth.appleClientSecret(CLIENT_SECRET_SETTINGS, NOW);
  assert.ok(secret, "no client secret was minted");
  const [headerPart, payloadPart, signaturePart] = secret.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));

  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEY1234567", "Apple picks the key by the header's kid");
  // iss is the team and sub is the client. Swapping them is the plausible-looking
  // mistake, and Apple's only answer to it is an unexplained invalid_client.
  assert.equal(payload.iss, "ABCDE12345");
  assert.equal(payload.sub, SERVICES_ID);
  assert.equal(payload.aud, "https://appleid.apple.com");
  assert.equal(payload.iat, NOW_SECONDS);
  assert.ok(payload.exp > NOW_SECONDS, "already expired when minted");
  // Apple's documented ceiling is six months from issue.
  assert.ok(payload.exp - payload.iat <= 15_777_000, "longer-lived than Apple permits");

  /*
    And it verifies. This is the assertion that would fail on a Node-style
    implementation that emitted a DER signature: the bytes would decode, the
    claims would read correctly, and Apple would reject it.
  */
  const signature = Buffer.from(signaturePart, "base64url");
  assert.equal(signature.length, 64, "an ES256 signature is a raw 64-byte r‖s pair");
  assert.equal(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      SIGNING_KEY_PAIR.publicKey,
      signature,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    ),
    true,
  );
});

test("a .p8 whose newlines were flattened into backslash-n still signs", async () => {
  const flattened = pem(PKCS8, "\\n");
  assert.ok(flattened.includes("\\n"), "the fixture is not actually flattened");
  const secret = await appleOAuth.appleClientSecret(
    { ...CLIENT_SECRET_SETTINGS, privateKey: flattened },
    NOW,
  );
  assert.ok(secret, "a flattened .p8 was refused");
});

test("an unreadable key is a null rather than a thrown error", async () => {
  for (const privateKey of ["", "not a key at all", "-----BEGIN PRIVATE KEY-----\nzzzz\n-----END PRIVATE KEY-----"]) {
    assert.equal(
      await appleOAuth.appleClientSecret({ ...CLIENT_SECRET_SETTINGS, privateKey }, NOW),
      null,
    );
  }
});

/* --------------------------------------------------------------------------
   The web flow's one-time state, against a D1 that only remembers.
   -------------------------------------------------------------------------- */

async function withEnv(values, work) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeBindings() {
  const rows = new Map();
  return {
    db: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                if (sql.includes("DELETE FROM app_apple_oauth_transactions")) {
                  return { success: true, meta: { changes: 0 } };
                }
                if (sql.includes("INSERT INTO app_apple_oauth_transactions")) {
                  rows.set(values[0], {
                    nonce: values[1],
                    redirect_origin: values[2],
                    expires_at: values[4],
                    consumed_at: null,
                  });
                  return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes("UPDATE app_apple_oauth_transactions")) {
                  const row = rows.get(values[1]);
                  if (!row || row.consumed_at !== null || row.expires_at <= values[2]) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  row.consumed_at = values[0];
                  return { success: true, meta: { changes: 1 } };
                }
                throw new Error("unexpected D1 write");
              },
              async first() {
                if (sql.includes("FROM app_apple_oauth_transactions")) {
                  const row = rows.get(values[0]);
                  return row && row.consumed_at === null && row.expires_at > values[1]
                    ? { nonce: row.nonce, redirect_origin: row.redirect_origin }
                    : null;
                }
                throw new Error("unexpected D1 read");
              },
            };
          },
        };
      },
    },
    files: {},
  };
}

const APPLE_ENV = {
  ACCOUNTS_ENABLED: "1",
  APPLE_SIGNIN_SERVICES_ID: SERVICES_ID,
  APPLE_SIGNIN_TEAM_ID: "ABCDE12345",
  APPLE_SIGNIN_KEY_ID: "KEY1234567",
  APPLE_SIGNIN_PRIVATE_KEY: pem(PKCS8),
  APPLE_SIGNIN_APP_ORIGIN: "https://bandup.example.test",
};

test("the Apple authorize request asks for a form post and a one-time state", async () => {
  await withEnv(APPLE_ENV, async () => {
    const bindings = fakeBindings();
    const start = await appleOAuth.startAppleOAuthServerFlow(
      new Request("https://bandup.example.test/api/auth/apple/start"),
      bindings,
      NOW,
    );
    assert.ok(start);
    const url = new URL(start);
    assert.equal(url.origin, "https://appleid.apple.com");
    assert.equal(url.pathname, "/auth/authorize");
    assert.equal(url.searchParams.get("client_id"), SERVICES_ID);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://bandup.example.test/api/auth/apple/callback",
    );
    assert.equal(url.searchParams.get("response_type"), "code");
    // Asking for a scope obliges the form post; the pair is not optional.
    assert.equal(url.searchParams.get("scope"), "name email");
    assert.equal(url.searchParams.get("response_mode"), "form_post");
    assert.ok(url.searchParams.get("nonce"));

    const state = url.searchParams.get("state");
    assert.ok(state);
    const consumed = await appleOAuth.consumeAppleOAuthState(state, bindings, NOW + 1_000);
    assert.equal(consumed?.appOrigin, "https://bandup.example.test");
    assert.equal(consumed?.nonce, url.searchParams.get("nonce"));
    // Once, and only once — a replayed form post gets nothing.
    assert.equal(await appleOAuth.consumeAppleOAuthState(state, bindings, NOW + 2_000), null);
  });
});

test("the callback origin is configuration and never the request's own host", async () => {
  await withEnv(APPLE_ENV, async () => {
    assert.equal(
      await appleOAuth.startAppleOAuthServerFlow(
        new Request("https://untrusted.example.test/api/auth/apple/start"),
        fakeBindings(),
        NOW,
      ),
      null,
    );
  });
});

test("an incomplete set of Apple credentials offers nothing at all", async () => {
  for (const missing of [
    "APPLE_SIGNIN_SERVICES_ID",
    "APPLE_SIGNIN_TEAM_ID",
    "APPLE_SIGNIN_KEY_ID",
    "APPLE_SIGNIN_PRIVATE_KEY",
    "APPLE_SIGNIN_APP_ORIGIN",
  ]) {
    await withEnv({ ...APPLE_ENV, [missing]: "" }, async () => {
      assert.equal(
        appleOAuth.appleOAuthServerFlowConfigured(),
        false,
        `${missing} was missing and the flow still reported itself configured`,
      );
      assert.equal(
        await appleOAuth.startAppleOAuthServerFlow(
          new Request("https://bandup.example.test/api/auth/apple/start"),
          fakeBindings(),
          NOW,
        ),
        null,
      );
    });
  }
  await withEnv(APPLE_ENV, () => {
    assert.equal(appleOAuth.appleOAuthServerFlowConfigured(), true);
    assert.deepEqual(appleOAuth.appleTokenAudiences(), [SERVICES_ID, BUNDLE_ID]);
  });
});

test("the code exchange signs itself with a minted secret and sends the same redirect_uri", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(APPLE_ENV, async () => {
    let body = null;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://appleid.apple.com/auth/token");
      assert.equal(init?.method, "POST");
      body = new URLSearchParams(String(init?.body));
      return Response.json({ id_token: "a.b.c" });
    };
    try {
      assert.deepEqual(
        await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test", NOW),
        { idToken: "a.b.c" },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("client_id"), SERVICES_ID);
    assert.equal(
      body.get("redirect_uri"),
      "https://bandup.example.test/api/auth/apple/callback",
      "Apple checks this against the one the code came back to",
    );
    // The secret is a JWT rather than the private key itself, which must never
    // leave this Worker.
    assert.equal(body.get("client_secret").split(".").length, 3);
    assert.doesNotMatch(body.get("client_secret"), /BEGIN PRIVATE KEY/);
  });

  // A code offered against an origin this Worker does not serve is refused
  // before any secret is minted for it.
  await withEnv(APPLE_ENV, async () => {
    assert.equal(
      await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://elsewhere.test", NOW),
      null,
    );
  });
});

/* --------------------------------------------------------------------------
   The name that arrives once.
   -------------------------------------------------------------------------- */

test("the first-authorization name is read from the form post and treated as display text", () => {
  assert.deepEqual(
    appleOAuth.parseAppleUserField('{"name":{"firstName":"Mei","lastName":"Chan"},"email":"x@y.test"}'),
    { givenName: "Mei", familyName: "Chan" },
  );
  assert.equal(
    appleOAuth.appleDisplayName(appleOAuth.parseAppleUserField('{"name":{"firstName":"Mei","lastName":"Chan"}}')),
    "Mei Chan",
  );
  // Half a name is still a name.
  assert.equal(
    appleOAuth.appleDisplayName(appleOAuth.parseAppleUserField('{"name":{"firstName":"Mei"}}')),
    "Mei",
  );
  // Every later sign-in, which is all of them but the first.
  for (const absent of [null, "", "not json", "[]", "{}", '{"name":{}}', '{"name":"Mei"}', '{"name":{"firstName":"   "}}']) {
    assert.equal(appleOAuth.parseAppleUserField(absent), null, `${absent} produced a name`);
  }
  assert.equal(appleOAuth.appleDisplayName(null), null);
  // It is unsigned input from a form body, so it is capped rather than trusted.
  const long = appleOAuth.parseAppleUserField(JSON.stringify({ name: { firstName: "a".repeat(500) } }));
  assert.equal(long.givenName.length, 60);
  assert.equal(appleOAuth.parseAppleUserField(`{"name":{"firstName":"${"a".repeat(5_000)}"}}`), null);
});

/* --------------------------------------------------------------------------
   Turning a verified Apple subject into a BandUp account.

   This is the half where a mistake is permanent. A verifier that is wrong
   refuses a sign-in; a resolver that is wrong merges two people's study history
   into one account, or issues somebody a second empty one, and neither can be
   undone from the outside. So the D1 below is small but it does enforce the two
   constraints that matter — the unique live email and the unique identity — and
   the tests are mostly about what must NOT happen.
   -------------------------------------------------------------------------- */

const nativeIdentity = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-identity.ts")).href
);

function identityStore() {
  const users = new Map();
  const identities = new Map();
  const profiles = new Map();

  function liveEmailOwner(email, exceptId) {
    if (!email) return null;
    for (const user of users.values()) {
      if (user.deleted_at === null
        && user.email
        && user.email.toLowerCase() === String(email).toLowerCase()
        && user.id !== exceptId) return user;
    }
    return null;
  }

  function statement(sql, values) {
    return {
      async run() {
        if (sql.includes("INSERT INTO app_users")) {
          const [id, email, created] = values;
          if (liveEmailOwner(email)) throw new Error("UNIQUE constraint failed: app_users.email");
          users.set(id, { id, email: email ?? null, created_at: created, deleted_at: null });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO app_user_identities")) {
          const [subject, userId, email, verified] = values;
          const key = `apple:${subject}`;
          if (identities.has(key)) throw new Error("UNIQUE constraint failed: app_user_identities");
          identities.set(key, { user_id: userId, email: email ?? null, email_verified: verified });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE app_users")) {
          const withEmail = sql.includes("SET email = ?");
          const id = withEmail ? values[2] : values[1];
          const user = users.get(id);
          if (!user || user.deleted_at !== null) return { success: true, meta: { changes: 0 } };
          if (withEmail) {
            if (liveEmailOwner(values[0], id)) throw new Error("UNIQUE constraint failed: app_users.email");
            user.email = values[0];
          }
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE app_user_identities")) {
          const row = identities.get(`apple:${values[3]}`);
          if (row) {
            row.email = values[0] ?? row.email;
            row.email_verified = values[1];
          }
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        if (sql.includes("INSERT INTO learner_profiles")) {
          const [userId, displayName, updatedAt] = values;
          const existing = profiles.get(userId);
          // The upsert's WHERE clause: only a profile with no name is touched.
          if (!existing) profiles.set(userId, { display_name: displayName, updated_at: updatedAt });
          else if (existing.display_name === null) {
            existing.display_name = displayName;
            existing.updated_at = updatedAt;
          }
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error(`unexpected D1 write: ${sql}`);
      },
      async first() {
        if (sql.includes("FROM app_user_identities i")) {
          const row = identities.get(`apple:${values[0]}`);
          const user = row ? users.get(row.user_id) : null;
          return user ? { ...user } : null;
        }
        if (sql.includes("FROM app_users")) {
          const owner = liveEmailOwner(values[0]);
          return owner ? { id: owner.id } : null;
        }
        throw new Error(`unexpected D1 read: ${sql}`);
      },
    };
  }

  return {
    users,
    identities,
    profiles,
    bindings: {
      db: {
        prepare(sql) {
          return { bind: (...values) => statement(sql, values) };
        },
        async batch(statements) {
          const results = [];
          for (const entry of statements) results.push(await entry.run());
          return results;
        },
      },
      files: {},
    },
  };
}

function appleIdentity(overrides = {}) {
  return {
    subject: "001234.7f3c9a2b5e6d4f18a0c7.1234",
    email: "learner@example.test",
    emailVerified: true,
    isPrivateEmail: false,
    ...overrides,
  };
}

test("a first Apple sign-in creates one account and captures the name it will never be sent again", async () => {
  const store = identityStore();
  const user = await nativeIdentity.resolveAppleIdentity(appleIdentity(), "Mei Chan", store.bindings);
  assert.ok(user?.id);
  assert.equal(user.email, "learner@example.test");
  assert.equal(store.users.size, 1);
  assert.equal(store.profiles.get(user.id)?.display_name, "Mei Chan");

  // The second sign-in is the same person, carries no name, and must not make a
  // second account or disturb the first one's profile.
  const again = await nativeIdentity.resolveAppleIdentity(appleIdentity(), null, store.bindings);
  assert.equal(again?.id, user.id);
  assert.equal(store.users.size, 1);
  assert.equal(store.profiles.get(user.id)?.display_name, "Mei Chan");
});

test("a name arriving against an existing account never overwrites the one already there", async () => {
  const store = identityStore();
  const user = await nativeIdentity.resolveAppleIdentity(appleIdentity(), "Mei Chan", store.bindings);
  // Whether this is Apple repeating itself or a forged form body, the answer is
  // the same: a profile in use is not rewritten from an authorization.
  await nativeIdentity.resolveAppleIdentity(appleIdentity(), "Somebody Else", store.bindings);
  assert.equal(store.profiles.get(user.id).display_name, "Mei Chan");
});

test("an address that already belongs to somebody is refused, not linked", async () => {
  const store = identityStore();
  store.users.set("existing-google-user", {
    id: "existing-google-user",
    email: "learner@example.test",
    created_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
  });

  /*
    The learner turned Private Relay off, or simply used the same address at
    both providers. Attaching this Apple subject to that account on the strength
    of a matching address would be an account takeover with the victim's own
    email as the only evidence.
  */
  assert.equal(
    await nativeIdentity.resolveAppleIdentity(appleIdentity(), null, store.bindings),
    null,
  );
  assert.equal(store.users.size, 1, "a second account was created anyway");
  assert.equal(store.identities.size, 0);
});

test("a later sign-in with no address does not empty the address on file", async () => {
  const store = identityStore();
  const user = await nativeIdentity.resolveAppleIdentity(appleIdentity(), null, store.bindings);
  const returning = await nativeIdentity.resolveAppleIdentity(
    appleIdentity({ email: null, emailVerified: false }),
    null,
    store.bindings,
  );
  assert.equal(returning?.id, user.id);
  // Recovery by email is the door somebody uses when every other one is shut.
  assert.equal(store.users.get(user.id).email, "learner@example.test");
  assert.equal(returning.email, "learner@example.test");
});

test("a hidden address becomes the account's address, and a deleted account is not reopened", async () => {
  const store = identityStore();
  const relayed = appleIdentity({ email: "abc123@privaterelay.appleid.com", isPrivateEmail: true });
  const user = await nativeIdentity.resolveAppleIdentity(relayed, null, store.bindings);
  assert.equal(store.users.get(user.id).email, "abc123@privaterelay.appleid.com");

  store.users.get(user.id).deleted_at = "2026-09-01T00:00:00.000Z";
  assert.equal(await nativeIdentity.resolveAppleIdentity(relayed, null, store.bindings), null);
});

test("a sign-in still succeeds when the address cannot be written", async () => {
  const store = identityStore();
  const user = await nativeIdentity.resolveAppleIdentity(appleIdentity(), null, store.bindings);
  // Somebody else takes that address afterwards — a merge question for the
  // audited path, not a reason to lock this person out of their own account.
  store.users.set("another-account", {
    id: "another-account",
    email: "changed@example.test",
    created_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
  });
  const returning = await nativeIdentity.resolveAppleIdentity(
    appleIdentity({ email: "changed@example.test" }),
    null,
    store.bindings,
  );
  assert.equal(returning?.id, user.id);
  assert.equal(store.users.get(user.id).email, "learner@example.test");
});

/* --------------------------------------------------------------------------
   The wiring that has no runtime to prove it.
   -------------------------------------------------------------------------- */

test("the native audience is the bundle id the app is actually built with", () => {
  assert.equal(appleToken.APPLE_NATIVE_AUDIENCE, BUNDLE_ID);
  // Drift here would be invisible: every native sign-in would fail the audience
  // check and nothing else would look wrong.
  assert.match(read("capacitor.config.ts"), /appId:\s*"com\.yiuadam\.bandup"/);
  assert.match(
    read("ios", "App", "App.xcodeproj", "project.pbxproj"),
    /PRODUCT_BUNDLE_IDENTIFIER = com\.yiuadam\.bandup;/,
  );
});

test("the Apple sign-in credentials are server-only and are not the in-app purchase key", () => {
  const env = read("lib", "auth", "env.ts");
  for (const name of [
    "APPLE_SIGNIN_SERVICES_ID",
    "APPLE_SIGNIN_TEAM_ID",
    "APPLE_SIGNIN_KEY_ID",
    "APPLE_SIGNIN_PRIVATE_KEY",
  ]) {
    assert.match(env, new RegExp(`"${name}",`), `${name} is not in SERVER_ONLY_ENV_VARS`);
  }
  // The IAP key is a different credential and stays one.
  for (const name of ["APPLE_IAP_ISSUER_ID", "APPLE_IAP_KEY_ID", "APPLE_IAP_PRIVATE_KEY"]) {
    assert.match(env, new RegExp(`"${name}",`));
    assert.doesNotMatch(read("lib", "auth", "apple-oauth-server.ts"), new RegExp(name));
    assert.doesNotMatch(read("lib", "auth", "apple-token.ts"), new RegExp(name));
  }
});

test("Apple runs on Web Crypto, because Workers has nothing else", () => {
  for (const source of [
    read("lib", "auth", "apple-token.ts"),
    read("lib", "auth", "apple-oauth-server.ts"),
  ]) {
    assert.match(source, /crypto\.subtle/);
    assert.doesNotMatch(source, /require\(|from "(node:)?crypto"|jsonwebtoken/);
  }
});

test("Apple's callback is a POST, because Apple answers with a form", () => {
  const callback = read("app", "api", "auth", "apple", "callback", "route.ts");
  assert.match(callback, /export const POST = withCors\(handlePOST\)/);
  assert.doesNotMatch(callback, /export const GET/);
  assert.match(callback, /request\.formData\(\)/);
  // Consumed before anything in the body is believed.
  assert.match(callback, /consumeAppleOAuthState[\s\S]*if \(!transaction\)/);
  // A redirect answering a POST has to say "go and GET this".
  assert.match(callback, /status: 303/);
  // The web flow's nonce is echoed rather than hashed.
  assert.match(callback, /verifyAppleIdToken\([\s\S]*"raw"/);
});

test("the native token route verifies a hashed nonce and never asks Supabase", () => {
  const route = read("app", "api", "auth", "apple", "token", "route.ts");
  assert.match(route, /verifyAppleIdToken\(credential, audiences, nonce, Date\.now\(\), "sha256"\)/);
  assert.match(route, /nativeAuthCutoverActive\(\)/);
  // Apple never reaches the compatibility authority: no import of it, so no
  // branch that could quietly create an account somewhere else.
  assert.doesNotMatch(route, /from "@\/lib\/auth\/supabase"/);
});

test("every Apple route carries CORS, so the iOS build can call it", () => {
  for (const name of ["config", "start", "callback", "token"]) {
    const route = read("app", "api", "auth", "apple", name, "route.ts");
    assert.match(route, /withCors/);
    assert.match(route, /export \{ OPTIONS \}/);
  }
});

test("no Apple button is offered where no Apple flow works", () => {
  const status = read("app", "api", "account", "status", "route.ts");
  assert.match(status, /appleOAuthServerFlowConfigured\(\) \? \["apple"\] : \[\]/);
  const config = read("app", "api", "auth", "apple", "config", "route.ts");
  assert.match(config, /appleOAuthServerFlowConfigured\(\)/);
  assert.match(config, /\{ enabled: false \}/);
  // And the button itself falls back to the established route rather than to a
  // dead one when the direct flow is unavailable.
  const button = read("components", "account", "AppleSignIn.tsx");
  assert.match(button, /apiUrl\("\/api\/auth\/start\?provider=apple"\)/);
});

test("the Apple button follows Apple's appearance rules rather than BandUp's glass", () => {
  const button = read("components", "account", "AppleSignIn.tsx");
  // Solid black on light, solid white on dark. Never translucent.
  assert.match(button, /theme === "dark" \? "bg-white text-black" : "bg-black text-white"/);
  assert.doesNotMatch(button, /premade-glass|backdrop|liquid-glass/);
  // One of Apple's permitted strings, and their own mark.
  assert.match(button, /Continue with Apple/);
  assert.match(button, /min-h-11/);
});

test("the iOS plugin hashes the nonce the way the server unhashes it", () => {
  const plugin = read("ios", "App", "App", "SignInWithApplePlugin.swift");
  assert.match(plugin, /request\.nonce = Self\.sha256Hex\(nonce\)/);
  // Lower-case hex on both sides, or nothing ever verifies.
  assert.match(plugin, /String\(format: "%02x"/);
  assert.match(plugin, /requestedScopes = \[\.fullName, \.email\]/);
  // The name is forwarded on the one request that will ever carry it.
  assert.match(plugin, /credential\.fullName\?\.givenName/);
  assert.match(plugin, /credential\.fullName\?\.familyName/);
  // And it is registered, since nothing auto-registers an app-target plugin.
  assert.match(
    read("ios", "App", "App", "MainViewController.swift"),
    /registerPluginInstance\(signInWithApple\)/,
  );
});
