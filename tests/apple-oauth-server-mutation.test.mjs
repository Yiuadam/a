/*
  Mutation-testing follow-up for lib/auth/apple-oauth-server.ts.

  tests/apple-signin.test.mjs already proves the shape of a correct web flow
  end to end: the authorize request, the one-time D1 state, the client secret,
  the code exchange and the first-authorization name. What is missing there —
  and what a mutation run found — is the defensive edge around each of those:
  the exact boundary lengths, the failure branches of the D1 calls, and the
  base64url encoder's own padding. Those are covered here, against fakes of
  the same shape tests/apple-signin.test.mjs already uses for D1.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const appleOAuth = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "apple-oauth-server.ts")).href
);

const SERVICES_ID = "com.yiuadam.bandup.web";

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

const SIGNING_KEY_PAIR = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const PKCS8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", SIGNING_KEY_PAIR.privateKey));

function pem(body) {
  const base64 = body.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

const APPLE_ENV = {
  ACCOUNTS_ENABLED: "1",
  APPLE_SIGNIN_SERVICES_ID: SERVICES_ID,
  APPLE_SIGNIN_TEAM_ID: "ABCDE12345",
  APPLE_SIGNIN_KEY_ID: "KEY1234567",
  APPLE_SIGNIN_PRIVATE_KEY: pem(PKCS8),
  APPLE_SIGNIN_APP_ORIGIN: "https://bandup.example.test",
};

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** A D1 stand-in whose SELECT and UPDATE answers are fixed per test. */
function scriptedBindings({ select = null, update = { success: true, meta: { changes: 1 } }, insert = { success: true, meta: { changes: 1 } } } = {}) {
  return {
    db: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("SELECT")) return select;
                throw new Error(`unexpected first(): ${sql}`);
              },
              async run() {
                if (sql.includes("UPDATE")) return update;
                if (sql.includes("INSERT")) return insert;
                if (sql.includes("DELETE")) return { success: true, meta: { changes: 0 } };
                throw new Error(`unexpected run(): ${sql}`);
              },
            };
          },
        };
      },
    },
    files: {},
  };
}

/* --------------------------------------------------------------------------
   assertServerOnly / MODULE — checked once through a function whose own
   guard is the first thing it does, which every exported entry point shares.
   -------------------------------------------------------------------------- */

test("every entry point refuses to run outside a server component", async () => {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    const message = /lib\/auth\/apple-oauth-server\.ts is server-only and must not be imported from a client component\./;
    assert.throws(() => appleOAuth.appleOAuthServerFlowConfigured(), message);
    assert.throws(() => appleOAuth.appleTokenAudiences(), message);
    await assert.rejects(() => appleOAuth.appleClientSecret({ servicesId: SERVICES_ID, teamId: "T", keyId: "K", privateKey: "x" }), message);
    await assert.rejects(
      () => appleOAuth.startAppleOAuthServerFlow(new Request("https://bandup.example.test/api/auth/apple/start")),
      message,
    );
    await assert.rejects(() => appleOAuth.consumeAppleOAuthState("a-state"), message);
    await assert.rejects(
      () => appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test"),
      message,
    );
  } finally {
    delete globalThis.window;
  }
});

test("appleTokenAudiences falls back to an empty list, not a placeholder, when unconfigured", async () => {
  await withEnv({ ...APPLE_ENV, APPLE_SIGNIN_SERVICES_ID: "" }, () => {
    assert.deepEqual(appleOAuth.appleTokenAudiences(), []);
  });
});

/* --------------------------------------------------------------------------
   The client secret: its exact lifetime, its base64url encoding, and its
   `typ` header field.
   -------------------------------------------------------------------------- */

test("a minted client secret is good for exactly ten minutes, not some other window", async () => {
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  const secret = await appleOAuth.appleClientSecret(
    { servicesId: SERVICES_ID, teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: pem(PKCS8) },
    now,
  );
  const payload = decodeJwtPart(secret.split(".")[1]);
  assert.equal(payload.exp - payload.iat, 600);
});

test("the client secret's header names the JWT type Apple expects", async () => {
  const secret = await appleOAuth.appleClientSecret(
    { servicesId: SERVICES_ID, teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: pem(PKCS8) },
  );
  const header = decodeJwtPart(secret.split(".")[0]);
  assert.equal(header.typ, "JWT");
});

