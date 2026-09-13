/*
  Mutation-kill coverage for lib/auth/supabase.ts.

  This file is deliberately independent of tests/cutover-write-barrier.test.mjs:
  that file already proves the "armed" branch of every guarded writer here
  (barrier on -> refuse, no request sent), with a real in-memory D1. What it
  does not pin down is the *shape* of the request each function sends when the
  barrier is not armed — the exact URL, query string, method and body — nor
  the parsing/validation logic around each response. That is what is tested
  here, and it needs no Cloudflare binding at all:
  lib/cloudflare/write-barrier.ts's cutoverWriteBarrierRecord fails OPEN (not
  armed) whenever bandUpCloudflareBindings() cannot reach a real Workers
  runtime, which is exactly this process, so every "unarmed" path below runs
  with nothing more than a stubbed `fetch`.

  Every Supabase response is a hand-built Response (or a Response-shaped
  object, where a function only ever calls .ok/.status/.text()/.json() on it),
  never the real network, so each test pins one specific branch rather than
  hoping a live backend happens to answer a particular way today.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const supabase = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "supabase.ts")).href
);

const BASE_CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

const USER = "60000000-0000-4000-8000-000000000001";
const NOT_A_UUID = "not-a-uuid";

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

/**
 * Installs a fetch stub for the duration of `fn` and hands it the call log.
 * `handler(call, index)` decides the response; anything it returns is passed
 * straight back, so a test that needs a non-Response, throwing `.text()` can
 * simply return a plain object shaped like one.
 */
function withFetch(handler, fn, envOverrides = {}) {
  return withEnv({ ...BASE_CONFIG, ...envOverrides }, async () => {
    const calls = [];
    const saved = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      const call = {
        url: String(input),
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        body: init.body,
        cache: init.cache,
        signal: init.signal,
      };
      calls.push(call);
      return handler(call, calls.length - 1);
    };
    try {
      return await fn(calls);
    } finally {
      globalThis.fetch = saved;
    }
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function body(call) {
  return JSON.parse(call.body);
}

/* "page=2" is also a substring of "per_page=200", so every pagination fixture
   below reads the query parameter properly rather than matching raw text. */
function pageOf(url) {
  return new URL(url).searchParams.get("page");
}

/* ===========================================================================
   Foundation: assertServerOnly, request()'s header selection, rpc, rpcDiagnostic
   =========================================================================== */

test("every Supabase call still refuses to run from a browser, by name", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const rejectsServerOnly = (fn) => assert.rejects(
    fn,
    /lib\/auth\/supabase\.ts is server-only and must not be imported from a client component\./,
  );
  try {
    await withFetch(
      () => jsonResponse({}),
      async () => {
        // request() itself, reached through any ordinary call.
        await rejectsServerOnly(() => supabase.getAccountKind(USER));
        // The five owner-only audit readers each check again independently,
        // rather than relying on request() to have checked for them.
        await rejectsServerOnly(() => supabase.listSupabaseNativeIdentitySource());
        await rejectsServerOnly(() => supabase.listSupabaseGoogleIdentities());
        await rejectsServerOnly(() => supabase.listSupabaseAuthAccounts());
        await rejectsServerOnly(() => supabase.listSupabaseAuthProviderSummary());
        await rejectsServerOnly(() => supabase.listStripeCutoverSourceEvidence());
      },
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("with no backend configured, a call that does not catch its own failure names the reason", async () => {
  await withEnv({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }, async () => {
    await assert.rejects(() => supabase.rpc("whatever", {}), /accounts backend is not configured/);
  });
});

test("request() always sends JSON, and picks its identity by asServiceRole", () =>
  withFetch(
    () => jsonResponse([]),
    async (calls) => {
      // getAccountKind always asks as the service role.
      await supabase.getAccountKind(USER);
      const serviceCall = calls[0];
      assert.equal(serviceCall.headers["content-type"], "application/json");
      assert.equal(serviceCall.headers.apikey, "service-role-key");
      assert.equal(serviceCall.headers.authorization, "Bearer service-role-key");

      // sendMagicLink never sets asServiceRole and carries no bearer, so the
      // anon key covers both the apikey and Authorization headers.
      calls.length = 0;
      await supabase.sendMagicLink("learner@example.test", "https://bandup.life/auth/callback");
      const anonCall = calls[0];
      assert.equal(anonCall.headers["content-type"], "application/json");
      assert.equal(anonCall.headers.apikey, "anon-key");
      assert.equal(anonCall.headers.authorization, "Bearer anon-key");

      // userFromAccessToken supplies its own bearer, which overrides the anon
      // fallback in Authorization but never in apikey.
      calls.length = 0;
      await supabase.userFromAccessToken("a-real-token").catch(() => {});
      const bearerCall = calls[0];
      assert.equal(bearerCall.headers.apikey, "anon-key");
      assert.equal(bearerCall.headers.authorization, "Bearer a-real-token");
    },
  ));

test("request() aborts a hung Supabase after 8 seconds, not some other duration", () =>
  withFetch(
    () => jsonResponse([]),
    async () => {
      const real = AbortSignal.timeout;
      const captured = [];
      AbortSignal.timeout = (ms) => {
        captured.push(ms);
        return real.call(AbortSignal, ms);
      };
      try {
        await supabase.getAccountKind(USER);
      } finally {
        AbortSignal.timeout = real;
      }
      assert.deepEqual(captured, [8000]);
    },
  ));

test("rpc() posts to the named function as the service role and returns the parsed body", () =>
  withFetch(
    () => jsonResponse({ marker: "distinct-payload" }),
    async (calls) => {
      const result = await supabase.rpc("some_function", { p_a: 1 });
      assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/some_function");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(body(calls[0]), { p_a: 1 });
      assert.equal(calls[0].headers.apikey, "service-role-key");
      assert.deepEqual(result, { marker: "distinct-payload" });
    },
  ));

test("rpc() throws with the function name and status when Postgres refuses, and never returns the body", () =>
  withFetch(
    () => jsonResponse({ message: "column boom does not exist" }, 400),
    async () => {
      await assert.rejects(
        () => supabase.rpc("claim_username", {}),
        /rpc claim_username failed with 400/,
      );
    },
  ));

test("rpcDiagnostic reports a network failure as ok:false/status:0 rather than throwing, and calls the same way rpc() does", () =>
  withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async (calls) => {
      const result = await supabase.rpcDiagnostic("set_app_setting", { p_on: true });
      assert.equal(result.ok, false);
      assert.equal(result.status, 0);
      assert.match(result.detail, /fetch failed/);
      // The attempt itself is still observable even though it went nowhere:
      // withFetch records a call's shape before handing it to the handler.
      assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/set_app_setting");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(body(calls[0]), { p_on: true });
      assert.equal(calls[0].headers.apikey, "service-role-key");
    },
  ));

test("rpcDiagnostic keeps the response body, truncated at 600 characters, and never guesses when it cannot be read", () =>
  withFetch(
    (call, index) => (index === 0
      ? { ok: false, status: 400, text: async () => "x".repeat(900) }
      : { ok: false, status: 400, text: async () => { throw new Error("unreadable"); } }),
    async () => {
      const long = await supabase.rpcDiagnostic("fn_a", {});
      assert.equal(long.ok, false);
      assert.equal(long.status, 400);
      assert.equal(long.detail.length, 600);
      assert.equal(long.detail, "x".repeat(600));

      const unreadable = await supabase.rpcDiagnostic("fn_b", {});
      assert.equal(unreadable.detail, "");
    },
  ));

/* ===========================================================================
   getAppSettingRecord
   =========================================================================== */

test("getAppSettingRecord refuses a malformed key before ever calling Supabase", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      for (const bad of ["", "x".repeat(121), "has\0null"]) {
        await assert.rejects(() => supabase.getAppSettingRecord(bad), /app setting key is invalid/);
      }
      assert.equal(calls.length, 0, "an invalid key must never reach Supabase");

      // The boundary itself: 1 and 120 characters are both accepted lengths.
      calls.length = 0;
      await supabase.getAppSettingRecord("x");
      await supabase.getAppSettingRecord("x".repeat(120));
      assert.equal(calls.length, 2);
      assert.equal(
        calls[0].url,
        "https://project.supabase.test/rest/v1/app_settings?key=eq.x&select=key,value,updated_at,updated_by&limit=1",
      );
    },
  ));

test("getAppSettingRecord throws on a failed read and on a row that does not match its own contract", () =>
  withFetch(
    () => jsonResponse({}, 500),
    async () => {
      await assert.rejects(() => supabase.getAppSettingRecord("maintenance"), /app setting read failed with 500/);
    },
  ));

test("getAppSettingRecord returns null for no row, and validates the row it does get before trusting it", async () => {
  await withFetch(
    () => jsonResponse([]),
    async () => {
      assert.equal(await supabase.getAppSettingRecord("maintenance"), null);
    },
  );

  const badRows = [
    { key: "someone-else", value: 1, updated_at: "2026-01-01T00:00:00Z", updated_by: null },
    { key: "maintenance", value: 1, updated_at: "not-a-date", updated_by: null },
    { key: "maintenance", value: 1, updated_at: "2026-01-01T00:00:00Z", updated_by: 42 },
  ];
  for (const row of badRows) {
    await withFetch(
      () => jsonResponse([row]),
      async () => {
        await assert.rejects(() => supabase.getAppSettingRecord("maintenance"), /app setting response is invalid/);
      },
    );
  }
});

test("getAppSettingRecord normalises the timestamp and passes updated_by through as given", () =>
  withFetch(
    () => jsonResponse([{
      key: "maintenance",
      value: { on: true },
      updated_at: "2026-01-01T00:00:00+00:00",
      updated_by: "owner@example.test",
    }]),
    async () => {
      const record = await supabase.getAppSettingRecord("maintenance");
      assert.deepEqual(record, {
        key: "maintenance",
        value: { on: true },
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "owner@example.test",
      });
    },
  ));

/* ===========================================================================
   sendMagicLink / enabledOAuthProviders
   =========================================================================== */

test("sendMagicLink never offers to create an account, and reports Supabase's own answer", () =>
  withFetch(
    (call) => jsonResponse({}, call.url.includes("nope") ? 400 : 200),
    async (calls) => {
      const accepted = await supabase.sendMagicLink("learner@example.test", "https://bandup.life/x?nope=1".replace("nope", "cb"));
      assert.equal(accepted, true);
      assert.equal(calls[0].method, "POST");
      assert.equal(
        calls[0].url,
        "https://project.supabase.test/auth/v1/otp?redirect_to=https%3A%2F%2Fbandup.life%2Fx%3Fcb%3D1",
      );
      assert.deepEqual(body(calls[0]), { email: "learner@example.test", should_create_user: false });

      calls.length = 0;
      const refused = await supabase.sendMagicLink("learner@example.test", "https://bandup.life/nope");
      assert.equal(refused, false);
    },
  ));

test("sendMagicLink reports false rather than throwing when Supabase cannot be reached", () =>
  withFetch(
    () => { throw new TypeError("network down"); },
    async () => {
      assert.equal(await supabase.sendMagicLink("learner@example.test", "https://bandup.life/cb"), false);
    },
  ));

test("enabledOAuthProviders keeps only the providers Supabase reports as strictly true", () =>
  withFetch(
    () => jsonResponse({ external: { google: true, apple: false, azure: 1, saml: "true" } }),
    async () => {
      const providers = await supabase.enabledOAuthProviders();
      assert.deepEqual(providers, ["google"]);
    },
  ));

test("enabledOAuthProviders reads null for every way the settings answer can fail", async () => {
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.enabledOAuthProviders(), null);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.enabledOAuthProviders(), null);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    assert.equal(await supabase.enabledOAuthProviders(), null);
  });
  await withFetch(() => jsonResponse({ external: "nope" }), async () => {
    assert.equal(await supabase.enabledOAuthProviders(), null);
  });
});

