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

const { PLANS } = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href
);

/**
 * `STRIPE_PRICE_PRO_YEARLY` -> `pro-yearly`, so the stub can tell from the id
 * in the URL which plan is being asked about. withFullConfig sets each id to
 * `price_${variable.toLowerCase()}`.
 */
const PLAN_ID_BY_VAR = Object.fromEntries(
  ["STANDARD_MONTHLY", "STANDARD_YEARLY", "PLUS_MONTHLY", "PLUS_YEARLY", "PRO_MONTHLY", "PRO_YEARLY"].map(
    (suffix) => [`STRIPE_PRICE_${suffix}`, suffix.toLowerCase().replace("_", "-")],
  ),
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

/*
  A Stripe that answers both questions billingHealth asks: the subscriptions
  read behind `stripe_reachable`, and the six Price reads behind
  `stripe_prices_match_catalogue`.

  `priceFor` lets a test make one Price disagree with the catalogue. Its default
  builds each Price from the catalogue itself rather than from literals, so
  these tests keep passing when a price changes and still fail when a Price
  stops matching one — which is the distinction the whole check exists to make.
*/
function mockReachableStripe(priceFor = cataloguePrice) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/prices/")) {
      const id = decodeURIComponent(target.split("/prices/")[1].split("?")[0]);
      const plan = PLAN_ID_BY_VAR[id.replace(/^price_/, "").toUpperCase()];
      return new Response(JSON.stringify(priceFor(plan)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], livemode: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = savedFetch;
  };
}

function cataloguePrice(plan) {
  const expected = PLANS[plan];
  const currency_options = {};
  for (const [code, unit_amount] of Object.entries(expected.prices)) {
    currency_options[code] = { unit_amount };
  }
  return {
    active: true,
    unit_amount: expected.amountMinor,
    currency: expected.currency,
    recurring: { interval: expected.interval },
    currency_options,
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
      assert.equal(health.checks.find((c) => c.name === "accounts_runtime_enabled").ok, true);
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
      assert.equal(health.checks.find((c) => c.name === "accounts_runtime_enabled").ok, false);
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
        "accounts_runtime_enabled",
        "billing_storage_configured",
        "stripe_key_present",
        "stripe_price_ids_present",
        "stripe_prices_match_catalogue",
        "stripe_reachable",
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

test("ok is false when a Price is archived, though every id is still set", () =>
  withFullConfig(async () => {
    /*
      The whole point of the check. Before it existed this deployment reported
      itself healthy: six ids set, key present, Stripe answering — and a plan
      nobody could buy, discovered by the first learner to press Subscribe.
    */
    const restore = mockReachableStripe((plan) =>
      plan === "pro-yearly" ? { ...cataloguePrice(plan), active: false } : cataloguePrice(plan),
    );
    try {
      const health = await billingHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find((c) => c.name === "stripe_prices_match_catalogue").ok, false);
      // The id really is present; that check is not what caught this.
      assert.equal(health.checks.find((c) => c.name === "stripe_price_ids_present").ok, true);
    } finally {
      restore();
    }
  }));

test("ok is false when a Price charges an amount the catalogue never advertised", () =>
  withFullConfig(async () => {
    const restore = mockReachableStripe((plan) =>
      plan === "plus-monthly"
        ? { ...cataloguePrice(plan), unit_amount: cataloguePrice(plan).unit_amount + 100 }
        : cataloguePrice(plan),
    );
    try {
      const health = await billingHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find((c) => c.name === "stripe_prices_match_catalogue").ok, false);
    } finally {
      restore();
    }
  }));

test("the price check reports false when it could not be run, never true", () =>
  withFullConfig(async () => {
    /*
      An unreachable Stripe means the prices were not looked at. Reporting them
      verified would be the same lie the old check told, arrived at by a
      different route.
    */
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "api_key_expired" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const health = await billingHealth();
      assert.equal(health.checks.find((c) => c.name === "stripe_prices_match_catalogue").ok, false);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("a failing price check still leaks nothing but a boolean and a fixed name", () =>
  withFullConfig(async () => {
    const restore = mockReachableStripe((plan) =>
      plan === "pro-yearly" ? { ...cataloguePrice(plan), active: false } : cataloguePrice(plan),
    );
    try {
      const health = await billingHealth();
      const serialised = JSON.stringify(health);
      assert.doesNotMatch(serialised, /archived/);
      // The Price *id*, not the substring "price_" — two of the check names
      // legitimately contain that, and asserting on it tests the wrong thing.
      assert.doesNotMatch(serialised, /price_stripe_price_/);
      assert.doesNotMatch(serialised, /sk_test_billing_health/);
      for (const check of health.checks) {
        assert.deepEqual(Object.keys(check).sort(), ["name", "ok"]);
      }
    } finally {
      restore();
    }
  }));