test("the client secret's base64url encoding never leaves a trailing '=', however many the raw padding needed", async () => {
  // Varying the key id's length walks the JSON payload through every byte
  // alignment btoa can produce, so at least one of these needs two padding
  // characters stripped rather than one.
  for (let extra = 0; extra < 8; extra += 1) {
    const secret = await appleOAuth.appleClientSecret({
      servicesId: SERVICES_ID,
      teamId: "ABCDE12345",
      keyId: `KEY1234567${"x".repeat(extra)}`,
      privateKey: pem(PKCS8),
    });
    for (const part of secret.split(".")) {
      assert.doesNotMatch(part, /=/, `segment with ${extra} extra keyId characters kept a '=' pad`);
    }
  }
});

/* --------------------------------------------------------------------------
   The web flow's one-time state: the start request, the length guard on the
   state token, and every way consuming it can fail.
   -------------------------------------------------------------------------- */

test("the state row is refused to store, and startAppleOAuthServerFlow throws rather than handing out a URL nothing will honour", async () => {
  await withEnv(APPLE_ENV, async () => {
    await assert.rejects(
      () => appleOAuth.startAppleOAuthServerFlow(
        new Request("https://bandup.example.test/api/auth/apple/start"),
        scriptedBindings({ insert: { success: false, meta: { changes: 0 } } }),
      ),
      /Apple OAuth state could not be stored/,
    );
  });
});

test("consumeAppleOAuthState refuses a blank or over-long state before ever touching D1", async () => {
  await withEnv(APPLE_ENV, async () => {
    // db.prepare throws immediately, so any attempt to query at all — not
    // just an attempt that would find no matching row — fails this test.
    const bindings = {
      db: { prepare() { throw new Error("D1 should not have been queried"); } },
      files: {},
    };
    assert.equal(await appleOAuth.consumeAppleOAuthState("", bindings), null);
    assert.equal(await appleOAuth.consumeAppleOAuthState("s".repeat(257), bindings), null);
  });
});

test("a state of exactly 256 characters is not refused by the length guard", async () => {
  await withEnv(APPLE_ENV, async () => {
    const bindings = scriptedBindings({
      select: { nonce: "the-nonce", redirect_origin: "https://bandup.example.test" },
    });
    const consumed = await appleOAuth.consumeAppleOAuthState("s".repeat(256), bindings);
    assert.deepEqual(consumed, { nonce: "the-nonce", appOrigin: "https://bandup.example.test" });
  });
});

test("a stored row with a wrongly-typed nonce or redirect_origin is refused rather than passed through", async () => {
  await withEnv(APPLE_ENV, async () => {
    for (const select of [
      { nonce: 12345, redirect_origin: "https://bandup.example.test" },
      { nonce: "the-nonce", redirect_origin: null },
    ]) {
      const bindings = scriptedBindings({ select });
      assert.equal(await appleOAuth.consumeAppleOAuthState("a-state", bindings), null, JSON.stringify(select));
    }
  });
});

test("a state that D1 fails to mark consumed, or has already consumed, yields nothing", async () => {
  await withEnv(APPLE_ENV, async () => {
    const validRow = { nonce: "the-nonce", redirect_origin: "https://bandup.example.test" };
    for (const update of [
      { success: false, meta: { changes: 0 } },
      // success but zero rows changed — a concurrent, already-consumed request.
      { success: true, meta: { changes: 0 } },
    ]) {
      const bindings = scriptedBindings({ select: validRow, update });
      assert.equal(await appleOAuth.consumeAppleOAuthState("a-state", bindings), null, JSON.stringify(update));
    }
  });
});

test("a consumed row whose redirect_origin no longer matches this Worker's configured origin is refused", async () => {
  await withEnv(APPLE_ENV, async () => {
    const bindings = scriptedBindings({
      select: { nonce: "the-nonce", redirect_origin: "https://somewhere-else.example.test" },
    });
    assert.equal(await appleOAuth.consumeAppleOAuthState("a-state", bindings), null);
  });
  // Unconfigured entirely — settings is null, which must fail the same way
  // rather than throwing on `settings.appOrigin`.
  await withEnv({ ...APPLE_ENV, APPLE_SIGNIN_APP_ORIGIN: "" }, async () => {
    const bindings = scriptedBindings({
      select: { nonce: "the-nonce", redirect_origin: "https://bandup.example.test" },
    });
    assert.equal(await appleOAuth.consumeAppleOAuthState("a-state", bindings), null);
  });
});

/* --------------------------------------------------------------------------
   The code exchange: its own guard, and the response handling around fetch.
   -------------------------------------------------------------------------- */