/* ===========================================================================
   getAccountKind / getProfile
   =========================================================================== */

test("getAccountKind reads the one column it needs and validates the shape of the answer", () =>
  withFetch(
    () => jsonResponse({}, 500),
    async (calls) => {
      await assert.rejects(() => supabase.getAccountKind(USER), /profile account kind read failed with 500/);
      assert.equal(
        calls[0].url,
        `https://project.supabase.test/rest/v1/profiles?id=eq.${USER}&select=account_kind`,
      );
      assert.equal(calls[0].method, "GET");
    },
  ));

test("getAccountKind rejects a non-array response and returns null for no row or an unrecognised kind", async () => {
  await withFetch(() => jsonResponse({ not: "an array" }), async () => {
    await assert.rejects(() => supabase.getAccountKind(USER), /profile account kind response is invalid/);
  });
  await withFetch(() => jsonResponse([]), async () => {
    assert.equal(await supabase.getAccountKind(USER), null);
  });
  await withFetch(() => jsonResponse([{ account_kind: "not-a-real-kind" }]), async () => {
    assert.equal(await supabase.getAccountKind(USER), null);
  });
  await withFetch(() => jsonResponse([{ account_kind: "teacher" }]), async () => {
    assert.equal(await supabase.getAccountKind(USER), "teacher");
  });
});

test("getProfile asks for the profile and the username together, and gives up on either failing", async () => {
  await withFetch(
    (call) => jsonResponse({}, call.url.includes("usernames") ? 200 : 500),
    async (calls) => {
      assert.equal(await supabase.getProfile(USER), null);
      assert.equal(calls.length, 2, "both requests are issued even though one is doomed to be discarded");
      const profileCall = calls.find((c) => !c.url.includes("usernames"));
      const usernameCall = calls.find((c) => c.url.includes("usernames"));
      assert.equal(
        profileCall.url,
        `https://project.supabase.test/rest/v1/profiles?id=eq.${USER}` +
          "&select=display_name,avatar_path,birth_date,email,account_kind,updated_at",
      );
      assert.equal(profileCall.headers.apikey, "service-role-key");
      assert.equal(
        usernameCall.url,
        `https://project.supabase.test/rest/v1/usernames?user_id=eq.${USER}&select=username`,
      );
      assert.equal(usernameCall.headers.apikey, "service-role-key");
    },
  );
  await withFetch(
    (call) => jsonResponse({}, call.url.includes("usernames") ? 500 : 200),
    async () => {
      assert.equal(await supabase.getProfile(USER), null);
    },
  );
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.getProfile(USER), null);
  });
});

test("getProfile reads every field through the same has-content rule, and defaults a missing username to null", () =>
  withFetch(
    (call) => (call.url.includes("usernames")
      ? jsonResponse([])
      : jsonResponse([{
        display_name: "Ada",
        avatar_path: "",
        birth_date: "2000-01-01",
        email: "ada@example.test",
        account_kind: "individual",
        updated_at: "2026-01-01T00:00:00Z",
      }])),
    async () => {
      const profile = await supabase.getProfile(USER);
      assert.deepEqual(profile, {
        displayName: "Ada",
        username: null,
        accountKind: "individual",
        avatarPath: null,
        birthDate: "2000-01-01",
        email: "ada@example.test",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
  ));

test("getProfile returns null rather than a half-built profile when the body cannot be parsed", () =>
  withFetch(
    () => new Response("not json", { status: 200 }),
    async () => {
      assert.equal(await supabase.getProfile(USER), null);
    },
  ));

test("getProfile survives a username answer that is not an array at all, rather than throwing past its own catch", () =>
  withFetch(
    (call) => (call.url.includes("usernames")
      ? jsonResponse(null)
      : jsonResponse([{ display_name: "Ada", updated_at: "2026-01-01T00:00:00Z" }])),
    async () => {
      // usernames?.[0]?.username must guard every step: a bare `null` answer
      // (not merely an empty array) still resolves to a normal profile with
      // no claimed username, rather than an uncaught TypeError.
      const profile = await supabase.getProfile(USER);
      assert.equal(profile.username, null);
      assert.equal(profile.displayName, "Ada");
    },
  ));

/* ===========================================================================
   updateProfile
   =========================================================================== */

test("updateProfile builds its patch from an allow-list, keyed by presence rather than truthiness", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      // A field explicitly set to null is still a real instruction to clear it.
      await supabase.updateProfile(USER, { avatarPath: null });
      assert.deepEqual(body(calls[0]), { avatar_path: null });

      calls.length = 0;
      await supabase.updateProfile(USER, {
        displayName: "Ada",
        birthDate: "2000-01-01",
        avatarPath: "u/a.webp",
        accountKind: "student",
      });
      assert.deepEqual(body(calls[0]), {
        display_name: "Ada",
        birth_date: "2000-01-01",
        avatar_path: "u/a.webp",
        account_kind: "student",
      });
      assert.equal(calls[0].method, "PATCH");
      assert.equal(calls[0].headers.prefer, "return=minimal");
      assert.equal(calls[0].url, `https://project.supabase.test/rest/v1/profiles?id=eq.${USER}`);
    },
  ));

test("updateProfile with nothing recognised in it is a no-op that never touches the network", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      const result = await supabase.updateProfile(USER, {});
      assert.equal(result, true);
      assert.equal(calls.length, 0);
    },
  ));

test("updateProfile reports Supabase's own success flag, and false rather than throwing on a network failure", async () => {
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.updateProfile(USER, { displayName: "Ada" }), false);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.updateProfile(USER, { displayName: "Ada" }), false);
  });
});

/* ===========================================================================
   setAccountIdentity / claimUsername / emailForUsername
   =========================================================================== */

test("setAccountIdentity calls the RPC with every field under its Postgres name, birth date included", () =>
  withFetch(
    () => jsonResponse("ok"),
    async (calls) => {
      await supabase.setAccountIdentity(USER, "Ada Lovelace", "ada", "individual", null);
      assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/set_account_identity");
      assert.deepEqual(body(calls[0]), {
        p_user_id: USER,
        p_display_name: "Ada Lovelace",
        p_username: "ada",
        p_account_kind: "individual",
        p_birth_date: null,
      });
    },
  ));

