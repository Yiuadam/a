import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);
const promo = await load("lib", "cloudflare", "native-promo.ts");

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
  for (const file of readdirSync(join(ROOT, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", file), "utf8"));
  }
  return {
    database,
    bindings: {
      db: runtimeD1(database),
      files: {
        async put() {},
        async delete() {},
        async get() { return null; },
      },
    },
  };
}

const USER = "60000000-0000-4000-8000-000000000001";

function insertUser(database, userId = USER) {
  database.prepare(`
    INSERT INTO app_users (id, identity_provider, email, role, created_at, updated_at)
    VALUES (?, 'supabase', ?, 'user', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z')
  `).run(userId, `${userId}@example.test`);
}

test("native promo writer has one reversible D1 grant and never revives a deleted account", async () => {
  const context = fixture();

  assert.equal(await promo.nativeInsertPromoSubscription(USER, context.bindings), "failed");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM subscriptions").get().n, 0);

  insertUser(context.database);
  assert.equal(await promo.nativePromoSubscriptionState(USER, context.bindings), "none");
  assert.equal(await promo.nativeInsertPromoSubscription(USER, context.bindings), "inserted");
  assert.equal(await promo.nativeInsertPromoSubscription(USER, context.bindings), "exists");
  assert.equal(await promo.nativePromoSubscriptionState(USER, context.bindings), "holding");

  const active = context.database.prepare(`
    SELECT id, status, tier, provider, raw_inline FROM subscriptions WHERE user_id = ?
  `).get(USER);
  assert.deepEqual(
    { id: active.id, status: active.status, tier: active.tier, provider: active.provider },
    { id: `promo:${USER}`, status: "active", tier: "pro", provider: "promo" },
  );
  assert.equal(JSON.parse(active.raw_inline).kind, "free-pro-trial");

  assert.equal(await promo.nativeReleasePromoSubscription(USER, context.bindings), "changed");
  assert.equal(await promo.nativePromoSubscriptionState(USER, context.bindings), "released");
  assert.equal(await promo.nativeResumePromoSubscription(USER, context.bindings), "changed");
  assert.equal(await promo.nativePromoSubscriptionState(USER, context.bindings), "holding");

  context.database.prepare("UPDATE app_users SET deleted_at = '2026-08-30T00:00:00.000000000Z' WHERE id = ?")
    .run(USER);
  assert.equal(await promo.nativeReleasePromoSubscription(USER, context.bindings), "failed");
  assert.equal(
    context.database.prepare("SELECT status FROM subscriptions WHERE user_id = ?").get(USER).status,
    "active",
  );
});

test("a cancelled native promo row remains final and cannot be restarted", async () => {
  const context = fixture();
  insertUser(context.database);
  assert.equal(await promo.nativeInsertPromoSubscription(USER, context.bindings), "inserted");
  context.database.prepare("UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?").run(USER);

  assert.equal(await promo.nativePromoSubscriptionState(USER, context.bindings), "ended");
  assert.equal(await promo.nativeResumePromoSubscription(USER, context.bindings), "no-match");
  assert.equal(await promo.nativeInsertPromoSubscription(USER, context.bindings), "exists");
  assert.equal(
    context.database.prepare("SELECT status FROM subscriptions WHERE user_id = ?").get(USER).status,
    "canceled",
  );
});

test("promo API accepts the native account runtime rather than a Supabase-only gate", () => {
  const source = readFileSync(join(ROOT, "app", "api", "billing", "promo", "route.ts"), "utf8");
  assert.match(source, /accountRuntimeEnabled/);
  assert.doesNotMatch(source, /supabaseConfigured/);
});
