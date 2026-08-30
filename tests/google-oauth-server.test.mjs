import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const oauth = await import(
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

function bindings() {
  const rows = new Map();
  return {
    bindings: {
      db: {
        prepare(sql) {
          return {
            bind(...values) {
              return {
                async run() {
                  if (sql.includes("DELETE FROM app_google_oauth_transactions")) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  if (sql.includes("INSERT INTO app_google_oauth_transactions")) {
                    rows.set(values[0], { nonce: values[1], redirect_origin: values[2], expires_at: values[4], consumed_at: null });
                    return { success: true, meta: { changes: 1 } };
                  }
                  if (sql.includes("UPDATE app_google_oauth_transactions")) {
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
                  if (sql.includes("FROM app_google_oauth_transactions")) {
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
    },
    rows,
  };
}

test("direct Google fallback uses one-time D1 state and a fixed callback origin", async () => {
  await withEnv({
    ACCOUNTS_ENABLED: "1",
    GOOGLE_CLIENT_ID: "bandup-web.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "a server-only test secret",
    GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test",
  }, async () => {
    const { bindings: target } = bindings();
    const now = Date.UTC(2026, 7, 28, 0, 0, 0);
    const start = await oauth.startGoogleOAuthServerFlow(
      new Request("https://bandup.example.test/api/auth/google/start"),
      target,
      now,
    );
    assert.ok(start);
    const url = new URL(start);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("redirect_uri"), "https://bandup.example.test/api/auth/google/callback");
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    const state = url.searchParams.get("state");
    assert.ok(state);

    const consumed = await oauth.consumeGoogleOAuthState(state, target, now + 1_000);
    assert.deepEqual(consumed?.appOrigin, "https://bandup.example.test");
    assert.ok(consumed?.nonce);
    assert.equal(await oauth.consumeGoogleOAuthState(state, target, now + 2_000), null);
    assert.equal(
      await oauth.startGoogleOAuthServerFlow(
        new Request("https://untrusted.example.test/api/auth/google/start"),
        target,
        now,
      ),
      null,
    );
  });
});

test("Google code exchange is server-side and validates a raw OIDC nonce", async () => {
  const savedFetch = globalThis.fetch;
  await withEnv({
    ACCOUNTS_ENABLED: "1",
    GOOGLE_CLIENT_ID: "bandup-web.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "a server-only test secret",
    GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test",
  }, async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /client_secret=a\+server-only\+test\+secret/);
      return Response.json({ id_token: "a.b.c" });
    };
    try {
      assert.deepEqual(
        await oauth.exchangeGoogleAuthorizationCode("code", "https://bandup.example.test"),
        { idToken: "a.b.c" },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  const source = readFileSync(join(process.cwd(), "components", "account", "GoogleSignIn.tsx"), "utf8");
  const startRoute = readFileSync(join(process.cwd(), "app", "api", "auth", "start", "route.ts"), "utf8");
  const callbackRoute = readFileSync(join(process.cwd(), "app", "api", "auth", "google", "callback", "route.ts"), "utf8");
  assert.match(source, /nativeAuth \? googleServerStart : legacyGoogleStart/);
  assert.match(startRoute, /provider === "google" && nativeAuthCutoverActive\(\)/);
  assert.match(callbackRoute, /verifyGoogleIdToken\([\s\S]*"raw"/);
  assert.doesNotMatch(callbackRoute, /signInWithGoogleIdToken|supabase/i);
});
