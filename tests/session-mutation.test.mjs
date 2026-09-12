/*
  lib/auth/session.ts resolves who is calling: parse the bearer token out of
  the Authorization header, then decide -- based on the native cutover switch
  -- whether to verify it as a Cloudflare-native session or hand it to
  Supabase. This is the one seam every authenticated route goes through, so
  each boundary here (the exact header name, the Bearer regex's anchors and
  quantifiers, which branch runs when the cutover switch is on vs off) is
  tested directly against the real module.

  Four reported survivors in bearerToken() are not killed here because they
  are genuinely equivalent, all for the same underlying reason. bearerToken
  is `const token = match[1].trim(); return token.length > 0 ? token : null;`,
  reached only once `/^Bearer\s+(.+)$/i.exec(header.trim())` has already
  matched:

    - `header.trim()` runs first, so the trimmed header's *last* character
      can never be whitespace.
    - `\s+` is greedy, so it always consumes the maximal run of whitespace
      right after "Bearer" -- backtracking gives back the fewest characters
      needed for `(.+)$` to still reach that guaranteed-non-whitespace end.
    - Consequently match[1] can never start or end with whitespace: either
      there is at least one non-whitespace character on both ends already
      (making `.trim()` a no-op), or there is nothing at all after "Bearer"'s
      required whitespace, in which case the whole regex fails to match
      (returning null two lines earlier, before token.length is ever read).

  So: `\s+` -> `\s` (line 32) leaves the same trimmed capture either way;
  `match[1].trim()` -> `match[1]` (line 34) strips nothing that needed
  stripping; and `token.length > 0` -> `true` / `-> token.length >= 0`
  (line 35) can never actually observe a zero-length token to matter for.
  Contrast this with `\s+` -> `\S+` or `(.+)` -> `(.)`, which change what the
  regex matches at all rather than merely what's left over -- those, and the
  `token.length > 0` -> `false` / `-> <= 0` pair (which would make bearerToken
  return null for every real token, not just an empty one), are killed below
  by the ordinary positive-path assertions.
*/
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fakeRequest, freshD1, runtimeD1, withBrowserWindow, withEnv } from "./lib-auth-mutation-helpers.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const session = await load("lib", "auth", "session.ts");
const nativeSession = await load("lib", "auth", "native-session.ts");
const nativeIdentity = await load("lib", "cloudflare", "native-identity.ts");

const SIGNING_KEY = "a dedicated session-mutation test signing secret";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const NATIVE_CUTOVER_ON = {
  ACCOUNTS_ENABLED: "1",
  CLOUDFLARE_NATIVE_AUTH: "1",
  CLOUDFLARE_DATA_MODE: "cloudflare",
  ORGANIZATION_DATA_MODE: "cloudflare",
  BANDUP_SESSION_SIGNING_KEY: SIGNING_KEY,
  SUPABASE_URL: undefined,
  SUPABASE_ANON_KEY: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
};

// session.ts's own getSessionUser always calls userFromNativeBrowserSessionToken
// with no explicit `now`, so verification runs against the real wall clock --
// there is no seam to inject a fixed test time through it. Every token this
// file signs for a getSessionUser round trip is therefore signed against
// real Date.now(), not a fixed calendar date.
async function realNativeToken(now = Date.now()) {
  const { accessToken } = await nativeSession.createNativeAccessToken(
    { id: USER_ID, email: "learner@example.test" },
    "session-11111111-1111-4111-8111-111111111111",
    SIGNING_KEY,
    now,
  );
  return accessToken;
}

test("assertServerOnly guards both entry points, naming this exact module", async () => {
  await withBrowserWindow(async () => {
    assert.throws(
      () => session.isNativeSessionRequest(fakeRequest(null)),
      /lib\/auth\/session\.ts is server-only/,
    );
    await assert.rejects(
      () => session.getSessionUser(fakeRequest(null)),
      /lib\/auth\/session\.ts is server-only/,
    );
  });
});