test("claimUsername calls its own RPC with only the two fields it needs", () =>
  withFetch(
    () => jsonResponse("ok"),
    async (calls) => {
      await supabase.claimUsername(USER, "ada2");
      assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/claim_username");
      assert.deepEqual(body(calls[0]), { p_user_id: USER, p_username: "ada2" });
    },
  ));

test("emailForUsername resolves through the RPC and turns any failure into null, not a throw", async () => {
  await withFetch(() => jsonResponse("owner@example.test"), async () => {
    assert.equal(await supabase.emailForUsername("owner"), "owner@example.test");
  });
  await withFetch(() => jsonResponse(null), async () => {
    assert.equal(await supabase.emailForUsername("nobody"), null);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.emailForUsername("owner"), null);
  });
});

/* ===========================================================================
   currentAccessGrants / stripeSubscriptionReplica
   =========================================================================== */

test("currentAccessGrants never asks Supabase about an id shaped wrong", () =>
  withFetch(
    () => jsonResponse([]),
    async (calls) => {
      assert.deepEqual(await supabase.currentAccessGrants(NOT_A_UUID), []);
      assert.equal(calls.length, 0);
    },
  ));

test("currentAccessGrants throws on a failed lookup rather than returning an empty entitlement list", () =>
  withFetch(
    () => jsonResponse({}, 500),
    async (calls) => {
      await assert.rejects(() => supabase.currentAccessGrants(USER), /subscription lookup failed with 500/);
      assert.equal(
        calls[0].url,
        `https://project.supabase.test/rest/v1/subscriptions?user_id=eq.${USER}&status=in.(active,trialing)` +
          "&select=provider,tier,external_price_id,current_period_end,cancel_at_period_end&limit=50",
      );
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].headers.apikey, "service-role-key");
    },
  ));

test("currentAccessGrants defaults provider/tier to empty text but leaves the other fields genuinely absent", () =>
  withFetch(
    () => jsonResponse([
      // An empty string, not merely a missing field: this is what tells "no
      // content" (which still defaults provider/tier to "") apart from "any
      // string at all, including one with no characters" (which would not).
      { cancel_at_period_end: "true", external_price_id: "" },
      {
        provider: "stripe", tier: "ai", external_price_id: "price_1",
        current_period_end: "2027-01-01T00:00:00Z", cancel_at_period_end: true,
      },
    ]),
    async () => {
      const grants = await supabase.currentAccessGrants(USER);
      assert.deepEqual(grants[0], {
        provider: "", tier: "", priceId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      });
      assert.deepEqual(grants[1], {
        provider: "stripe", tier: "ai", priceId: "price_1",
        currentPeriodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: true,
      });
    },
  ));

test("stripeSubscriptionReplica refuses an id with an unreasonable shape before any network call", () =>
  withFetch(
    () => jsonResponse([]),
    async (calls) => {
      assert.equal(await supabase.stripeSubscriptionReplica(""), null);
      assert.equal(await supabase.stripeSubscriptionReplica("x".repeat(256)), null);
      assert.equal(calls.length, 0);

      await supabase.stripeSubscriptionReplica("x".repeat(255));
      assert.equal(calls.length, 1, "exactly 255 characters is still a legal id, not one past the limit");
    },
  ));

test("stripeSubscriptionReplica insists on every required column before trusting a row", async () => {
  const full = {
    id: "row-1", user_id: USER, status: "active", tier: "ai",
    external_subscription_id: "sub_1", verified_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  for (const key of Object.keys(full)) {
    const broken = { ...full, [key]: "" };
    await withFetch(() => jsonResponse([broken]), async () => {
      assert.equal(await supabase.stripeSubscriptionReplica("sub_1"), null, `missing ${key} must fail closed`);
    });
  }
  await withFetch(
    // An empty string, not merely a missing customer id: distinguishes "no
    // content" (still null) from "any string passes, including one with no
    // characters" (which would leak an empty-but-truthy customerId).
    () => jsonResponse([{ ...full, external_customer_id: "", cancel_at_period_end: true }]),
    async (calls) => {
      const replica = await supabase.stripeSubscriptionReplica("sub_1");
      assert.equal(replica.id, "row-1");
      assert.equal(replica.cancelAtPeriodEnd, true);
      assert.equal(replica.customerId, null);
      assert.equal(
        calls[0].url,
        "https://project.supabase.test/rest/v1/subscriptions?provider=eq.stripe" +
          "&external_subscription_id=eq.sub_1" +
          "&select=id,user_id,status,tier,external_customer_id,external_subscription_id," +
          "external_price_id,current_period_end,cancel_at_period_end,provider_event_at," +
          "verified_at,raw,created_at,updated_at&limit=1",
      );
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].headers.apikey, "service-role-key");
    },
  );
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.stripeSubscriptionReplica("sub_1"), null);
  });
});

/* ===========================================================================
   The promotional Pro trial
   =========================================================================== */

test("promoProviderAllowed asks by attempting a doomed insert, and cleans up if it is not doomed after all", () =>
  withFetch(
    (call) => (call.method === "POST" && call.url.endsWith("/rest/v1/subscriptions")
      ? jsonResponse({ id: "stray" })
      : jsonResponse({})),
    async (calls) => {
      const allowed = await supabase.promoProviderAllowed();
      assert.equal(allowed, true);
      assert.equal(calls.length, 2, "an unexpectedly-accepted probe row must be deleted again");
      assert.deepEqual(body(calls[0]), {
        user_id: "00000000-0000-0000-0000-000000000000", provider: "promo", status: "active", tier: "ai",
      });
      assert.equal(calls[1].method, "DELETE");
      assert.match(calls[1].url, /user_id=eq\.00000000-0000-0000-0000-000000000000&provider=eq\.promo/);
    },
  ));

test("promoProviderAllowed reads the constraint violation code, and only that code, as 'the ALTER has run'", async () => {
  await withFetch(() => jsonResponse({ code: "23503" }, 409), async () => {
    assert.equal(await supabase.promoProviderAllowed(), true);
  });
  await withFetch(() => jsonResponse({ code: "23514" }, 400), async () => {
    assert.equal(await supabase.promoProviderAllowed(), false);
  });
  await withFetch(() => jsonResponse({ code: "99999" }, 400), async () => {
    assert.equal(await supabase.promoProviderAllowed(), false);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.promoProviderAllowed(), false);
  });
});

test("promoSubscriptionState never trusts an id that is not a uuid, and reads no rows as 'none'", () =>
  withFetch(
    () => jsonResponse([]),
    async (calls) => {
      assert.equal(await supabase.promoSubscriptionState(NOT_A_UUID), "none");
      assert.equal(calls.length, 0);
      assert.equal(await supabase.promoSubscriptionState(USER), "none");
    },
  ));

test("promoSubscriptionState treats one canceled row as ending the offer, even alongside a live one", () =>
  withFetch(
    () => jsonResponse([{ status: "active" }, { status: "canceled" }]),
    async () => {
      assert.equal(await supabase.promoSubscriptionState(USER), "ended");
    },
  ));

test("promoSubscriptionState distinguishes holding, released and a failed lookup", async () => {
  await withFetch(() => jsonResponse([{ status: "paused" }]), async () => {
    assert.equal(await supabase.promoSubscriptionState(USER), "released");
  });
  await withFetch(() => jsonResponse([{ status: "trialing" }, { status: "paused" }]), async () => {
    assert.equal(await supabase.promoSubscriptionState(USER), "holding");
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    await assert.rejects(() => supabase.promoSubscriptionState(USER), /promo lookup failed with 500/);
  });
});

test("releasePromoSubscription only ever targets a live row, and reports what actually happened", async () => {
  assert.equal(await supabase.releasePromoSubscription(NOT_A_UUID), "failed");

  await withFetch(
    () => jsonResponse([{ status: "paused" }]),
    async (calls) => {
      assert.equal(await supabase.releasePromoSubscription(USER), "changed");
      assert.equal(calls[0].method, "PATCH");
      assert.equal(calls[0].headers.prefer, "return=representation");
      assert.match(calls[0].url, /provider=eq\.promo&status=in\.\(active,trialing\)/);
      assert.deepEqual(body(calls[0]), { status: "paused" });
    },
  );
  await withFetch(() => jsonResponse([]), async () => {
    assert.equal(await supabase.releasePromoSubscription(USER), "no-match");
  });
  await withFetch(() => jsonResponse({ code: "23514" }, 400), async () => {
    assert.equal(await supabase.releasePromoSubscription(USER), "unsupported");
  });
  await withFetch(() => jsonResponse({ message: "new row violates subscriptions_status_check" }, 400), async () => {
    assert.equal(await supabase.releasePromoSubscription(USER), "unsupported");
  });
  await withFetch(() => jsonResponse({ code: "other" }, 400), async () => {
    assert.equal(await supabase.releasePromoSubscription(USER), "failed");
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.releasePromoSubscription(USER), "failed");
  });
});

