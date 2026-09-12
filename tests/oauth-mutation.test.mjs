/*
  Mutation-testing follow-up for lib/auth/oauth.ts.

  tests/oauth-china-google.test.mjs already exercises providersReachableFrom
  end to end, so this file covers what that one does not: the provider
  allowlist itself, the labels and callback path used to build the redirect,
  and authorizeUrl's own gating (accounts on, Supabase configured, and the
  client-only guard it shares with every other server-only module).
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

register("./alias-resolve.mjs", import.meta.url);

const oauth = await import(pathToFileURL(join(process.cwd(), "lib", "auth", "oauth.ts")).href);

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

const SUPABASE_ENV = {
  ACCOUNTS_ENABLED: "1",
  SUPABASE_URL: "https://project-ref.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "a-server-only-test-service-role-key",
  SUPABASE_ANON_KEY: "a-public-test-anon-key",
};

test("the provider allowlist accepts exactly google and apple, and nothing else", () => {
  assert.equal(oauth.isOAuthProvider("google"), true);
  assert.equal(oauth.isOAuthProvider("apple"), true);
  // A string that is not one of the two named providers.
  assert.equal(oauth.isOAuthProvider("facebook"), false);
  // Not a string at all — the typeof half of the check, not just the list.
  for (const value of [123, null, undefined, {}, [], ["google"], true]) {
    assert.equal(oauth.isOAuthProvider(value), false, `${JSON.stringify(value)} was accepted`);
  }
});

test("the provider labels and callback path are the exact strings Supabase and the UI expect", () => {
  assert.equal(oauth.PROVIDER_LABELS.google, "Google");
  assert.equal(oauth.PROVIDER_LABELS.apple, "Apple");
  assert.equal(oauth.CALLBACK_PATH, "/account/callback/");
  assert.equal(oauth.callbackUrl("https://bandup.example.test"), "https://bandup.example.test/account/callback/");
});

test("authorizeUrl refuses to run outside a server component", async () => {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    assert.throws(
      () => oauth.authorizeUrl("google", "https://bandup.example.test"),
      /lib\/auth\/oauth\.ts is server-only and must not be imported from a client component\./,
    );
  } finally {
    delete globalThis.window;
  }
});

test("authorizeUrl builds Supabase's authorize URL only when accounts are on and Supabase is configured", async () => {
  await withEnv(SUPABASE_ENV, () => {
    const url = oauth.authorizeUrl("google", "https://bandup.example.test");
    assert.ok(url);
    const parsed = new URL(url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, "https://project-ref.supabase.co/auth/v1/authorize");
    assert.equal(parsed.searchParams.get("provider"), "google");
    assert.equal(parsed.searchParams.get("redirect_to"), "https://bandup.example.test/account/callback/");
  });

  // Accounts switched off is refused even though Supabase itself is fully
  // configured — a half-open feature must read as fully closed.
  await withEnv({ ...SUPABASE_ENV, ACCOUNTS_ENABLED: "0" }, () => {
    assert.equal(oauth.authorizeUrl("google", "https://bandup.example.test"), null);
  });
  await withEnv({ ...SUPABASE_ENV, ACCOUNTS_ENABLED: "" }, () => {
    assert.equal(oauth.authorizeUrl("apple", "https://bandup.example.test"), null);
  });

  // Supabase left unconfigured is refused even with accounts on.
  await withEnv({ ...SUPABASE_ENV, SUPABASE_URL: "" }, () => {
    assert.equal(oauth.authorizeUrl("google", "https://bandup.example.test"), null);
  });
});