test("isNativeSessionRequest reads exactly the 'authorization' header, case-insensitively, Bearer-scheme only", async () => {
  await withEnv(NATIVE_CUTOVER_ON, async () => {
    const token = await realNativeToken();
    assert.equal(session.isNativeSessionRequest(fakeRequest(null)), false, "no header at all");
    assert.equal(session.isNativeSessionRequest(fakeRequest(`Bearer ${token}`)), true, "ordinary header");
    assert.equal(session.isNativeSessionRequest(fakeRequest(`bearer ${token}`)), true, "scheme match is case-insensitive");
    assert.equal(session.isNativeSessionRequest(fakeRequest(`Basic ${token}`)), false, "wrong scheme");
    assert.equal(session.isNativeSessionRequest(fakeRequest(`Bearer${token}`)), false, "scheme needs at least one whitespace character");
    assert.equal(session.isNativeSessionRequest(fakeRequest("Bearer ")), false, "empty token after trim");
  });
});

test("the Bearer regex is anchored at both ends of the (trimmed) header, not merely a substring match", async () => {
  await withEnv(NATIVE_CUTOVER_ON, async () => {
    const token = await realNativeToken();
    // A dropped leading `^` would let this match starting after "Not".
    assert.equal(session.isNativeSessionRequest(fakeRequest(`NotBearer ${token}`)), false, "no anchor at the start");
    // A dropped trailing `$` would let (.+) stop at the embedded newline and
    // still match, silently accepting a token with trailing garbage.
    assert.equal(session.isNativeSessionRequest(fakeRequest(`Bearer ${token}\nSOMETHING_ELSE`)), false, "no anchor at the end");
  });
});

test("header.trim() runs before the scheme match, so outer whitespace around 'Bearer ...' is tolerated", async () => {
  await withEnv(NATIVE_CUTOVER_ON, async () => {
    const token = await realNativeToken();
    assert.equal(session.isNativeSessionRequest(fakeRequest(`  Bearer ${token}  `)), true);
  });
});

test("isNativeSessionRequest requires the cutover switch AND a native-looking token -- neither alone is enough", async () => {
  const token = await realNativeToken();
  // Cutover fully off: even a perfectly well-formed native token must not pass.
  await withEnv({ ...NATIVE_CUTOVER_ON, CLOUDFLARE_NATIVE_AUTH: "0" }, async () => {
    assert.equal(session.isNativeSessionRequest(fakeRequest(`Bearer ${token}`)), false);
  });
  // Cutover on, but the token does not look native (fails looksLikeNativeAccessToken).
  await withEnv(NATIVE_CUTOVER_ON, async () => {
    assert.equal(session.isNativeSessionRequest(fakeRequest("Bearer not-a-native-token")), false);
    assert.equal(session.isNativeSessionRequest(fakeRequest(`Bearer ${token}`)), true, "sanity: both conditions true does pass");
  });
});

test("getSessionUser is off entirely when accounts are not enabled, even with an otherwise-valid native token", async () => {
  // A `!accountsEnabled()` -> `accountsEnabled()` (or -> `false`) mutant would
  // let this fall through to the native branch instead of returning null
  // immediately; with ACCOUNTS_ENABLED="0" here but everything else in
  // NATIVE_CUTOVER_ON otherwise wired for the native path, that fallthrough
  // reaches requireBandUpCloudflareBindings() with no fake Cloudflare context
  // installed in this test, which throws -- so a mutant here fails this
  // assertion one way or another, either by returning something other than
  // null or by rejecting instead of resolving.
  const token = await realNativeToken();
  await withEnv({ ...NATIVE_CUTOVER_ON, ACCOUNTS_ENABLED: "0" }, async () => {
    assert.equal(await session.getSessionUser(fakeRequest(`Bearer ${token}`)), null);
  });
});