test("resumePromoSubscription only ever targets a released row, and re-dates the raw record it restarts", () =>
  withFetch(
    () => jsonResponse([{ status: "active" }]),
    async (calls) => {
      const before = Date.now();
      assert.equal(await supabase.resumePromoSubscription(USER), "changed");
      assert.match(calls[0].url, /provider=eq\.promo&status=eq\.paused/);
      const sent = body(calls[0]);
      assert.equal(sent.status, "active");
      assert.equal(sent.raw.kind, "free-ai-trial");
      assert.equal(sent.raw.restarted, true);
      assert.ok(Date.parse(sent.raw.acceptedAt) >= before);
    },
  ));

test("insertPromoSubscription refuses a bad id, writes the fixed trial row, and reads the constraint back honestly", async () => {
  assert.equal(await supabase.insertPromoSubscription(NOT_A_UUID), "failed");

  await withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.equal(await supabase.insertPromoSubscription(USER), "inserted");
      const sent = body(calls[0]);
      assert.equal(sent.user_id, USER);
      assert.equal(sent.provider, "promo");
      assert.equal(sent.status, "active");
      assert.equal(sent.tier, "ai");
      assert.equal(sent.current_period_end, null);
      assert.equal(sent.raw.kind, "free-ai-trial");
    },
  );
  await withFetch(() => jsonResponse({ code: "23514" }, 400), async () => {
    assert.equal(await supabase.insertPromoSubscription(USER), "unsupported");
  });
  await withFetch(() => jsonResponse({ message: "violates subscriptions_provider_check" }, 400), async () => {
    assert.equal(await supabase.insertPromoSubscription(USER), "unsupported");
  });
  await withFetch(() => jsonResponse({ code: "23505" }, 409), async () => {
    assert.equal(await supabase.insertPromoSubscription(USER), "exists");
  });
  await withFetch(() => jsonResponse({ code: "other" }, 400), async () => {
    assert.equal(await supabase.insertPromoSubscription(USER), "failed");
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.insertPromoSubscription(USER), "failed");
  });
});

test("promoSubscriptionReplica refuses a bad id and every row missing a required column", async () => {
  assert.equal(await supabase.promoSubscriptionReplica(NOT_A_UUID), null);

  const full = {
    id: "row-1", user_id: USER, status: "active", tier: "ai",
    current_period_end: null, raw: { kind: "free-ai-trial" },
    verified_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  for (const key of ["id", "user_id", "status", "tier", "verified_at", "created_at", "updated_at"]) {
    const broken = { ...full, [key]: "" };
    await withFetch(() => jsonResponse([broken]), async () => {
      assert.equal(await supabase.promoSubscriptionReplica(USER), null, `missing ${key} must fail closed`);
    });
  }
  await withFetch(
    // An empty string, not merely `null`, for current_period_end: distinguishes
    // "no content" (still null on the way out) from "any string, including one
    // with no characters, passes through".
    () => jsonResponse([{ ...full, current_period_end: "" }]),
    async (calls) => {
      const replica = await supabase.promoSubscriptionReplica(USER);
      assert.equal(replica.id, "row-1");
      assert.equal(replica.currentPeriodEnd, null);
      assert.equal(
        calls[0].url,
        `https://project.supabase.test/rest/v1/subscriptions?user_id=eq.${USER}&provider=eq.promo` +
          "&select=id,user_id,status,tier,current_period_end,raw,verified_at,created_at,updated_at" +
          "&order=created_at.desc&limit=1",
      );
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].headers.apikey, "service-role-key");
    },
  );
  await withFetch(() => jsonResponse([full]), async () => {
    const replica = await supabase.promoSubscriptionReplica(USER);
    assert.equal(replica.id, "row-1");
    assert.equal(replica.currentPeriodEnd, null);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.promoSubscriptionReplica(USER), null);
  });
});

/* ===========================================================================
   Avatar storage
   =========================================================================== */

test("uploadAvatar posts the bytes to the caller's own path with a year-long, immutable cache header", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      const ok = await supabase.uploadAvatar(`${USER}/a.webp`, new ArrayBuffer(4), "image/webp");
      assert.equal(ok, true);
      assert.equal(calls[0].url, `https://project.supabase.test/storage/v1/object/avatars/${USER}/a.webp`);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].headers["content-type"], "image/webp");
      assert.equal(calls[0].headers["cache-control"], "max-age=31536000, immutable");
      assert.equal(calls[0].headers["x-upsert"], "true");
      assert.equal(calls[0].headers.apikey, "service-role-key");
    },
  ));

test("uploadAvatar reports false when unconfigured, refused or unreachable, without ever throwing", async () => {
  await withEnv({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }, async () => {
    assert.equal(await supabase.uploadAvatar("a/b.webp", new ArrayBuffer(1), "image/webp"), false);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.uploadAvatar("a/b.webp", new ArrayBuffer(1), "image/webp"), false);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.uploadAvatar("a/b.webp", new ArrayBuffer(1), "image/webp"), false);
  });
});

test("signedAvatarUrl accepts either spelling Supabase Storage uses, and rebuilds one absolute URL", async () => {
  await withFetch(() => jsonResponse({ signedURL: "/object/sign/avatars/a/b.webp?token=t" }), async () => {
    assert.equal(
      await supabase.signedAvatarUrl("a/b.webp"),
      "https://project.supabase.test/storage/v1/object/sign/avatars/a/b.webp?token=t",
    );
  });
  await withFetch(() => jsonResponse({ signedUrl: "/storage/v1/object/sign/avatars/a/b.webp?token=t2" }), async () => {
    assert.equal(
      await supabase.signedAvatarUrl("a/b.webp"),
      "https://project.supabase.test/storage/v1/object/sign/avatars/a/b.webp?token=t2",
    );
  });
  await withFetch(() => jsonResponse({}), async () => {
    assert.equal(await supabase.signedAvatarUrl("a/b.webp"), null);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.signedAvatarUrl("a/b.webp"), null);
  });
});

test("signedAvatarUrl sends the caller's expiry, defaulting to one hour", () =>
  withFetch(
    () => jsonResponse({ signedURL: "/x" }),
    async (calls) => {
      await supabase.signedAvatarUrl("a/b.webp");
      assert.deepEqual(body(calls[0]), { expiresIn: 3600 });

      calls.length = 0;
      await supabase.signedAvatarUrl("a/b.webp", 120);
      assert.deepEqual(body(calls[0]), { expiresIn: 120 });
    },
  ));

test("deleteAvatar issues a DELETE at the object path and reports Supabase's own answer", () =>
  withFetch(
    (call) => jsonResponse({}, call.url.includes("missing") ? 404 : 200),
    async (calls) => {
      assert.equal(await supabase.deleteAvatar(`${USER}/a.webp`), true);
      assert.equal(calls[0].method, "DELETE");
      assert.equal(calls[0].url, `https://project.supabase.test/storage/v1/object/avatars/${USER}/a.webp`);

      assert.equal(await supabase.deleteAvatar("missing/a.webp"), false);
    },
  ));

test("avatarPathPage only ever asks for profiles with a stored avatar, keyset-paged by id", () =>
  withFetch(
    () => jsonResponse([{ id: 5, avatar_path: 9 }]),
    async (calls) => {
      const firstPage = await supabase.avatarPathPage("", 50);
      assert.equal(
        calls[0].url,
        "https://project.supabase.test/rest/v1/profiles?select=id%2Cavatar_path&avatar_path=not.is.null&order=id&limit=50",
      );
      assert.deepEqual(firstPage, [{ userId: "5", avatarPath: "9" }]);

      calls.length = 0;
      await supabase.avatarPathPage("cursor-id", 10);
      assert.match(calls[0].url, /[?&]id=gt\.cursor-id(&|$)/);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].headers.apikey, "service-role-key");
    },
  ));

test("avatarPathPage throws rather than silently returning an empty page on a failed or malformed read", async () => {
  await withFetch(() => jsonResponse({}, 500), async () => {
    await assert.rejects(() => supabase.avatarPathPage("", 50), /avatar path page failed with 500/);
  });
  await withFetch(() => jsonResponse({ not: "an array" }), async () => {
    await assert.rejects(() => supabase.avatarPathPage("", 50), /avatar path page response is invalid/);
  });
});

test("downloadAvatarBytes refuses any path that does not sit inside the caller's own folder", () =>
  withFetch(
    () => new Response(new ArrayBuffer(4), { status: 200 }),
    async (calls) => {
      const badPaths = [
        // Long, but otherwise a perfectly normal two-part path — isolated from
        // the "at least two parts" and "owned by this user" checks below, so a
        // mutant that drops the length check specifically cannot hide behind
        // one of the others catching the same input for a different reason.
        `${USER}/${"a".repeat(500)}`,
        // No "/" at all: exactly one part, and that one part *is* the caller's
        // own id — isolated from the "owned by this user" check the same way.
        USER,
        "solo-segment",
        `${USER}/../secret.webp`,
        `${USER}/./a.webp`,
        `${USER}//a.webp`,
        `someone-else/a.webp`,
      ];
      for (const path of badPaths) {
        assert.equal(await supabase.downloadAvatarBytes(USER, path), null, path);
      }
      assert.equal(calls.length, 0, "an invalid path must never reach Supabase");

      // The length boundary itself: 500 characters, all told, is still allowed.
      const boundaryPath = `${USER}/${"a".repeat(500 - USER.length - 1)}`;
      assert.equal(boundaryPath.length, 500);
      const boundaryBytes = await supabase.downloadAvatarBytes(USER, boundaryPath);
      assert.ok(boundaryBytes instanceof Uint8Array, "exactly 500 characters must not be refused");

      calls.length = 0;
      const bytes = await supabase.downloadAvatarBytes(USER, `${USER}/a.webp`);
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(calls[0].url, `https://project.supabase.test/storage/v1/object/avatars/${USER}/a.webp`);
      assert.equal(calls[0].headers.apikey, "service-role-key", "the download is a service-role read, not an anonymous one");
    },
  ));

