/*
  The cutover from three sold tiers to two is order-independent only if a
  retired name is understood as its successor wherever it can still turn up:
  in Stripe subscription metadata (stamped at checkout, never rewritten after)
  and in database rows written before the new code deployed. This file pins
  the seam that makes that true — lib/billing/tiers.ts's `canonicalTier` and
  `canonicalPlanId` — and every place downstream that has to call it.

  Four call sites, four groups of tests:

    1. The seam itself: canonicalTier and canonicalPlanId, as pure functions.
    2. lib/billing/entitlements.ts's `normalise`, reached through the public,
       no-internals surface (`resolveEntitlement`) exactly the way every real
       caller reaches it — a stored 'pro' row must read as tier 'ai', not
       silently demote the account that is still paying for it to free.
    3. lib/billing/stripe.ts's two readers of Stripe's own data: a legacy
       `bandup_tier` in subscription metadata, and a legacy `bandup_plan_id`
       on a wallet Checkout Session.
    4. lib/cloudflare/entitlement-runtime.ts's D1 resolver: the ORDER BY must
       rank a legacy paid tier the same as its successor, so a stored 'pro'
       row outranks a stored 'tracking' row exactly as a stored 'ai' row
       would — proved directly against the raw D1 read, and then end to end
       through the exported resolver that canonicalises what it returns.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const tiers = await load("lib", "billing", "tiers.ts");
const entitlements = await load("lib", "billing", "entitlements.ts");
const stripeModule = await load("lib", "billing", "stripe.ts");
const entitlementRuntime = await load("lib", "cloudflare", "entitlement-runtime.ts");
const sourceClock = await load("lib", "cloudflare", "source-clock.ts");

const {
  LEGACY_TIER_ALIASES,
  canonicalTier,
  LEGACY_PLAN_ALIASES,
  canonicalPlanId,
  PLAN_IDS,
} = tiers;
const { subscriptionFromStripeEvent, prepaidPurchaseFromStripeEvent } = stripeModule;
const { canonicalCloudflareSourceClock } = sourceClock;

/* ------------------------------------------------------- 1. the seam itself -- */

test("canonicalTier maps every retired name to its current successor", () => {
  assert.equal(canonicalTier("standard"), "tracking");
  assert.equal(canonicalTier("plus"), "ai");
  assert.equal(canonicalTier("pro"), "ai");
  // Pins the whole table, not just the three names asserted above.
  assert.deepEqual(LEGACY_TIER_ALIASES, { standard: "tracking", plus: "ai", pro: "ai" });
});

test("canonicalTier leaves a current tier, or anything it does not recognise, unchanged", () => {
  assert.equal(canonicalTier("ai"), "ai");
  assert.equal(canonicalTier("free"), "free");
  assert.equal(canonicalTier("tracking"), "tracking");
  assert.equal(canonicalTier("admin"), "admin");
  assert.equal(canonicalTier("nonsense"), "nonsense");
});

test("canonicalPlanId maps every retired plan id to the id sold in its place", () => {
  assert.equal(canonicalPlanId("standard-monthly"), "tracking-monthly");
  assert.equal(canonicalPlanId("standard-yearly"), "tracking-yearly");
  assert.equal(canonicalPlanId("plus-monthly"), "ai-monthly");
  assert.equal(canonicalPlanId("pro-monthly"), "ai-monthly");
  assert.equal(canonicalPlanId("plus-yearly"), "ai-yearly");
  assert.equal(canonicalPlanId("pro-yearly"), "ai-yearly");
  assert.deepEqual(LEGACY_PLAN_ALIASES, {
    "standard-monthly": "tracking-monthly",
    "standard-yearly": "tracking-yearly",
    "plus-monthly": "ai-monthly",
    "pro-monthly": "ai-monthly",
    "plus-yearly": "ai-yearly",
    "pro-yearly": "ai-yearly",
  });
});

test("canonicalPlanId passes a current plan id through unchanged, and refuses everything it cannot place", () => {
  for (const id of PLAN_IDS) {
    assert.equal(canonicalPlanId(id), id);
  }
  assert.equal(canonicalPlanId("nonsense"), null);
  assert.equal(canonicalPlanId("admin-monthly"), null);
  assert.equal(canonicalPlanId(""), null);
});

/* ------------------------------------------------ 2. lib/billing/stripe.ts -- */

const EVENT_NOW = 1_800_000_000;
const ALIAS_USER = "11111111-1111-4111-8111-111111111111";