test("getSessionUser with the cutover on but a non-native token falls through to (and requires) Supabase configuration", async () => {
  await withEnv({ ...NATIVE_CUTOVER_ON, SUPABASE_URL: undefined }, async () => {
    // Not configured: must be null, not a thrown "unavailable" from deeper in supabase.ts.
    assert.equal(await session.getSessionUser(fakeRequest("Bearer not-a-native-token")), null);
  });
  await withEnv({
    ...NATIVE_CUTOVER_ON,
    SUPABASE_URL: "https://project.supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  }, async () => {
    const savedFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), authorization: new Headers(init.headers).get("authorization") });
      return new Response("{}", { status: 401 });
    };
    try {
      // Configured: must actually reach Supabase's GoTrue endpoint (proves the
      // `if (!supabaseConfigured()) return null;` guard did not fire, and that
      // the call fell through to userFromAccessToken rather than stopping
      // silently) -- a 401 from the fake still resolves to null, which is the
      // behaviour under test for the *other* branch; what matters here is
      // that a real request went out.
      assert.equal(await session.getSessionUser(fakeRequest("Bearer not-a-native-token")), null);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/auth\/v1\/user$/);
      assert.equal(calls[0].authorization, "Bearer not-a-native-token");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("getSessionUser's native branch requires BOTH the cutover switch and a native-looking token, and never leaks past it into Supabase", async () => {
  const token = await realNativeToken();
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: 401 });
  };
  try {
    // Cutover off (native-looking token, Supabase configured and reachable):
    // must fall through to Supabase, not silently swallow the request.
    await withEnv({
      ...NATIVE_CUTOVER_ON,
      CLOUDFLARE_NATIVE_AUTH: "0",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    }, async () => {
      calls.length = 0;
      await session.getSessionUser(fakeRequest(`Bearer ${token}`));
      assert.equal(calls.length, 1, "a `&&` -> `||` mutant, or the block being emptied, would skip Supabase incorrectly here only if cutover reads true; with cutover truly off this pins the branch is not entered by accident");
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("getSessionUser's native branch: BANDUP_SESSION_SIGNING_KEY missing throws the exact configuration error, naming both env vars", async () => {
  await withEnv({ ...NATIVE_CUTOVER_ON, BANDUP_SESSION_SIGNING_KEY: undefined }, async () => {
    const token = await realNativeToken();
    await assert.rejects(
      () => session.getSessionUser(fakeRequest(`Bearer ${token}`)),
      /CLOUDFLARE_NATIVE_AUTH=1 without BANDUP_SESSION_SIGNING_KEY/,
    );
  });
});

test("getSessionUser's native branch actually runs its body (not an emptied block) and resolves a real D1-backed session", async () => {
  await withEnv(NATIVE_CUTOVER_ON, async () => {
    globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = {
      env: { BANDUP_DB: runtimeD1(freshD1()), BANDUP_FILES: {} },
    };
    try {
      const now = Date.now();
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const ctx = await getCloudflareContext({ async: true });
      const dbBindings = { db: ctx.env.BANDUP_DB, files: ctx.env.BANDUP_FILES };
      await dbBindings.db.prepare(`
        INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
        VALUES (?, ?, 'user', ?, ?, 'cloudflare')
      `).bind(USER_ID, "learner@example.test", new Date(now).toISOString(), new Date(now).toISOString()).run();

      const created = await nativeIdentity.createNativeBrowserSessionForUser(
        { id: USER_ID, email: "learner@example.test", createdAt: new Date(now).toISOString() },
        SIGNING_KEY,
        dbBindings,
        now,
      );

      // If line 58's `if (...) { ... }` block were emptied, or its `&&`
      // loosened to `||` for a token that IS native-looking (so this
      // specific scenario is unaffected by that particular widening),
      // execution would fall through to `if (!supabaseConfigured()) return
      // null;` -- Supabase is deliberately left unconfigured by
      // NATIVE_CUTOVER_ON, so a fallen-through call returns null instead of
      // the real user the native branch resolves.
      const user = await session.getSessionUser(fakeRequest(`Bearer ${created.accessToken}`));
      assert.deepEqual(user, { id: USER_ID, email: "learner@example.test", createdAt: new Date(now).toISOString() });
    } finally {
      delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    }
  });
});

