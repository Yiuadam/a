import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const dataRouter = await load("lib", "cloudflare", "data-router.ts");
const subscriptions = await load("lib", "billing", "subscriptions.ts");

const USER = {
  id: "499f408e-a012-48a0-ab0d-7aa1f7ca103b",
  email: "learner@example.test",
};

const ENVIRONMENT_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "CLOUDFLARE_DATA_MODE",
  "ORGANIZATION_DATA_MODE",
];

async function withEnvironment(values, fetchImpl, run) {
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-stub-key",
    SUPABASE_ANON_KEY: "anon-stub-key",
    CLOUDFLARE_DATA_MODE: "supabase",
    ...values,
  });
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of ENVIRONMENT_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("organization cutover mirrors the current Supabase profile without weakening the primary", async () => {
  for (const organizationMode of ["dual", "cloudflare"]) {
    const calls = [];
    await withEnvironment(
      { ORGANIZATION_DATA_MODE: organizationMode },
      async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method });
        if (init.method === "PATCH") return new Response(null, { status: 204 });
        return Response.json([{
          display_name: "Fresh name",
          avatar_path: "avatar.webp",
          birth_date: "2000-01-01",
          account_kind: "student",
          email: USER.email,
        }]);
      },
      async () => {
        const result = await dataRouter.updateLearnerProfile(USER, { displayName: "Fresh name" });
        assert.deepEqual(result, { primary: true, cloudflareReplica: false });
      },
    );

    assert.deepEqual(
      calls.map((call) => call.method),
      ["PATCH", "GET", "GET"],
      `${organizationMode} must re-read the complete authoritative row before replication`,
    );
  }
});

test("all-Supabase mode leaves profile replication disabled", async () => {
  const calls = [];
  await withEnvironment(
    { ORGANIZATION_DATA_MODE: "supabase" },
    async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      return new Response(null, { status: 204 });
    },
    async () => {
      assert.deepEqual(
        await dataRouter.updateLearnerProfile(USER, { displayName: "Source only" }),
        { primary: true, cloudflareReplica: null },
      );
    },
  );
  assert.deepEqual(calls.map((call) => call.method), ["PATCH"]);
});

test("a cancellation and duplicate retry attempt the organization replica without failing Supabase", async () => {
  const outcomes = ["applied", "duplicate"];
  const rpcBodies = [];
  const logged = [];
  const savedError = console.error;
  console.error = (...args) => logged.push(args.join(" "));

  const cancellation = {
    eventId: "evt_cancelled",
    eventAt: "2026-08-13T00:00:00.000Z",
    userId: USER.id,
    status: "canceled",
    tier: "pro",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    priceId: "price_month",
    currentPeriodEnd: "2026-09-13T00:00:00.000Z",
    cancelAtPeriodEnd: true,
  };

  try {
    await withEnvironment(
      { ORGANIZATION_DATA_MODE: "cloudflare" },
      async (_url, init = {}) => {
        rpcBodies.push(JSON.parse(init.body));
        return Response.json(outcomes.shift());
      },
      async () => {
        assert.equal(
          await subscriptions.applyStripeSubscription(cancellation, { cancellation: true }),
          "applied",
        );
        assert.equal(
          await subscriptions.applyStripeSubscription(cancellation, { cancellation: true }),
          "duplicate",
        );
      },
    );
  } finally {
    console.error = savedError;
  }

  assert.equal(rpcBodies.length, 2);
  assert.ok(rpcBodies.every((body) => body.p_status === "canceled"));
  assert.ok(rpcBodies.every((body) => body.p_cancel_at_period_end === true));
  assert.equal(
    logged.filter((line) => line.includes("billing/subscription Cloudflare replica")).length,
    2,
    "both the first delivery and duplicate retry must attempt the failed replica",
  );
});
