import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const native = await import(pathToFileURL(
  join(ROOT, "lib", "cloudflare", "native-stripe-billing.ts"),
).href);
const readiness = await import(pathToFileURL(
  join(ROOT, "lib", "cloudflare", "native-billing-readiness.ts"),
).href);

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
    prepare(sql) { return { bind: (...values) => bound(sql, values), ...bound(sql, []) }; },
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

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(ROOT, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", file), "utf8"));
  }
  const objects = new Map();
  return {
    database,
    objects,
    bindings: {
      db: runtimeD1(database),
      files: {
        async put(key, value) { objects.set(key, Uint8Array.from(value)); },
        async delete(key) { objects.delete(key); },
        async get(key) {
          const value = objects.get(key);
          return value ? { async arrayBuffer() { return value.buffer; } } : null;
        },
      },
    },
  };
}

const USER = "70000000-0000-4000-8000-000000000001";

function user(database, id = USER) {
  database.prepare(`
    INSERT INTO app_users (id, identity_provider, email, role, created_at, updated_at)
    VALUES (?, 'supabase', ?, 'user', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z')
  `).run(id, `${id}@example.test`);
}

function subscriptionEvent(overrides = {}) {
  return {
    eventId: "evt_sub_created",
    eventAt: "2026-08-29T12:00:00.000Z",
    userId: USER,
    status: "active",
    tier: "pro",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    priceId: "price_pro",
    currentPeriodEnd: "2026-09-29T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function prepaidEvent(overrides = {}) {
  return {
    eventId: "evt_wallet_1",
    eventAt: "2026-08-29T12:00:00.000Z",
    userId: USER,
    tier: "plus",
    planId: "plus-monthly",
    interval: "month",
    customerId: "cus_wallet",
    paymentIntentId: "pi_1",
    ...overrides,
  };
}

test("native subscription receipt, stale guard and duplicate are one D1 transaction", async () => {
  const context = fixture();
  user(context.database);
  const created = subscriptionEvent();

  assert.equal(
    await native.applyNativeStripeSubscription(created, { id: created.eventId }, context.bindings),
    "applied",
  );
  assert.equal(
    await native.applyNativeStripeSubscription(created, { id: created.eventId }, context.bindings),
    "duplicate",
  );

  const cancellation = subscriptionEvent({
    eventId: "evt_sub_cancelled",
    eventAt: "2026-08-30T12:00:00.000Z",
    status: "canceled",
    cancelAtPeriodEnd: true,
  });
  assert.equal(
    await native.applyNativeStripeSubscription(cancellation, { id: cancellation.eventId }, context.bindings),
    "applied",
  );

  const stale = subscriptionEvent({ eventId: "evt_sub_stale", eventAt: "2026-08-29T13:00:00.000Z" });
  assert.equal(
    await native.applyNativeStripeSubscription(stale, { id: stale.eventId }, context.bindings),
    "stale",
  );
  assert.deepEqual(
    { ...context.database.prepare(`
      SELECT status, cancel_at_period_end FROM subscriptions WHERE external_subscription_id = 'sub_1'
    `).get() },
    { status: "canceled", cancel_at_period_end: 1 },
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM provider_events WHERE provider = 'stripe'").get().n,
    3,
    "even a stale delivery remains a durable audit receipt",
  );
});

test("native prepaid purchase extends paid time and only a complete refund revokes it", async () => {
  const context = fixture();
  user(context.database);
  const first = prepaidEvent();
  const payload = { data: { object: { amount_total: 499 } } };
  assert.equal(
    await native.applyNativeStripePrepaidPurchase(first, payload, context.bindings),
    "applied",
  );
  assert.equal(
    await native.applyNativeStripePrepaidPurchase(first, payload, context.bindings),
    "duplicate",
  );
  const firstEnd = context.database.prepare(`
    SELECT current_period_end FROM subscriptions WHERE external_subscription_id = 'pi_1'
  `).get().current_period_end;

  const second = prepaidEvent({
    eventId: "evt_wallet_2",
    eventAt: "2026-08-30T12:00:00.000Z",
    paymentIntentId: "pi_2",
  });
  assert.equal(
    await native.applyNativeStripePrepaidPurchase(second, payload, context.bindings),
    "applied",
  );
  const secondEnd = context.database.prepare(`
    SELECT current_period_end FROM subscriptions WHERE external_subscription_id = 'pi_2'
  `).get().current_period_end;
  assert.ok(secondEnd > firstEnd, "an early second pass extends the live first pass");

  const partial = {
    eventId: "evt_refund_partial",
    eventAt: "2026-08-31T12:00:00.000Z",
    paymentIntentId: "pi_1",
    amountMinor: 200,
    fullRefundConfirmed: false,
  };
  assert.equal(
    await native.applyNativeStripePrepaidRefund(partial, { id: partial.eventId }, context.bindings),
    "partial_refund",
  );
  assert.equal(
    context.database.prepare("SELECT status FROM subscriptions WHERE external_subscription_id = 'pi_1'").get().status,
    "active",
  );

  const full = { ...partial, eventId: "evt_refund_full", eventAt: "2026-09-01T12:00:00.000Z", amountMinor: 499 };
  assert.equal(
    await native.applyNativeStripePrepaidRefund(full, { id: full.eventId }, context.bindings),
    "applied",
  );
  assert.equal(
    await native.applyNativeStripePrepaidRefund(full, { id: full.eventId }, context.bindings),
    "duplicate",
  );
  assert.equal(
    context.database.prepare("SELECT status FROM subscriptions WHERE external_subscription_id = 'pi_1'").get().status,
    "refunded",
  );
});

test("native payment writes refuse missing or deleted D1 users without claiming the event", async () => {
  const context = fixture();
  const event = subscriptionEvent();
  assert.equal(
    await native.applyNativeStripeSubscription(event, { id: event.eventId }, context.bindings),
    "unknown_user",
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM provider_events").get().n, 0);

  user(context.database);
  context.database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?")
    .run("2026-08-30T00:00:00.000000000Z", USER);
  assert.equal(
    await native.applyNativeStripePrepaidPurchase(prepaidEvent(), { data: { object: { amount_total: 499 } } }, context.bindings),
    "unknown_user",
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM provider_events").get().n, 0);
});

test("concurrent redelivery produces one entitlement write and one durable duplicate", async () => {
  const context = fixture();
  user(context.database);
  const event = subscriptionEvent();

  const outcomes = await Promise.all([
    native.applyNativeStripeSubscription(event, { id: event.eventId }, context.bindings),
    native.applyNativeStripeSubscription(event, { id: event.eventId }, context.bindings),
  ]);

  assert.deepEqual(outcomes.sort(), ["applied", "duplicate"]);
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM provider_events WHERE provider = 'stripe'").get().n,
    1,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM subscriptions WHERE provider = 'stripe'").get().n,
    1,
  );
});

test("an R2 evidence failure creates neither a receipt nor entitlement", async () => {
  const context = fixture();
  user(context.database);
  context.bindings.files.put = async () => {
    throw new Error("R2 temporarily unavailable");
  };
  const event = subscriptionEvent();

  await assert.rejects(
    native.applyNativeStripeSubscription(event, { id: event.eventId }, context.bindings),
    /R2 temporarily unavailable/,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM provider_events").get().n, 0);
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM subscriptions").get().n, 0);
});

test("the native writer stays behind its own explicit payment switch", () => {
  const subscriptions = readFileSync(join(ROOT, "lib", "billing", "subscriptions.ts"), "utf8");
  const webhook = readFileSync(join(ROOT, "app", "api", "billing", "webhook", "stripe", "route.ts"), "utf8");
  const readiness = readFileSync(join(ROOT, "lib", "cloudflare", "native-billing-readiness.ts"), "utf8");
  assert.match(subscriptions, /nativeStripeBillingActive\(\)/);
  assert.match(webhook, /nativeStripeBillingActive\(\)/);
  assert.match(readiness, /CLOUDFLARE_NATIVE_STRIPE_BILLING/);
  assert.match(readiness, /domainWritesToCloudflareOnly/);
});

test("Cloudflare learner mode alone cannot cut Stripe writes over", () => {
  const names = ["CLOUDFLARE_DATA_MODE", "CLOUDFLARE_NATIVE_STRIPE_BILLING"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CLOUDFLARE_DATA_MODE = "cloudflare";
    process.env.CLOUDFLARE_NATIVE_STRIPE_BILLING = "0";
    assert.equal(readiness.nativeStripeBillingActive(), false);
    process.env.CLOUDFLARE_NATIVE_STRIPE_BILLING = "1";
    assert.equal(readiness.nativeStripeBillingActive(), true);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("provider-event R2 evidence is an allowed and user-scoped deletion object", () => {
  const context = fixture();
  user(context.database);
  context.database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'native-payment-delete-001', 'prepared', ?, ?, ?)
  `).run(
    USER,
    "2026-08-29T00:00:00.000000000Z",
    "2026-08-29T00:10:00.000000000Z",
    "2026-08-29T00:00:00.000000000Z",
  );
  context.database.prepare(`
    INSERT INTO account_deletion_objects (user_id, object_key, discovered_at)
    VALUES (?, ?, '2026-08-29T00:00:00.000000000Z')
  `).run(USER, `private/provider-events/${USER}/receipt.json`);
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM account_deletion_objects").get().n, 1);
  assert.throws(() => context.database.prepare(`
    INSERT INTO account_deletion_objects (user_id, object_key, discovered_at)
    VALUES (?, ?, '2026-08-29T00:00:00.000000000Z')
  `).run(USER, "private/provider-events/another-user/receipt.json"));
});
