import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const learner = await load("lib", "cloudflare", "learner-data.ts");
const billing = await load("lib", "cloudflare", "billing-replica.ts");

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

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  const objects = new Map();
  const files = {
    async put(key, value) { objects.set(key, Uint8Array.from(value)); },
    async delete(key) { objects.delete(key); },
    async get(key) {
      const value = objects.get(key);
      return value ? { async arrayBuffer() { return value.buffer; } } : null;
    },
  };
  return { database, objects, bindings: { db: runtimeD1(database), files } };
}

const USER = {
  id: "50000000-0000-4000-8000-000000000099",
  email: "new-learner@example.test",
};

test("first authenticated profile read creates a D1 user/profile without overwriting later data", async () => {
  const context = fixture();
  const first = {
    displayName: "New learner",
    username: "new.learner",
    accountKind: null,
    avatarPath: null,
    birthDate: null,
    email: USER.email,
    updatedAt: "2026-08-14T01:00:00.000Z",
  };
  assert.equal(
    await learner.bootstrapCloudflareLearnerProfile(USER, first, context.bindings),
    true,
  );
  assert.deepEqual(
    { ...context.database.prepare(`
      SELECT u.email, p.display_name, n.username
        FROM app_users u
        JOIN learner_profiles p ON p.user_id = u.id
        LEFT JOIN usernames n ON n.user_id = u.id
       WHERE u.id = ?
    `).get(USER.id) },
    { email: USER.email, display_name: "New learner", username: "new.learner" },
  );

  context.database.prepare(`
    UPDATE learner_profiles SET display_name = 'Already newer',
      source_updated_at = '2026-08-14T03:00:00.000Z'
     WHERE user_id = ?
  `).run(USER.id);
  assert.equal(
    await learner.bootstrapCloudflareLearnerProfile(
      USER,
      { ...first, displayName: "Old login snapshot", updatedAt: "2026-08-14T02:00:00.000Z" },
      context.bindings,
    ),
    true,
  );
  assert.equal(
    context.database.prepare("SELECT display_name FROM learner_profiles WHERE user_id = ?")
      .get(USER.id).display_name,
    "Already newer",
  );
});

test("profile metadata replication is ordered and never replaces the private R2 avatar pointer", async () => {
  const context = fixture();
  await learner.bootstrapCloudflareLearnerProfile(USER, null, context.bindings);
  context.database.prepare(`
    UPDATE learner_profiles SET display_name = 'Current',
      avatar_object_key = 'private/avatars/current.webp',
      source_updated_at = '2026-08-14T03:00:00.000Z'
     WHERE user_id = ?
  `).run(USER.id);
  const base = {
    username: null,
    accountKind: null,
    avatarPath: "supabase/path.webp",
    birthDate: null,
    email: USER.email,
  };
  assert.equal(await learner.putCloudflareLearnerProfile(USER, {
    ...base,
    displayName: "Stale",
    updatedAt: "2026-08-14T02:00:00.000Z",
  }, context.bindings), true);
  assert.deepEqual(
    { ...context.database.prepare(`
      SELECT display_name, avatar_object_key FROM learner_profiles WHERE user_id = ?
    `).get(USER.id) },
    { display_name: "Current", avatar_object_key: "private/avatars/current.webp" },
  );
  assert.equal(await learner.putCloudflareLearnerProfile(USER, {
    ...base,
    displayName: "Fresh",
    updatedAt: "2026-08-14T04:00:00.000Z",
  }, context.bindings), true);
  assert.deepEqual(
    { ...context.database.prepare(`
      SELECT display_name, avatar_object_key FROM learner_profiles WHERE user_id = ?
    `).get(USER.id) },
    { display_name: "Fresh", avatar_object_key: "private/avatars/current.webp" },
  );
});

test("a stale Stripe delivery stores its audit payload but mirrors the current Supabase row", async () => {
  const context = fixture();
  const authoritative = {
    id: "70000000-0000-4000-8000-000000000001",
    userId: USER.id,
    status: "canceled",
    tier: "pro",
    customerId: "cus_current",
    subscriptionId: "sub_current",
    priceId: "price_pro",
    currentPeriodEnd: "2026-09-14T00:00:00.000Z",
    cancelAtPeriodEnd: true,
    providerEventAt: "2026-08-14T03:00:00.000Z",
    verifiedAt: "2026-08-14T03:00:01.000Z",
    raw: { id: "evt_current", status: "canceled" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-14T03:00:01.000Z",
  };
  const staleEvent = {
    eventId: "evt_stale",
    eventAt: "2026-08-13T03:00:00.000Z",
    userId: USER.id,
    status: "active",
    tier: "pro",
    customerId: "cus_current",
    subscriptionId: "sub_current",
    priceId: "price_pro",
    currentPeriodEnd: "2026-09-14T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  };
  assert.equal(await billing.replicateStripeSubscriptionToCloudflare(
    staleEvent,
    { id: "evt_stale", status: "active" },
    authoritative,
    context.bindings,
  ), true);
  const mirrored = context.database.prepare(`
    SELECT status, cancel_at_period_end, provider_event_at, raw_inline
      FROM subscriptions WHERE external_subscription_id = 'sub_current'
  `).get();
  assert.equal(mirrored.status, "canceled");
  assert.equal(mirrored.cancel_at_period_end, 1);
  assert.equal(mirrored.provider_event_at, "2026-08-14T03:00:00.000000000Z");
  assert.deepEqual(JSON.parse(mirrored.raw_inline), authoritative.raw);

  const receipt = context.database.prepare(`
    SELECT payload_object_key FROM provider_events WHERE event_id = 'evt_stale'
  `).get();
  assert.equal(typeof receipt.payload_object_key, "string");
  const storedEvent = context.objects.get(receipt.payload_object_key);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(storedEvent)), {
    id: "evt_stale",
    status: "active",
  });
});