test("downloadAvatarBytes reports null rather than throwing for a missing object or an outage", async () => {
  await withFetch(() => jsonResponse({}, 404), async () => {
    assert.equal(await supabase.downloadAvatarBytes(USER, `${USER}/a.webp`), null);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.downloadAvatarBytes(USER, `${USER}/a.webp`), null);
  });
  await withEnv({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }, async () => {
    assert.equal(await supabase.downloadAvatarBytes(USER, `${USER}/a.webp`), null);
  });
});

/* ===========================================================================
   Account deletion
   =========================================================================== */

test("deleteAccount removes the stored avatar first, only when there is one to remove", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      await supabase.deleteAccount(USER, `${USER}/a.webp`);
      assert.equal(calls.length, 2, "an avatar path means a storage delete before the admin delete");
      assert.equal(calls[0].url, `https://project.supabase.test/storage/v1/object/avatars/${USER}/a.webp`);
      assert.equal(calls[1].url, `https://project.supabase.test/auth/v1/admin/users/${USER}`);
      assert.equal(calls[1].method, "DELETE");

      calls.length = 0;
      await supabase.deleteAccount(USER, null);
      assert.equal(calls.length, 1, "no avatar path means no storage call at all");
      assert.equal(calls[0].url, `https://project.supabase.test/auth/v1/admin/users/${USER}`);
    },
  ));

test("deleteAccount treats a 404 on the admin delete as already-deleted, not a failure", () =>
  withFetch(
    () => jsonResponse({}, 404),
    async () => {
      assert.equal(await supabase.deleteAccount(USER, null), true);
    },
  ));

test("deleteAccount reports false for an unconfigured backend, a real failure or an outage", async () => {
  await withEnv({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }, async () => {
    assert.equal(await supabase.deleteAccount(USER, null), false);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.deleteAccount(USER, null), false);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.deleteAccount(USER, null), false);
  });
});

test("supabaseAuthUserState refuses an unreasonable id, and otherwise trusts only a 404 as 'deleted'", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.equal(await supabase.supabaseAuthUserState(""), "unknown");
      assert.equal(await supabase.supabaseAuthUserState("x".repeat(81)), "unknown");
      assert.equal(calls.length, 0);

      await supabase.supabaseAuthUserState("x".repeat(80));
      assert.equal(calls.length, 1, "exactly 80 characters is still a legal id, not one past the limit");

      assert.equal(await supabase.supabaseAuthUserState(USER), "exists");
    },
  ));

test("supabaseAuthUserState reads a 404 as deleted, everything else unresolved as unknown, never a throw", async () => {
  await withFetch(() => jsonResponse({}, 404), async () => {
    assert.equal(await supabase.supabaseAuthUserState(USER), "deleted");
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.supabaseAuthUserState(USER), "unknown");
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.supabaseAuthUserState(USER), "unknown");
  });
});

/* ===========================================================================
   Native-auth cutover audit (owner-only, read-only, source evidence)
   =========================================================================== */

test("listSupabaseNativeIdentitySource counts every provider once and keeps only Google's identity fields", () =>
  withFetch(
    (call) => (call.url.includes("bandup_native_auth_accounts")
      ? jsonResponse([{ id: USER }, { id: null }])
      : jsonResponse([
        { provider: "google", auth_user_id: USER, identity_user_id: USER, provider_subject: "g-1", email: "A@Example.com", email_verified: true },
        { provider: "apple" },
        { provider: "email" },
        { provider: "saml-sso" },
        { provider: "" },
      ])),
    async () => {
      const source = await supabase.listSupabaseNativeIdentitySource();
      assert.deepEqual(source.accounts, [{ id: USER }, { id: null }]);
      assert.equal(source.googleIdentities.length, 1);
      assert.equal(source.googleIdentities[0].email, "a@example.com");
      assert.equal(source.googleIdentities[0].emailVerified, true);
      assert.deepEqual(source.providerSummary, { google: 1, apple: 1, email: 1, unsupported: 1, invalid: 1 });
    },
  ));

test("listSupabaseNativeIdentitySource throws rather than guessing when either source RPC fails", async () => {
  await withFetch((call) => jsonResponse({}, call.url.includes("identities") ? 500 : 200), async () => {
    await assert.rejects(
      () => supabase.listSupabaseNativeIdentitySource(),
      /native identity source RPC bandup_native_auth_identities failed with 500/,
    );
  });
  await withFetch(() => jsonResponse({ not: "an array" }), async () => {
    await assert.rejects(() => supabase.listSupabaseNativeIdentitySource(), /was invalid/);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    await assert.rejects(() => supabase.listSupabaseNativeIdentitySource(), /was not JSON/);
  });
});

test("the shared nullableString bound trims an over-long field to null at its own limit, not one either side of it", () =>
  withFetch(
    (call) => (call.url.includes("bandup_native_auth_accounts")
      ? jsonResponse([])
      : jsonResponse([
        {
          provider: "google",
          auth_user_id: "a".repeat(80),
          identity_user_id: "b".repeat(81),
          provider_subject: "c".repeat(255),
          email: "",
        },
        {
          provider: "google",
          auth_user_id: "d".repeat(81),
          identity_user_id: "e".repeat(80),
          provider_subject: "f".repeat(256),
          email: "kept@example.test",
        },
      ])),
    async () => {
      const source = await supabase.listSupabaseNativeIdentitySource();
      assert.equal(source.googleIdentities.length, 2);
      const [first, second] = source.googleIdentities;
      // Exactly at the limit survives; the field is empty, not merely unset.
      assert.equal(first.authUserId, "a".repeat(80));
      assert.equal(first.identityUserId, null, "81 characters is one past identity_user_id's limit");
      assert.equal(first.providerSubject, "c".repeat(255));
      assert.equal(first.email, null, "an empty string has no content to keep");
      // One character over the limit is dropped; a normal value still comes through.
      assert.equal(second.authUserId, null, "81 characters is one past auth_user_id's limit");
      assert.equal(second.identityUserId, "e".repeat(80));
      assert.equal(second.providerSubject, null, "256 characters is one past provider_subject's limit");
      assert.equal(second.email, "kept@example.test");
    },
  ));

test("listSupabaseAuthAccounts eventually gives up rather than paging Supabase Auth forever", () =>
  withFetch(
    () => jsonResponse({ users: Array.from({ length: 200 }, () => ({ id: USER })) }),
    async (calls) => {
      await assert.rejects(
        () => supabase.listSupabaseAuthAccounts(),
        /admin Auth user pagination exceeded its safety limit/,
      );
      assert.equal(calls.length, 2000, "the safety limit itself is part of the contract being tested");
    },
  ));

test("listSupabaseGoogleIdentities pages by 200, stops on a short page, and keeps only Google links", () =>
  withFetch(
    () => jsonResponse({
      users: [{
        id: USER, email: "OWNER@example.com", email_confirmed_at: "2026-01-01T00:00:00Z",
        identities: [
          { provider: "google", user_id: USER, provider_id: "g-9", email: null, identity_data: { email_verified: false } },
          { provider: "apple", user_id: USER },
        ],
      }],
    }),
    async (calls) => {
      const identities = await supabase.listSupabaseGoogleIdentities();
      assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/admin/users?page=1&per_page=200");
      assert.equal(identities.length, 1);
      assert.deepEqual(identities[0], {
        authUserId: USER, identityUserId: USER, providerSubject: "g-9",
        email: "owner@example.com", emailVerified: true,
      });
    },
  ));

test("listSupabaseGoogleIdentities continues past a full page and stops at the next short one", () =>
  withFetch(
    (call) => {
      const users = pageOf(call.url) === "2"
        ? [{ id: "u-201", identities: [] }]
        : Array.from({ length: 200 }, (_, i) => ({ id: `u-${i}`, identities: [] }));
      return jsonResponse({ users });
    },
    async (calls) => {
      await supabase.listSupabaseGoogleIdentities();
      assert.equal(calls.length, 2, "a full first page must not be treated as the end");
      assert.equal(calls[1].url, "https://project.supabase.test/auth/v1/admin/users?page=2&per_page=200");
    },
  ));

