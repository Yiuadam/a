/*
  A billing outage that reports success is the incident this file guards
  against — see commit 684183c and app/api/billing/health/route.ts.

  billingHealth() is what .github/workflows/deploy-cloudflare.yml checks after
  every production deploy, unauthenticated, so these tests hold two things at
  once: that `ok` genuinely tracks whether checkout can work, and that nothing
  it returns is more than a boolean and a fixed name — never Stripe's own error
  text, a key, or anything the admin-only diagnostics route keeps private.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const { billingHealth } = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "health.ts")).href
);

const PRICE_VARS = [
  "STRIPE_PRICE_STANDARD_MONTHLY",
  "STRIPE_PRICE_STANDARD_YEARLY",
  "STRIPE_PRICE_PLUS_MONTHLY",
  "STRIPE_PRICE_PLUS_YEARLY",
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_YEARLY",
];
const CONFIG_VARS = [
  "ACCOUNTS_ENABLED",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  ...PRICE_VARS,
];

/** Sets every variable a fully healthy deployment would have, then runs `fn`. */
function withFullConfig(fn) {
  const saved = {};
  for (const key of CONFIG_VARS) saved[key] = process.env[key];
  process.env.ACCOUNTS_ENABLED = "1";
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_health";
  for (const key of PRICE_VARS) process.env[key] = `price_${key.toLowerCase()}`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of CONFIG_VARS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

function mockReachableStripe() {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [], livemode: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  return () => {
    globalThis.fetch = savedFetch;
  };
}

test("ok is true when every piece of billing configuration is present and Stripe answers", () =>
  withFullConfig(async () => {
    const restore = mockReachableStripe();
    try {
      const health = await billingHealth();
      assert.equal(health.ok, true);
      for (const check of health.checks) assert.equal(check.ok, true, check.name);
    } finally {
      restore();
    }
  }));

test("ok is false, and names the check, when a single Price id goes missing", () =>
  withFullConfig(async () => {
    const restore = mockReachableStripe();
    delete process.env.STRIPE_PRICE_PRO_YEARLY;
    try {
      const health = await billingHealth();
      assert.equal(health.ok, false);
      const prices = health.checks.find((c) => c.name === "stripe_price_ids_present");
      assert.equal(prices.ok, false);
      // Everything else configured stays reported as configured — one missing
      // Price does not smear the whole panel red.
      assert.equal(health.checks.find((c) => c.name === "accounts_enabled").ok, true);
      assert.equal(health.checks.find((c) => c.name === "stripe_key_present").ok, true);
    } finally {
      restore();
    }
  }));

test("ok is false when ACCOUNTS_ENABLED goes missing", () =>
  withFullConfig(async () => {
    const restore = mockReachableStripe();
    delete process.env.ACCOUNTS_ENABLED;
    try {
      const health = await billingHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find((c) => c.name === "accounts_enabled").ok, false);
    } finally {
      restore();
    }
  }));

test("ok is false when Stripe is configured but unreachable, without leaking why", () =>
  withFullConfig(async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API Key provided: sk_test_***", code: "api_key_expired" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const health = await billingHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find((c) => c.name === "stripe_reachable").ok, false);
      const serialised = JSON.stringify(health);
      assert.doesNotMatch(serialised, /Invalid API Key/);
      assert.doesNotMatch(serialised, /api_key_expired/);
      assert.doesNotMatch(serialised, /sk_test_billing_health/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("every check is a boolean under a fixed name, nothing else", () =>
  withFullConfig(async () => {
    const restore = mockReachableStripe();
    try {
      const health = await billingHealth();
      assert.equal(typeof health.ok, "boolean");
      for (const check of health.checks) {
        assert.deepEqual(Object.keys(check).sort(), ["name", "ok"]);
        assert.equal(typeof check.name, "string");
        assert.equal(typeof check.ok, "boolean");
      }
      const names = health.checks.map((c) => c.name).sort();
      assert.deepEqual(names, [
        "accounts_enabled",
        "stripe_key_present",
        "stripe_price_ids_present",
        "stripe_reachable",
        "supabase_configured",
      ].sort());
    } finally {
      restore();
    }
  }));

test("the health route is unauthenticated, uncached, and returns only the shared health object", () => {
  const source = readFileSync(join(process.cwd(), "app", "api", "billing", "health", "route.ts"), "utf8");
  assert.doesNotMatch(source, /getSessionUser|isAdminEmail/, "this route must stay open to an unauthenticated caller");
  assert.match(source, /no-store/);
  assert.match(source, /billingHealth\(\)/);
});

test("the health route never imports Stripe's raw diagnostic text into its response", () => {
  const source = readFileSync(join(process.cwd(), "app", "api", "billing", "health", "route.ts"), "utf8");
  assert.doesNotMatch(source, /detail/i);
});
