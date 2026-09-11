/*
  scripts/hand-run-tracking-and-ai-tiers-on-d1.sql, proved against a real
  in-memory D1 schema — the same reason tests/entitlement-cloudflare-cutover.
  test.mjs replays cloudflare/migrations against node:sqlite rather than
  trusting a description of what the SQL does: a JS mock of the rename would
  only prove the mock was written to match the file, not that the file itself
  renames the right rows, leaves the right one alone, and does not knock any
  index or trigger off the table it rewrites.

  The fixture below is built the same way tests/cutover-write-barrier.test.mjs
  builds its own: every numbered cloudflare/migrations file, in order, then
  scripts/hand-run-cutover-write-barrier.sql — the one other hand-run file a
  test in this repo already applies on top of the ledger. That keeps this
  fixture the same shape as the database the tier rename will actually run
  against (numbered migrations plus whatever the owner has already run by
  hand), rather than a narrower stand-in that happens not to exercise it.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const HAND_RUN_FILE = join(ROOT, "scripts", "hand-run-tracking-and-ai-tiers-on-d1.sql");

function freshD1() {
  const database = new DatabaseSync(":memory:");
  const migrationsDir = join(ROOT, "cloudflare", "migrations");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  database.exec(readFileSync(join(ROOT, "scripts", "hand-run-cutover-write-barrier.sql"), "utf8"));
  return database;
}

/** Every index or trigger D1 attaches to `subscriptions`, by name — order-independent. */
function schemaObjectNames(database, type) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = 'subscriptions' ORDER BY name")
    .all(type)
    .map((row) => row.name);
}

function seedUser(database, id, email) {
  database
    .prepare("INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)")
    .run(id, email, "2026-01-01T00:00:00.000000000Z", "2026-01-01T00:00:00.000000000Z");
}

function seedSubscription(database, { id, userId, provider, tier }) {
  database
    .prepare(`
      INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `)
    .run(id, userId, provider, tier, "2026-08-01T00:00:00.000000000Z", "2026-08-01T00:00:00.000000000Z", "2026-08-01T00:00:00.000000000Z");
}

test("the hand-run tier rename turns every legacy row into tracking/ai, leaves free alone, and disturbs nothing else on the table", () => {
  const database = freshD1();

  const indexesBefore = schemaObjectNames(database, "index");
  const triggersBefore = schemaObjectNames(database, "trigger");
  assert.ok(indexesBefore.length > 0, "fixture sanity: subscriptions should already carry indexes");
  assert.ok(triggersBefore.length > 0, "fixture sanity: subscriptions should already carry triggers");

  const USERS = {
    promo: "50000000-0000-4000-8000-000000000001",
    stripe: "50000000-0000-4000-8000-000000000002",
    plus: "50000000-0000-4000-8000-000000000003",
    standard: "50000000-0000-4000-8000-000000000004",
    free: "50000000-0000-4000-8000-000000000005",
  };
  for (const [key, id] of Object.entries(USERS)) seedUser(database, id, `${key}@example.test`);

  // Production's own three legacy rows (a promo trial and a Stripe yearly,
  // both 'pro'), plus one of each of the other two retired names and one
  // already-'free' row this rename must leave completely alone.
  seedSubscription(database, { id: "sub-promo-pro", userId: USERS.promo, provider: "promo", tier: "pro" });
  seedSubscription(database, { id: "sub-stripe-pro", userId: USERS.stripe, provider: "stripe", tier: "pro" });
  seedSubscription(database, { id: "sub-plus", userId: USERS.plus, provider: "stripe", tier: "plus" });
  seedSubscription(database, { id: "sub-standard", userId: USERS.standard, provider: "stripe", tier: "standard" });
  seedSubscription(database, { id: "sub-free", userId: USERS.free, provider: "stripe", tier: "free" });

  const before = new Map(
    database.prepare("SELECT id, updated_at FROM subscriptions").all().map((row) => [row.id, row.updated_at]),
  );

  database.exec(readFileSync(HAND_RUN_FILE, "utf8"));

  const after = new Map(
    database.prepare("SELECT id, tier, updated_at FROM subscriptions").all().map((row) => [row.id, row]),
  );

  assert.equal(after.get("sub-promo-pro").tier, "ai", "a promo 'pro' trial must become 'ai'");
  assert.equal(after.get("sub-stripe-pro").tier, "ai", "a Stripe 'pro' subscription must become 'ai'");
  assert.equal(after.get("sub-plus").tier, "ai", "'plus' must become 'ai'");
  assert.equal(after.get("sub-standard").tier, "tracking", "'standard' must become 'tracking'");
  assert.equal(after.get("sub-free").tier, "free", "a row already on 'free' must not be touched");

  for (const id of ["sub-promo-pro", "sub-stripe-pro", "sub-plus", "sub-standard"]) {
    assert.notEqual(after.get(id).updated_at, before.get(id), `${id}: updated_at must change when the row is renamed`);
  }
  assert.equal(
    after.get("sub-free").updated_at,
    before.get("sub-free"),
    "the untouched row's updated_at must not move",
  );

  assert.deepEqual(
    schemaObjectNames(database, "index"),
    indexesBefore,
    "a plain UPDATE must not drop, rebuild or rename any index on subscriptions",
  );
  assert.deepEqual(
    schemaObjectNames(database, "trigger"),
    triggersBefore,
    "a plain UPDATE must not drop, rebuild or rename any trigger on subscriptions",
  );

  const verification = database
    .prepare("SELECT tier, provider, status, COUNT(*) as n FROM subscriptions GROUP BY 1, 2, 3")
    .all();
  assert.ok(verification.length > 0);
  for (const row of verification) {
    assert.ok(
      ["free", "tracking", "ai"].includes(row.tier),
      `verification query must only ever report free/tracking/ai, saw '${row.tier}'`,
    );
  }
});

test("the deletion guard blocks the whole rename for a user whose account deletion is in progress", () => {
  const database = freshD1();
  const userId = "50000000-0000-4000-8000-0000000000aa";
  const otherUserId = "50000000-0000-4000-8000-0000000000bb";
  seedUser(database, userId, "deleting@example.test");
  seedUser(database, otherUserId, "safe@example.test");
  seedSubscription(database, { id: "sub-deleting", userId, provider: "stripe", tier: "standard" });
  seedSubscription(database, { id: "sub-safe", userId: otherUserId, provider: "stripe", tier: "plus" });

  database
    .prepare(`
      INSERT INTO account_deletion_tombstones (user_id, operation_id, state, prepared_at, lease_expires_at, updated_at)
      VALUES (?, ?, 'prepared', ?, ?, ?)
    `)
    .run(userId, "50000000-0000-4000-8000-0000000000cc", "2026-08-01T00:00:00.000000000Z", "2026-08-01T00:01:00.000000000Z", "2026-08-01T00:00:00.000000000Z");

  assert.throws(
    () => database.exec(readFileSync(HAND_RUN_FILE, "utf8")),
    /account deletion is in progress/,
    "the deletion guard trigger must abort the whole UPDATE, per the hand-run file's own header",
  );

  // RAISE(ABORT) rolls back the whole statement, so the other row — matched
  // by the very same UPDATE — must be left exactly as it was too.
  const untouched = database.prepare("SELECT tier FROM subscriptions WHERE id = 'sub-safe'").get();
  assert.equal(untouched.tier, "plus", "an aborted statement must not have partially applied to an unrelated row");
});
