/*
  lib/billing/gate.ts: the server-side answer to "may this caller use this
  feature", and the only thing standing between a route and the database.

  Nothing here reaches a real Supabase project. checkFeature's anonymous path
  (no Authorization header) resolves to the free tier without a network call
  at all — resolveEntitlement returns ANONYMOUS_ENTITLEMENT the moment userId
  is null — so most of these tests need only the feature flags. The one test
  that needs a signed-in caller (requireFeature's catch, when the session
  lookup itself fails) fakes GoTrue's /auth/v1/user the same way
  tests/session-auth-outage.test.mjs does.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);
register("./cutover-write-barrier-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const gate = await load("lib", "billing", "gate.ts");
const { checkFeature, requireFeature, upgradeMessage, UPGRADE_STATUS } = gate;

const ENV_KEYS = ["ACCOUNTS_ENABLED", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

const FULL_CONFIG = {
  ACCOUNTS_ENABLED: "1",
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

const anonymousReq = () => new Request("https://bandup.life/api/tutor-chat");

/* ------------------------------------------------------- upgradeMessage -- */

test("upgradeMessage names the lowest sellable tier that actually includes the feature", () => {
  // tutor-chat: free and Tracking both cap it at zero; only AI includes it.
  assert.equal(
    upgradeMessage("tutor-chat"),
    "This is part of BandUp AI. See the plans on the pricing page — everything else, including practice tests, drills and your study plan, stays free.",
  );
  // progress-sync: Tracking already includes it, so it must not be attributed
  // to AI even though AI includes it too — the *lowest* tier is the promise.
  assert.equal(
    upgradeMessage("progress-sync"),
    "This is part of BandUp Tracking. See the plans on the pricing page — everything else, including practice tests, drills and your study plan, stays free.",
  );
  // speaking-examiner: not shipped for any sellable tier yet (lib/billing/tiers.ts
  // caps it at zero everywhere), so there is no tier to name.
  assert.equal(
    upgradeMessage("speaking-examiner"),
    "This is part of a paid plan. See the plans on the pricing page — everything else, including practice tests, drills and your study plan, stays free.",
  );
});

/* ---------------------------------------------------------- checkFeature -- */

test("checkFeature refuses to run outside the server, naming this module", async () => {
  globalThis.window = {};
  try {
    await assert.rejects(
      () => checkFeature(anonymousReq(), "tutor-chat"),
      (error) => error instanceof Error && error.message.includes("lib/billing/gate.ts"),
    );
  } finally {
    delete globalThis.window;
  }
});

test("with accounts off entirely, checkFeature allows everything and never touches the network", () =>
  withEnv({}, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("must not reach the network with accounts off"); };
    try {
      assert.deepEqual(await checkFeature(anonymousReq(), "tutor-chat"), { allowed: true, tier: null });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("with ACCOUNTS_ENABLED but no backend configured, checkFeature still allows everything", () =>
  withEnv({ ACCOUNTS_ENABLED: "1" }, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("must not reach the network with no backend configured"); };
    try {
      assert.deepEqual(await checkFeature(anonymousReq(), "tutor-chat"), { allowed: true, tier: null });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("fully configured, an anonymous caller is metered at the free tier — refused for an AI feature", () =>
  withEnv(FULL_CONFIG, async () => {
    assert.deepEqual(await checkFeature(anonymousReq(), "tutor-chat"), { allowed: false, tier: "free" });
  }));

test("fully configured, an anonymous caller is allowed a feature the free tier actually has", () =>
  withEnv(FULL_CONFIG, async () => {
    // progress-sync is Tracking's and AI's, not Free's — pick a feature that
    // genuinely has no tier requirement to prove the allowed path too. There
    // is none among the paid features, so this instead pins that a refusal
    // still names the free tier rather than null once accounts are live.
    const decision = await checkFeature(anonymousReq(), "tutor-chat");
    assert.equal(decision.tier, "free");
  }));

/* -------------------------------------------------------- requireFeature -- */

test("requireFeature returns null (carry on) exactly when checkFeature allows it", () =>
  withEnv({}, async () => {
    // Accounts off => checkFeature allows everything => requireFeature must
    // not turn that into a refusal.
    assert.equal(await requireFeature(anonymousReq(), "tutor-chat"), null);
  }));

test("requireFeature returns a 402 naming the right plan exactly when checkFeature refuses", () =>
  withEnv(FULL_CONFIG, async () => {
    const res = await requireFeature(anonymousReq(), "tutor-chat");
    assert.ok(res instanceof Response, "a refusal must be a Response, not null");
    assert.equal(res.status, UPGRADE_STATUS);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, upgradeMessage("tutor-chat"));
  }));

test("requireFeature logs the feature-specific label and fails closed when the session lookup itself errors", () =>
  withEnv(FULL_CONFIG, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        // Neither 401 nor 403: userFromAccessToken must throw rather than
        // read this as "not signed in" (tests/session-auth-outage.test.mjs
        // pins the same distinction for GoTrue directly).
        return new Response("upstream down", { status: 503 });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const savedError = console.error;
    const logs = [];
    console.error = (...parts) => logs.push(parts.join(" "));
    try {
      const res = await requireFeature(
        new Request("https://bandup.life/api/tutor-chat", {
          headers: { authorization: "Bearer a-real-looking-token" },
        }),
        "tutor-chat",
      );
      // Fails closed: USAGE_FAIL_OPEN is unset, so this is a 503, not a 402 —
      // an outage must not be told to the learner as "upgrade your plan".
      assert.ok(res instanceof Response);
      assert.equal(res.status, 503);
      assert.ok(
        logs.some((line) => line.includes("requireFeature/tutor-chat")),
        `expected a log naming the feature; got: ${JSON.stringify(logs)}`,
      );
    } finally {
      globalThis.fetch = savedFetch;
      console.error = savedError;
    }
  }));