test("listSupabaseGoogleIdentities refuses to guess when Supabase cannot say whether identities exist", async () => {
  await withFetch(() => jsonResponse({ users: [{ id: USER, identities: null }] }), async () => {
    await assert.rejects(() => supabase.listSupabaseGoogleIdentities(), /identity details are unavailable/);
  });
  await withFetch(() => jsonResponse({ users: [{ id: USER, identities: "nope" }] }), async () => {
    await assert.rejects(() => supabase.listSupabaseGoogleIdentities(), /identity details were invalid/);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    await assert.rejects(() => supabase.listSupabaseGoogleIdentities(), /admin Auth user page failed with 500/);
  });
  await withFetch(() => jsonResponse({ nope: true }), async () => {
    await assert.rejects(() => supabase.listSupabaseGoogleIdentities(), /admin Auth user page was invalid/);
  });
});

test("listSupabaseAuthAccounts lists only stable ids, in the same paginated shape", () =>
  withFetch(
    () => jsonResponse({ users: [{ id: USER }, { id: "" }, null] }),
    async () => {
      const accounts = await supabase.listSupabaseAuthAccounts();
      assert.deepEqual(accounts, [{ id: USER }, { id: null }, { id: null }]);
    },
  ));

test("listSupabaseAuthAccounts stops paging on the first page shorter than a full one", () =>
  withFetch(
    (call) => jsonResponse({ users: pageOf(call.url) === "2" ? [] : Array.from({ length: 200 }, () => ({ id: USER })) }),
    async (calls) => {
      const accounts = await supabase.listSupabaseAuthAccounts();
      assert.equal(calls.length, 2);
      assert.equal(accounts.length, 200);
    },
  ));

test("listSupabaseAuthProviderSummary counts by provider, including the unsupported/invalid boundary at 80 characters", async () => {
  await withFetch(
    () => jsonResponse({
      users: [{
        id: USER,
        identities: [
          { provider: "google" }, { provider: "apple" }, { provider: "email" },
          { provider: "x".repeat(80) }, { provider: "x".repeat(81) }, { provider: null },
        ],
      }],
    }),
    async () => {
      const summary = await supabase.listSupabaseAuthProviderSummary();
      assert.deepEqual(summary, { google: 1, apple: 1, email: 1, unsupported: 1, invalid: 2 });
    },
  );
  await withFetch(() => jsonResponse({ users: [{ id: USER }] }), async () => {
    await assert.rejects(() => supabase.listSupabaseAuthProviderSummary(), /identity details are unavailable/);
  });
});

test("listSupabaseAuthProviderSummary continues past a full page, and refuses to trust a malformed one", async () => {
  await withFetch(
    (call) => {
      const users = pageOf(call.url) === "2"
        ? [{ id: "last", identities: [{ provider: "apple" }] }]
        : Array.from({ length: 200 }, () => ({ id: USER, identities: [{ provider: "google" }] }));
      return jsonResponse({ users });
    },
    async (calls) => {
      const summary = await supabase.listSupabaseAuthProviderSummary();
      assert.equal(calls.length, 2, "a full first page must not be treated as the end");
      assert.deepEqual(summary, { google: 200, apple: 1, email: 0, unsupported: 0, invalid: 0 });
    },
  );
  await withFetch(() => jsonResponse({}, 500), async () => {
    await assert.rejects(() => supabase.listSupabaseAuthProviderSummary(), /admin Auth user page failed with 500/);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    await assert.rejects(() => supabase.listSupabaseAuthProviderSummary(), /admin Auth user page was not JSON/);
  });
  await withFetch(() => jsonResponse({ nope: true }), async () => {
    await assert.rejects(() => supabase.listSupabaseAuthProviderSummary(), /admin Auth user page was invalid/);
  });
});

test("the two Supabase Auth cutover listings agree on when a page is the last one", () =>
  withFetch(
    (call) => jsonResponse({ users: pageOf(call.url) === "2" ? [{ id: "last" }] : Array.from({ length: 200 }, () => ({ id: USER })) }),
    async (calls) => {
      await supabase.listSupabaseAuthAccounts();
      assert.equal(calls.length, 2);
    },
  ));

/* ===========================================================================
   Stripe ledger cutover audit
   =========================================================================== */

test("listStripeCutoverSourceEvidence reads subscriptions and provider events with their own fixed shape, in parallel", () =>
  withFetch(
    () => jsonResponse([]),
    async (calls) => {
      await supabase.listStripeCutoverSourceEvidence();
      assert.equal(calls.length, 2);
      const subsCall = calls.find((c) => c.url.includes("/rest/v1/subscriptions"));
      const eventsCall = calls.find((c) => c.url.includes("/rest/v1/provider_events"));
      assert.match(subsCall.url, /select=id%2Cuser_id%2Cprovider%2Cexternal_price_id%2Cexternal_subscription_id/);
      assert.match(subsCall.url, /order=id\.asc/);
      assert.match(eventsCall.url, /select=provider%2Cevent_id%2Creceived_at%2Cpayload/);
      assert.match(eventsCall.url, /order=received_at\.asc%2Cevent_id\.asc/);
      assert.match(subsCall.url, /provider=eq\.stripe/);
      assert.match(eventsCall.url, /provider=eq\.stripe/);
    },
  ));

test("listStripeCutoverSourceEvidence pages by exactly 100 rows and stops on the first short page", () =>
  withFetch(
    (call) => {
      const offset = new URL(call.url).searchParams.get("offset");
      const full = offset === "0";
      return jsonResponse(full ? Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) : []);
    },
    async (calls) => {
      await supabase.listStripeCutoverSourceEvidence();
      // Two tables, two pages each: a full page 0 followed by an empty page 1.
      assert.equal(calls.length, 4);
      assert.ok(calls.some((c) => c.url.includes("offset=100")));
    },
  ));

test("listStripeCutoverSourceEvidence throws rather than silently trusting a malformed source page", async () => {
  await withFetch(() => jsonResponse({}, 500), async () => {
    await assert.rejects(() => supabase.listStripeCutoverSourceEvidence(), /source read failed with 500/);
  });
  await withFetch(() => jsonResponse([{ ok: true }, "not-an-object"]), async () => {
    await assert.rejects(() => supabase.listStripeCutoverSourceEvidence(), /source response was invalid/);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    await assert.rejects(() => supabase.listStripeCutoverSourceEvidence(), /source response was not JSON/);
  });
});

/* ===========================================================================
   Progress sync, and the Cloudflare drift-backfill reads
   =========================================================================== */

test("isProgressKey accepts only the three keys the schema itself allows", () => {
  assert.equal(supabase.isProgressKey("ielts-prep-v1"), true);
  assert.equal(supabase.isProgressKey("bandup.drills.v1"), true);
  assert.equal(supabase.isProgressKey("bandup.lookups.v1"), true);
  assert.equal(supabase.isProgressKey("ielts-prep-v2"), false);
  assert.equal(supabase.isProgressKey(42), false);
  assert.equal(supabase.isProgressKey(null), false);
});

test("getProgressSnapshots maps every row, and reads any failure as null rather than an empty list", async () => {
  await withFetch(
    () => jsonResponse([{ store_key: "ielts-prep-v1", payload: { a: 1 }, client_updated_at: "2026-01-01T00:00:00Z" }, { payload: null }]),
    async (calls) => {
      const snapshots = await supabase.getProgressSnapshots(USER);
      assert.equal(calls[0].url, `https://project.supabase.test/rest/v1/progress_snapshots?user_id=eq.${USER}&select=store_key,payload,client_updated_at`);
      assert.deepEqual(snapshots[0], { storeKey: "ielts-prep-v1", payload: { a: 1 }, clientUpdatedAt: "2026-01-01T00:00:00Z" });
      assert.deepEqual(snapshots[1], { storeKey: "", payload: null, clientUpdatedAt: null });
    },
  );
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.getProgressSnapshots(USER), null);
  });
  await withFetch(() => jsonResponse({ not: "an array" }), async () => {
    assert.equal(await supabase.getProgressSnapshots(USER), null);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.getProgressSnapshots(USER), null);
  });
});

test("cloudflareBackfillProgressSnapshotRow only accepts a real user id and one of the three known keys", () =>
  withFetch(
    () => jsonResponse([{ payload: { a: 1 }, updated_at: "2026-01-01T00:00:00Z" }]),
    async (calls) => {
      assert.equal(await supabase.cloudflareBackfillProgressSnapshotRow(NOT_A_UUID, "ielts-prep-v1"), null);
      assert.equal(await supabase.cloudflareBackfillProgressSnapshotRow(USER, "not-a-real-key"), null);
      assert.equal(calls.length, 0);

      const row = await supabase.cloudflareBackfillProgressSnapshotRow(USER, "ielts-prep-v1");
      assert.deepEqual(row, { userId: USER, storeKey: "ielts-prep-v1", payload: { a: 1 }, updatedAt: "2026-01-01T00:00:00Z" });
    },
  ));

test("cloudflareBackfillProgressSnapshotRow reads a bad row, a failed lookup and an outage all as null", async () => {
  await withFetch(() => jsonResponse([{ payload: {} }]), async () => {
    assert.equal(await supabase.cloudflareBackfillProgressSnapshotRow(USER, "ielts-prep-v1"), null);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.cloudflareBackfillProgressSnapshotRow(USER, "ielts-prep-v1"), null);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.cloudflareBackfillProgressSnapshotRow(USER, "ielts-prep-v1"), null);
  });
});