function subscriptionEventObject({ tier, priceId = "price_never_configured_here" } = {}) {
  const metadata = tier === undefined
    ? { bandup_user_id: ALIAS_USER }
    : { bandup_user_id: ALIAS_USER, bandup_tier: tier };
  return {
    id: "evt_legacy_tier_alias",
    type: "customer.subscription.updated",
    created: EVENT_NOW,
    data: {
      object: {
        id: "sub_legacy_tier_alias",
        customer: "cus_legacy_tier_alias",
        status: "active",
        cancel_at_period_end: false,
        metadata,
        items: {
          data: [{ id: "si_1", current_period_end: EVENT_NOW + 2_592_000, price: { id: priceId } }],
        },
      },
    },
  };
}

test("subscriptionFromStripeEvent canonicalises a legacy metadata tier before the paid-tier check", () => {
  // A real yearly Pro subscriber's own renewal event: metadata unmodified
  // since checkout, an old Price id this deployment's four STRIPE_PRICE_*
  // secrets do not name.
  assert.equal(subscriptionFromStripeEvent(subscriptionEventObject({ tier: "pro" })).tier, "ai");
  assert.equal(subscriptionFromStripeEvent(subscriptionEventObject({ tier: "standard" })).tier, "tracking");
  // A current tier is unaffected by passing through the same seam.
  assert.equal(subscriptionFromStripeEvent(subscriptionEventObject({ tier: "ai" })).tier, "ai");
  // No metadata tier and a Price this build does not recognise still grants
  // nothing — canonicalising a name Stripe never sent is not a back door.
  assert.equal(subscriptionFromStripeEvent(subscriptionEventObject({})).tier, "free");
});

test("prepaidPurchaseFromStripeEvent canonicalises a legacy wallet plan id and carries the canonical id forward", () => {
  const event = {
    id: "evt_legacy_wallet_alias",
    type: "checkout.session.completed",
    created: EVENT_NOW,
    data: {
      object: {
        mode: "payment",
        payment_status: "paid",
        customer: "cus_legacy_wallet_alias",
        payment_intent: "pi_legacy_wallet_alias",
        metadata: {
          bandup_user_id: ALIAS_USER,
          bandup_plan_id: "pro-yearly",
        },
      },
    },
  };
  const purchase = prepaidPurchaseFromStripeEvent(event);
  assert.equal(purchase.planId, "ai-yearly");
  assert.equal(purchase.tier, "ai");
  assert.equal(purchase.interval, "year");
  // The rest of the event is read normally — canonicalising the plan id is
  // not meant to change anything else the writers depend on.
  assert.equal(purchase.userId, ALIAS_USER);
  assert.equal(purchase.paymentIntentId, "pi_legacy_wallet_alias");
});

/* --------------------------------------- 3. lib/billing/entitlements.ts --- */
/* -------------------------------- 4. lib/cloudflare/entitlement-runtime.ts -- */

/* Minimal D1 harness, the same shape tests/entitlement-cloudflare-cutover
   .test.mjs uses: node:sqlite standing in for the D1 binding, migrations
   replayed exactly as they ship. */
function runtimeD1(database) {
  const execute = (statement) => {
    const result = database.prepare(statement.sql).run(...statement.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute({ sql, values }); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return {
    prepare(sql) {
      return { bind: (...values) => bound(sql, values), ...bound(sql, []) };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function freshD1() {
  const database = new DatabaseSync(":memory:");
  const dir = join(ROOT, "cloudflare", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(dir, file), "utf8"));
  }
  return database;
}

function fakeR2() {
  return { async put() {}, async get() { return null; }, async delete() {} };
}

function seedUser(database, userId, now) {
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(userId, `${userId}@example.test`, now, now);
}

function seedSubscription(database, { id, userId, provider, tier, currentPeriodEnd, now }) {
  database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(id, userId, provider, tier, currentPeriodEnd, now, now, now);
}

/*
  The D1 resolver, directly: the ORDER BY must rank a stored 'pro' row the
  same as it would rank a stored 'ai' row (2), ahead of a stored 'tracking'
  row (1) — this is what lets the D1 data fix run whenever it runs, before or
  after this code deploys, without a legacy row ever losing a rank contest it
  would win under its current name.

  Read raw, not through `resolveEntitlement`: canonicalising the tier this
  function returns is deliberately not this file's job (see the header of
  lib/cloudflare/entitlement-runtime.ts) — that happens exactly once, in
  `normalise`, downstream. So the value asserted here is the stored name
  itself, and the next test proves what it becomes once normalise sees it.
*/
test("resolveEntitlementFromCloudflare ranks a legacy 'pro' row ahead of a 'tracking' row, same as 'ai' would", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const userId = "50000000-0000-4000-8000-0000000000f1";
  const now = canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z");
  const future = canonicalCloudflareSourceClock("2027-01-01T00:00:00.000Z");
  seedUser(database, userId, now);
  seedSubscription(database, {
    id: "60000000-0000-4000-8000-0000000000f1",
    userId,
    provider: "stripe",
    tier: "tracking",
    currentPeriodEnd: future,
    now,
  });
  seedSubscription(database, {
    id: "60000000-0000-4000-8000-0000000000f2",
    userId,
    provider: "stripe",
    tier: "pro",
    currentPeriodEnd: future,
    now,
  });

  const resolved = await entitlementRuntime.resolveEntitlementFromCloudflare(userId, bindings, now);
  assert.equal(resolved.tier, "pro", "the legacy 'pro' row must outrank 'tracking', not lose to it as an unranked (-1) name would");
});

function withDomainMode(mode, fn) {
  const key = "CLOUDFLARE_DATA_MODE_BILLING_ENTITLEMENT_RUNTIME";
  const saved = process.env[key];
  if (mode === undefined) delete process.env[key];
  else process.env[key] = mode;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  })();
}

