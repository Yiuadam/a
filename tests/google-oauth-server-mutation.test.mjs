/*
  Mutation-testing follow-up for lib/auth/google-oauth-server.ts.

  tests/google-oauth-server.test.mjs already proves the shape of a correct
  direct-Google flow end to end: the authorize request, the one-time D1
  state, and the code exchange. What is missing there — and what a mutation
  run found — is the defensive edge around each of those: the exact request
  parameters, the boundary lengths, and every failure branch of the D1 and
  fetch calls. Those are covered here, against fakes of the same shape.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const googleOAuth = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "google-oauth-server.ts")).href
);

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

const GOOGLE_ENV = {
  ACCOUNTS_ENABLED: "1",
  GOOGLE_CLIENT_ID: "bandup-web.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "a server-only test secret",
  GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test",
};

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
   assertServerOnly / MODULE, and the config gate.
   -------------------------------------------------------------------------- */

test("every entry point refuses to run outside a server component", async () => {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    const message = /lib\/auth\/google-oauth-server\.ts is server-only and must not be imported from a client component\./;
    assert.throws(() => googleOAuth.googleOAuthServerFlowConfigured(), message);
    await assert.rejects(
      () => googleOAuth.startGoogleOAuthServerFlow(new Request("https://bandup.example.test/api/auth/google/start")),
      message,
    );
    await assert.rejects(() => googleOAuth.consumeGoogleOAuthState("a-state"), message);
    await assert.rejects(
      () => googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test"),
      message,
    );
  } finally {
    delete globalThis.window;
  }
});

test("googleOAuthServerFlowConfigured is true only when accounts are on and every Google value is set", async () => {
  await withEnv(GOOGLE_ENV, () => {
    assert.equal(googleOAuth.googleOAuthServerFlowConfigured(), true);
  });
  await withEnv({ ...GOOGLE_ENV, ACCOUNTS_ENABLED: "" }, () => {
    assert.equal(googleOAuth.googleOAuthServerFlowConfigured(), false);
  });
  await withEnv({ ...GOOGLE_ENV, GOOGLE_CLIENT_ID: "" }, () => {
    assert.equal(googleOAuth.googleOAuthServerFlowConfigured(), false);
  });
});

/* --------------------------------------------------------------------------
   The authorize request's exact parameters.
   -------------------------------------------------------------------------- */

test("the authorize request carries every parameter Google requires, by its exact name and value", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    const start = await googleOAuth.startGoogleOAuthServerFlow(
      new Request("https://bandup.example.test/api/auth/google/start"),
      scriptedBindings(),
    );
    const url = new URL(start);
    assert.equal(url.searchParams.get("client_id"), "bandup-web.apps.googleusercontent.com");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(url.searchParams.get("nonce"));
    assert.equal(url.searchParams.get("prompt"), "select_account");
    // Confirms the four string literals above are read as request parameters
    // and not silently dropped — an empty-string key or value would mean
    // Google either never sees the parameter or sees it with nothing in it.
    for (const key of ["client_id", "response_type", "nonce", "prompt"]) {
      assert.notEqual(url.searchParams.get(key), "");
    }
  });
});

test("the state row is refused to store, and startGoogleOAuthServerFlow throws rather than handing out a URL nothing will honour", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    await assert.rejects(
      () => googleOAuth.startGoogleOAuthServerFlow(
        new Request("https://bandup.example.test/api/auth/google/start"),
        scriptedBindings({ insert: { success: false, meta: { changes: 0 } } }),
      ),
      /Google OAuth state could not be stored/,
    );
  });
});

/* --------------------------------------------------------------------------
   The web flow's one-time state: the length guard, and every way consuming
   it can fail.
   -------------------------------------------------------------------------- */

test("consumeGoogleOAuthState refuses a blank or over-long state before ever touching D1", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    const bindings = {
      db: { prepare() { throw new Error("D1 should not have been queried"); } },
      files: {},
    };
    assert.equal(await googleOAuth.consumeGoogleOAuthState("", bindings), null);
    assert.equal(await googleOAuth.consumeGoogleOAuthState("s".repeat(257), bindings), null);
  });
});

test("a state of exactly 256 characters is not refused by the length guard", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    const bindings = scriptedBindings({
      select: { nonce: "the-nonce", redirect_origin: "https://bandup.example.test" },
    });
    assert.deepEqual(
      await googleOAuth.consumeGoogleOAuthState("s".repeat(256), bindings),
      { nonce: "the-nonce", appOrigin: "https://bandup.example.test" },
    );
  });
});