test("cloudflareBackfillUsageEventRow only accepts its own decimal id shape", () =>
  withFetch(
    () => jsonResponse([{ route: "chat", outcome: "allowed", created_at: "2026-01-01T00:00:00Z", user_id: USER, ip_hash: "h" }]),
    async (calls) => {
      for (const bad of ["", "12a", "x".repeat(21), "-5"]) {
        assert.equal(await supabase.cloudflareBackfillUsageEventRow(bad), null, bad);
      }
      assert.equal(calls.length, 0);

      const row = await supabase.cloudflareBackfillUsageEventRow("12345");
      assert.deepEqual(row, { id: "12345", userId: USER, route: "chat", ipHash: "h", outcome: "allowed", createdAt: "2026-01-01T00:00:00Z" });
    },
  ));

test("cloudflareBackfillUsageEventRow defaults an anonymous event's user and ip to null, not to a string", () =>
  withFetch(
    () => jsonResponse([{ route: "chat", outcome: "denied_quota", created_at: "2026-01-01T00:00:00Z" }]),
    async () => {
      const row = await supabase.cloudflareBackfillUsageEventRow("777");
      assert.equal(row.userId, null);
      assert.equal(row.ipHash, null);
    },
  ));

test("cloudflareBackfillAiCostEventRow treats a zero cost as a real value, never as missing", () =>
  withFetch(
    () => jsonResponse([{
      source: "calculated_tokens", cost_usd: 0, occurred_at: "2026-01-01T00:00:00Z", recorded_at: "2026-01-01T00:00:01Z",
      input_tokens: 10, output_tokens: "not-a-number",
    }]),
    async (calls) => {
      for (const bad of ["", "12a"]) assert.equal(await supabase.cloudflareBackfillAiCostEventRow(bad), null);
      assert.equal(calls.length, 0);

      const row = await supabase.cloudflareBackfillAiCostEventRow("42");
      assert.equal(row.costUsd, "0");
      assert.equal(row.inputTokens, 10);
      assert.equal(row.outputTokens, null);
    },
  ));

test("cloudflareBackfillAiCostEventRow refuses a row with no cost recorded at all", () =>
  withFetch(
    () => jsonResponse([{ source: "calculated_tokens", occurred_at: "2026-01-01T00:00:00Z", recorded_at: "2026-01-01T00:00:00Z" }]),
    async () => {
      assert.equal(await supabase.cloudflareBackfillAiCostEventRow("1"), null);
    },
  ));

test("cloudflareBackfillSubscriptionRow reads back whichever provider the row actually names", () =>
  withFetch(
    () => jsonResponse([{
      user_id: USER, provider: "apple", status: "active", tier: "ai",
      verified_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
      cancel_at_period_end: "true",
    }]),
    async (calls) => {
      assert.equal(await supabase.cloudflareBackfillSubscriptionRow(NOT_A_UUID), null);
      assert.equal(calls.length, 0);

      const row = await supabase.cloudflareBackfillSubscriptionRow(USER);
      assert.equal(row.provider, "apple");
      assert.equal(row.cancelAtPeriodEnd, false);
      assert.equal(row.customerId, null);
    },
  ));

test("deleteProgressSnapshots refuses any key outside the fixed set, and never writes a partial clear", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      const refused = await supabase.deleteProgressSnapshots(USER, ["ielts-prep-v1", "not-a-real-key"]);
      assert.equal(refused, false);
      assert.equal(calls.length, 0, "one bad key must block the whole request, not just be skipped");
    },
  ));

test("deleteProgressSnapshots with nothing to delete succeeds without a network call", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.equal(await supabase.deleteProgressSnapshots(USER, []), true);
      assert.equal(calls.length, 0);
    },
  ));

test("deleteProgressSnapshots deletes exactly the named keys for exactly this user", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      const ok = await supabase.deleteProgressSnapshots(USER, ["ielts-prep-v1", "bandup.drills.v1"]);
      assert.equal(ok, true);
      assert.equal(calls[0].method, "DELETE");
      assert.equal(
        calls[0].url,
        `https://project.supabase.test/rest/v1/progress_snapshots?user_id=eq.${USER}` +
          `&store_key=in.("ielts-prep-v1","bandup.drills.v1")`,
      );
    },
  ));

test("deleteProgressSnapshots reports false for a failed delete or an unreachable backend", async () => {
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.deleteProgressSnapshots(USER, ["ielts-prep-v1"]), false);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.deleteProgressSnapshots(USER, ["ielts-prep-v1"]), false);
  });
});

test("compareAndSwapProgressSnapshots reads a bare string or a wrapped row as the same committed timestamp", async () => {
  await withFetch(() => jsonResponse("2026-01-01T00:00:00Z"), async (calls) => {
    const result = await supabase.compareAndSwapProgressSnapshots(USER, [], []);
    assert.deepEqual(result, { status: "committed", at: "2026-01-01T00:00:00Z" });
    assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/compare_and_swap_progress_snapshots");
    assert.deepEqual(body(calls[0]), { p_user_id: USER, p_expected: [], p_snapshots: [] });
  });
  await withFetch(() => jsonResponse([{ compare_and_swap_progress_snapshots: "2026-02-01T00:00:00Z" }]), async () => {
    const result = await supabase.compareAndSwapProgressSnapshots(USER, [], []);
    assert.deepEqual(result, { status: "committed", at: "2026-02-01T00:00:00Z" });
  });
});

test("compareAndSwapProgressSnapshots reads either shape of a null answer as a conflict, not a success", async () => {
  await withFetch(() => jsonResponse(null), async () => {
    assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER, [], []), { status: "conflict" });
  });
  await withFetch(() => jsonResponse([{ compare_and_swap_progress_snapshots: null }]), async () => {
    assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER, [], []), { status: "conflict" });
  });
});

test("compareAndSwapProgressSnapshots reads anything else — a bad date, an empty array, a network failure — as unavailable", async () => {
  await withFetch(() => jsonResponse("not-a-real-date"), async () => {
    assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER, [], []), { status: "unavailable" });
  });
  await withFetch(() => jsonResponse([]), async () => {
    assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER, [], []), { status: "unavailable" });
  });
  await withFetch(() => jsonResponse(42), async () => {
    assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER, [], []), { status: "unavailable" });
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER, [], []), { status: "unavailable" });
  });
});

test("organizationHistoryClearPolicy tells a schema that has never heard of organizations apart from a real outage", async () => {
  await withFetch(() => jsonResponse({}, 404), async () => {
    assert.equal(await supabase.organizationHistoryClearPolicy(USER), "not-installed");
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.equal(await supabase.organizationHistoryClearPolicy(USER), "unavailable");
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.organizationHistoryClearPolicy(USER), "unavailable");
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    assert.equal(await supabase.organizationHistoryClearPolicy(USER), "unavailable");
  });
});

test("organizationHistoryClearPolicy restricts the clear only when an active membership row actually exists", () =>
  withFetch(
    (call) => jsonResponse(call.url.includes("restricted-user") ? [{ id: "m-1" }] : []),
    async (calls) => {
      assert.equal(await supabase.organizationHistoryClearPolicy("restricted-user"), "restricted");
      assert.equal(await supabase.organizationHistoryClearPolicy(USER), "allowed");
      assert.match(calls[0].url, /role=eq\.student&status=in\.\(active,leave_requested,suspended\)/);
    },
  ));

/* ===========================================================================
   Sessions: refresh, password sign-in, Google ID token, sign-up, token lookup
   =========================================================================== */

test("refreshAccessToken refuses an unreasonable token before ever calling Supabase", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.equal(await supabase.refreshAccessToken(""), null);
      assert.equal(await supabase.refreshAccessToken("x".repeat(4097)), null);
      assert.equal(calls.length, 0);

      await supabase.refreshAccessToken("x".repeat(4096));
      assert.equal(calls.length, 1, "exactly 4096 characters is still a legal token, not one past the limit");
    },
  ));

test("refreshAccessToken posts the grant type and refresh token, and maps every optional field honestly", () =>
  withFetch(
    () => jsonResponse({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600, user: { email: "a@example.test" } }),
    async (calls) => {
      const session = await supabase.refreshAccessToken("old-refresh");
      assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/token?grant_type=refresh_token");
      assert.deepEqual(body(calls[0]), { refresh_token: "old-refresh" });
      assert.deepEqual(session, { accessToken: "new-token", refreshToken: "new-refresh", expiresIn: 3600, email: "a@example.test" });
    },
  ));

test("refreshAccessToken returns null for a spent token, a network failure, or a body with no access token", async () => {
  await withFetch(() => jsonResponse({}, 400), async () => {
    assert.equal(await supabase.refreshAccessToken("dead-token"), null);
  });
  await withFetch(() => jsonResponse({ access_token: "" }), async () => {
    assert.equal(await supabase.refreshAccessToken("token"), null);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    assert.equal(await supabase.refreshAccessToken("token"), null);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.refreshAccessToken("token"), null);
  });
});