/** Guards a block against reaching Supabase — the Cloudflare-only path under test must never need it. */
async function withoutSupabase(fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("must not reach Supabase for this test"); };
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

test("a legacy 'pro' promo row resolves to tier 'ai' through the exported resolver, source preserved", async () => {
  await withDomainMode("read_cloudflare", async () => {
    const database = freshD1();
    globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: runtimeD1(database), BANDUP_FILES: fakeR2() } };
    try {
      const userId = "50000000-0000-4000-8000-0000000000f3";
      const now = canonicalCloudflareSourceClock("2026-08-17T00:00:00.000Z");
      seedUser(database, userId, now);
      // The free trial's own shape: provider 'promo', no current_period_end.
      database.prepare(`
        INSERT INTO subscriptions (id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at)
        VALUES (?, ?, 'promo', 'active', 'pro', NULL, ?, ?, ?)
      `).run("60000000-0000-4000-8000-0000000000f3", userId, now, now, now);

      await withoutSupabase(async () => {
        const result = await entitlements.resolveEntitlement(userId, "alias-trial@example.test");
        assert.deepEqual(result, { role: "user", tier: "ai", source: "promo", expiresAt: null });
      });
    } finally {
      delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    }
  });
});

test("a legacy 'pro' row and a current 'tracking' row: 'ai' wins, end to end through the exported resolver", async () => {
  await withDomainMode("read_cloudflare", async () => {
    const database = freshD1();
    globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: runtimeD1(database), BANDUP_FILES: fakeR2() } };
    try {
      const userId = "50000000-0000-4000-8000-0000000000f4";
      const now = canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z");
      const future = canonicalCloudflareSourceClock("2027-01-01T00:00:00.000Z");
      seedUser(database, userId, now);
      seedSubscription(database, {
        id: "60000000-0000-4000-8000-0000000000f4",
        userId,
        provider: "stripe",
        tier: "tracking",
        currentPeriodEnd: future,
        now,
      });
      seedSubscription(database, {
        id: "60000000-0000-4000-8000-0000000000f5",
        userId,
        provider: "stripe",
        tier: "pro",
        currentPeriodEnd: future,
        now,
      });

      await withoutSupabase(async () => {
        const result = await entitlements.resolveEntitlement(userId, "alias-both@example.test");
        assert.equal(result.tier, "ai");
      });
    } finally {
      delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    }
  });
});

test("organisation eligibility ranks and counts a legacy paid row as its successor", () => {
  // actorTier is private to lib/cloudflare/organizations.ts, so this pins the
  // two things it must do for a row still spelled the old way: rank it with
  // the tier it now means, and canonicalise before paidTier decides.
  const source = readFileSync(join(process.cwd(), "lib", "cloudflare", "organizations.ts"), "utf8");
  const fn = source.slice(source.indexOf("async function actorTier("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /WHEN 'ai' THEN 2 WHEN 'pro' THEN 2 WHEN 'plus' THEN 2/);
  assert.match(body, /WHEN 'tracking' THEN 1 WHEN 'standard' THEN 1/);
  assert.match(body, /canonicalTier\(active\.tier\)/);
  assert.match(body, /paidTier\(tier\) \? tier : "free"/);
  assert.match(source, /import \{ canonicalTier \} from "@\/lib\/billing\/tiers";/);
});