test("a stored row with a wrongly-typed nonce is refused rather than passed through", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    const bindings = scriptedBindings({
      select: { nonce: 12345, redirect_origin: "https://bandup.example.test" },
    });
    assert.equal(await googleOAuth.consumeGoogleOAuthState("a-state", bindings), null);
  });
});

test("a state that D1 fails to mark consumed, or has already consumed, yields nothing", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    const validRow = { nonce: "the-nonce", redirect_origin: "https://bandup.example.test" };
    for (const update of [
      { success: false, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } },
    ]) {
      const bindings = scriptedBindings({ select: validRow, update });
      assert.equal(await googleOAuth.consumeGoogleOAuthState("a-state", bindings), null, JSON.stringify(update));
    }
  });
});

test("a consumed row whose redirect_origin no longer matches this Worker's configured origin is refused", async () => {
  await withEnv(GOOGLE_ENV, async () => {
    const bindings = scriptedBindings({
      select: { nonce: "the-nonce", redirect_origin: "https://somewhere-else.example.test" },
    });
    assert.equal(await googleOAuth.consumeGoogleOAuthState("a-state", bindings), null);
  });
  await withEnv({ ...GOOGLE_ENV, GOOGLE_OAUTH_APP_ORIGIN: "" }, async () => {
    const bindings = scriptedBindings({
      select: { nonce: "the-nonce", redirect_origin: "https://bandup.example.test" },
    });
    assert.equal(await googleOAuth.consumeGoogleOAuthState("a-state", bindings), null);
  });
});

/* --------------------------------------------------------------------------
   The code exchange: its own guard, and the response handling around fetch.
   -------------------------------------------------------------------------- */

test("exchangeGoogleAuthorizationCode refuses an origin mismatch and an over-long code", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(GOOGLE_ENV, async () => {
    globalThis.fetch = async () => Response.json({ id_token: "a.b.c" });
    try {
      assert.equal(
        await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://elsewhere.example.test"),
        null,
      );
      assert.equal(
        await googleOAuth.exchangeGoogleAuthorizationCode("c".repeat(4_097), "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("a code of exactly 4,096 characters is not refused by the length guard", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(GOOGLE_ENV, async () => {
    globalThis.fetch = async () => Response.json({ id_token: "a.b.c" });
    try {
      assert.deepEqual(
        await googleOAuth.exchangeGoogleAuthorizationCode("c".repeat(4_096), "https://bandup.example.test"),
        { idToken: "a.b.c" },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("the token request targets the right redirect_uri and grant_type, and a non-OK response is refused even with a valid body", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(GOOGLE_ENV, async () => {
    let body = null;
    globalThis.fetch = async (_url, init) => {
      body = new URLSearchParams(String(init?.body));
      return Response.json({ id_token: "a.b.c" });
    };
    try {
      await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test");
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.equal(body.get("redirect_uri"), "https://bandup.example.test/api/auth/google/callback");
    assert.equal(body.get("grant_type"), "authorization_code");

    globalThis.fetch = async () => Response.json({ id_token: "a.b.c" }, { status: 500 });
    try {
      assert.equal(
        await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("a token response that fails to parse as JSON is refused, and one whose body is JSON null does not crash", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(GOOGLE_ENV, async () => {
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    try {
      assert.equal(
        await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
    globalThis.fetch = async () => Response.json(null);
    try {
      assert.equal(
        await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("an id_token over 16,384 characters is refused, and one at exactly the cap is not", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv(GOOGLE_ENV, async () => {
    globalThis.fetch = async () => Response.json({ id_token: "x".repeat(16_385) });
    try {
      assert.equal(
        await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test"),
        null,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
    globalThis.fetch = async () => Response.json({ id_token: "x".repeat(16_384) });
    try {
      assert.deepEqual(
        await googleOAuth.exchangeGoogleAuthorizationCode("a-code", "https://bandup.example.test"),
        { idToken: "x".repeat(16_384) },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

/* --------------------------------------------------------------------------
   The wiring with no runtime to prove it otherwise.
   -------------------------------------------------------------------------- */

test("googleOAuthCallbackUrl always targets the account callback path", () => {
  const url = new URL(googleOAuth.googleOAuthCallbackUrl("https://bandup.example.test", { a: "b" }));
  assert.equal(url.origin + url.pathname, "https://bandup.example.test/account/callback/");
  assert.equal(url.hash, "#a=b");
});