test("signInWithPassword bounds both fields before spending any bcrypt cost on them", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.equal(await supabase.signInWithPassword("", "pw"), null);
      assert.equal(await supabase.signInWithPassword("a@example.test", ""), null);
      assert.equal(await supabase.signInWithPassword(`${"a".repeat(250)}@x.io`, "pw"), null);
      assert.equal(await supabase.signInWithPassword("a@example.test", "p".repeat(201)), null);
      assert.equal(calls.length, 0, "an out-of-bounds field must never reach GoTrue at all");

      // The boundary itself: exactly 254 and exactly 200 characters both go through.
      const boundaryEmail = `${"a".repeat(249)}@x.io`;
      assert.equal(boundaryEmail.length, 254);
      await supabase.signInWithPassword(boundaryEmail, "p".repeat(200));
      assert.equal(calls.length, 1, "254 characters is still a legal email, not one past the limit");
    },
  ));

test("signInWithPassword posts exactly the email and password, and never reveals which part was wrong", () =>
  withFetch(
    (call) => jsonResponse({}, call.url.includes("grant_type=password") ? 400 : 500),
    async (calls) => {
      assert.equal(await supabase.signInWithPassword("a@example.test", "wrong"), null);
      assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/token?grant_type=password");
      assert.deepEqual(body(calls[0]), { email: "a@example.test", password: "wrong" });
    },
  ));

test("signInWithPassword maps a genuine session through, and null for one Supabase does not send an access token for", async () => {
  await withFetch(() => jsonResponse({ access_token: "t", refresh_token: "r", expires_in: 10, user: { email: "a@x.io" } }), async () => {
    assert.deepEqual(await supabase.signInWithPassword("a@x.io", "pw"), { accessToken: "t", refreshToken: "r", expiresIn: 10, email: "a@x.io" });
  });
  await withFetch(() => jsonResponse({}), async () => {
    assert.equal(await supabase.signInWithPassword("a@x.io", "pw"), null);
  });
});

test("signInWithGoogleIdToken bounds the token and nonce, and posts them alongside the fixed provider name", () =>
  withFetch(
    () => jsonResponse({ access_token: "t" }),
    async (calls) => {
      assert.equal(await supabase.signInWithGoogleIdToken("", "nonce"), null);
      assert.equal(await supabase.signInWithGoogleIdToken("tok", ""), null);
      assert.equal(await supabase.signInWithGoogleIdToken("x".repeat(16_385), "nonce"), null);
      assert.equal(await supabase.signInWithGoogleIdToken("tok", "x".repeat(257)), null);
      assert.equal(calls.length, 0);

      await supabase.signInWithGoogleIdToken("x".repeat(16_384), "x".repeat(256));
      assert.equal(calls.length, 1, "16384/256 characters are still legal, not one past either limit");
      calls.length = 0;

      await supabase.signInWithGoogleIdToken("id-tok", "nonce-1");
      assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/token?grant_type=id_token");
      assert.deepEqual(body(calls[0]), { provider: "google", id_token: "id-tok", nonce: "nonce-1" });
    },
  ));

test("signInWithGoogleIdToken returns null for a rejected credential without ever throwing", async () => {
  await withFetch(() => jsonResponse({}, 400), async () => {
    assert.equal(await supabase.signInWithGoogleIdToken("tok", "nonce"), null);
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.equal(await supabase.signInWithGoogleIdToken("tok", "nonce"), null);
  });
});

test("signUpWithPassword bounds its two fields the same way sign-in does", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.deepEqual(await supabase.signUpWithPassword("", "pw", "https://bandup.life/cb"), { outcome: "failed", session: null });
      assert.deepEqual(await supabase.signUpWithPassword("a@x.io", "", "https://bandup.life/cb"), { outcome: "failed", session: null });
      assert.deepEqual(
        await supabase.signUpWithPassword(`${"a".repeat(251)}@x.io`, "pw", "https://bandup.life/cb"),
        { outcome: "failed", session: null },
      );
      assert.deepEqual(
        await supabase.signUpWithPassword("a@x.io", "p".repeat(201), "https://bandup.life/cb"),
        { outcome: "failed", session: null },
      );
      assert.equal(calls.length, 0);

      // The boundary itself: exactly 254 and exactly 200 characters both go through.
      const boundaryEmail = `${"a".repeat(249)}@x.io`;
      assert.equal(boundaryEmail.length, 254);
      await supabase.signUpWithPassword(boundaryEmail, "p".repeat(200), "https://bandup.life/cb");
      assert.equal(calls.length, 1, "254/200 characters are still legal, not one past the limit");
    },
  ));

test("signUpWithPassword sends the redirect inside options, and reports which kind of rejection GoTrue gave", async () => {
  await withFetch(
    () => jsonResponse({ error_code: "weak_password" }, 400),
    async (calls) => {
      const result = await supabase.signUpWithPassword("a@x.io", "weak", "https://bandup.life/cb");
      assert.deepEqual(result, { outcome: "weak", session: null });
      assert.deepEqual(body(calls[0]), { email: "a@x.io", password: "weak", options: { emailRedirectTo: "https://bandup.life/cb" } });
    },
  );
  await withFetch(() => jsonResponse({}, 422), async () => {
    assert.deepEqual(await supabase.signUpWithPassword("a@x.io", "pw", "https://bandup.life/cb"), { outcome: "taken", session: null });
  });
  await withFetch(() => jsonResponse({}, 400), async () => {
    assert.deepEqual(await supabase.signUpWithPassword("a@x.io", "pw", "https://bandup.life/cb"), { outcome: "taken", session: null });
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    assert.deepEqual(await supabase.signUpWithPassword("a@x.io", "pw", "https://bandup.life/cb"), { outcome: "failed", session: null });
  });
  await withFetch(() => { throw new TypeError("down"); }, async () => {
    assert.deepEqual(await supabase.signUpWithPassword("a@x.io", "pw", "https://bandup.life/cb"), { outcome: "failed", session: null });
  });
});

test("signUpWithPassword reports the session immediately when GoTrue skips confirmation, and 'confirm' when it does not", async () => {
  await withFetch(() => jsonResponse({ access_token: "t", refresh_token: "r", expires_in: 5, user: { email: "a@x.io" } }), async () => {
    const result = await supabase.signUpWithPassword("a@x.io", "pw", "https://bandup.life/cb");
    assert.deepEqual(result, { outcome: "session", session: { accessToken: "t", refreshToken: "r", expiresIn: 5, email: "a@x.io" } });
  });
  await withFetch(() => jsonResponse({ id: "user-with-no-session-yet" }), async () => {
    assert.deepEqual(await supabase.signUpWithPassword("a@x.io", "pw", "https://bandup.life/cb"), { outcome: "confirm", session: null });
  });
});

test("userFromAccessToken refuses an unreasonable token before ever calling Supabase", () =>
  withFetch(
    () => jsonResponse({}),
    async (calls) => {
      assert.equal(await supabase.userFromAccessToken(""), null);
      assert.equal(await supabase.userFromAccessToken("x".repeat(4097)), null);
      assert.equal(calls.length, 0);

      await supabase.userFromAccessToken("x".repeat(4096)).catch(() => {});
      assert.equal(calls.length, 1, "exactly 4096 characters is still a legal token, not one past the limit");
    },
  ));

test("userFromAccessToken reads both 401 and 403 as not-signed-in, and nothing else as that", async () => {
  await withFetch(() => jsonResponse({}, 401), async () => {
    assert.equal(await supabase.userFromAccessToken("t"), null);
  });
  await withFetch(() => jsonResponse({}, 403), async () => {
    assert.equal(await supabase.userFromAccessToken("t"), null);
  });
  await withFetch(() => jsonResponse({}, 500), async () => {
    await assert.rejects(() => supabase.userFromAccessToken("t"), /auth\/v1\/user failed with 500/);
  });
});

test("userFromAccessToken names the failure kind when GoTrue cannot be reached or answers with junk", async () => {
  await withFetch(() => { throw new TypeError("fetch failed"); }, async () => {
    await assert.rejects(() => supabase.userFromAccessToken("t"), /auth\/v1\/user unreachable: TypeError/);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    await assert.rejects(() => supabase.userFromAccessToken("t"), /returned a body that was not JSON/);
  });
});

test("userFromAccessToken treats an empty id the same as no id, and maps a real user through in full", async () => {
  await withFetch(() => jsonResponse({ id: "", email: "a@x.io" }), async () => {
    assert.equal(await supabase.userFromAccessToken("t"), null);
  });
  await withFetch(() => jsonResponse({ id: USER, email: "a@x.io", created_at: "2026-01-01T00:00:00Z" }), async (calls) => {
    const user = await supabase.userFromAccessToken("t");
    assert.deepEqual(user, { id: USER, email: "a@x.io", createdAt: "2026-01-01T00:00:00Z" });
    assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/user");
    assert.equal(calls[0].headers.authorization, "Bearer t");
  });
});