test("exchangeAppleAuthorizationCode refuses an origin mismatch and an over-long code", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(APPLE_ENV, async () => {
    // fetch would otherwise happily answer with a valid token, so if either
    // guard were bypassed the result would stop being null.
    globalThis.fetch = async () => Response.json({ id_token: "a.b.c" });
    try {
      assert.equal(
        await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://elsewhere.example.test"),
        null,
      );
      assert.equal(
        await appleOAuth.exchangeAppleAuthorizationCode("c".repeat(4_097), "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("a code of exactly 4,096 characters is not refused by the length guard", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(APPLE_ENV, async () => {
    globalThis.fetch = async () => Response.json({ id_token: "a.b.c" });
    try {
      assert.deepEqual(
        await appleOAuth.exchangeAppleAuthorizationCode("c".repeat(4_096), "https://bandup.example.test"),
        { idToken: "a.b.c" },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("the token exchange sends form-encoded content, and a non-OK response is refused even with a valid body", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(APPLE_ENV, async () => {
    let seenHeaders = null;
    globalThis.fetch = async (_url, init) => {
      seenHeaders = init?.headers;
      return Response.json({ id_token: "a.b.c" });
    };
    try {
      await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test");
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.deepEqual(seenHeaders, { "Content-Type": "application/x-www-form-urlencoded" });

    // The body is the correct shape; only the status is wrong.
    globalThis.fetch = async () => Response.json({ id_token: "a.b.c" }, { status: 500 });
    try {
      assert.equal(
        await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("an id_token over 16,384 characters is refused, and one at exactly the cap is not", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(APPLE_ENV, async () => {
    globalThis.fetch = async () => Response.json({ id_token: "x".repeat(16_385) });
    try {
      assert.equal(
        await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
    globalThis.fetch = async () => Response.json({ id_token: "x".repeat(16_384) });
    try {
      assert.deepEqual(
        await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test"),
        { idToken: "x".repeat(16_384) },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("a token response whose body is the JSON value null is refused rather than crashing on it", async () => {
  // response.json() succeeds here — the body genuinely is `null`, not
  // unparsable — so body stays null from a clean parse rather than from the
  // catch above it. Reading `.id_token` off that has to stay optional.
  const savedFetch = globalThis.fetch;
  await withEnv(APPLE_ENV, async () => {
    globalThis.fetch = async () => Response.json(null);
    try {
      assert.equal(
        await appleOAuth.exchangeAppleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

/* --------------------------------------------------------------------------
   The first-authorization name: the raw-length guard, the object-shape
   guards that can actually be observed (parsed to exactly `null`), the
   blank-after-trim check, and the display name's own composition.
   -------------------------------------------------------------------------- */

test("a user field over 4,096 characters is refused, and one at exactly the cap is not", () => {
  const build = (totalLength) => {
    const skeleton = '{"name":{"firstName":""}}';
    const padNeeded = totalLength - skeleton.length;
    return `{"name":{"firstName":"${"a".repeat(padNeeded)}"}}`;
  };
  const atCap = build(4_096);
  assert.equal(atCap.length, 4_096);
  assert.ok(appleOAuth.parseAppleUserField(atCap));
  const overCap = build(4_097);
  assert.equal(overCap.length, 4_097);
  assert.equal(appleOAuth.parseAppleUserField(overCap), null);
});

test("a user field that parses to JSON null is refused rather than crashing on a null property read", () => {
  assert.equal(appleOAuth.parseAppleUserField("null"), null);
  assert.equal(appleOAuth.parseAppleUserField('{"name":null}'), null);
});

test("a first or last name that is nothing but whitespace is a null field, not an empty string", () => {
  const result = appleOAuth.parseAppleUserField('{"name":{"firstName":"   ","lastName":"Chan"}}');
  assert.equal(result.givenName, null);
  assert.equal(result.familyName, "Chan");
});

test("appleDisplayName trims what filtering and joining leave behind, and caps the result at 60 characters", () => {
  // A whitespace-only given name is truthy — Boolean(" ") — so it survives
  // the filter and has to be cleaned up by the trim afterwards.
  assert.equal(appleOAuth.appleDisplayName({ givenName: " ", familyName: "Chan" }), "Chan");
  assert.equal(appleOAuth.appleDisplayName({ givenName: null, familyName: null }), null);
  const long = appleOAuth.appleDisplayName({ givenName: "a".repeat(40), familyName: "b".repeat(40) });
  assert.equal(long.length, 60);
});

/* --------------------------------------------------------------------------
   The wiring with no runtime to prove it otherwise.
   -------------------------------------------------------------------------- */

test("appleOAuthCallbackUrl always targets the account callback path", () => {
  const url = new URL(appleOAuth.appleOAuthCallbackUrl("https://bandup.example.test", { a: "b" }));
  assert.equal(url.origin + url.pathname, "https://bandup.example.test/account/callback/");
  assert.equal(url.hash, "#a=b");
});
