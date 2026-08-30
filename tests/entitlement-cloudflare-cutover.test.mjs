/*
  `billing_entitlement_runtime`'s D1 read path, proved three ways:

  1. Against a real PostgreSQL running the actual `resolve_entitlement`
     (supabase/migrations/0026), row for row across a dozen scenarios, plus
     one deterministic instant — a subscription whose `current_period_end` is
     Postgres's own `now()`, to the microsecond — which is exactly where a
     `>=` mistake and the correct `>` disagree.
  2. The hand-run table rebuilds the pull request asks the owner to run by
     hand, applied to a real in-memory D1 schema, proving old data survives,
     the widened values are accepted, the previously-invalid ones still are
     not, and every index and trigger the old table carried still exists.
  3. `lib/billing/entitlements.ts`'s wiring: the ADMIN_EMAILS check runs
     before either backend and short-circuits both, the domain's mode decides
     which backend a normal account is resolved against, and the parity tool
     asks both regardless of that mode — which is how it catches an account
     Supabase still calls admin by database role that ADMIN_EMAILS does not
     also name.

  Every fix below was stash-verified: reverted, watched the test fail,
  restored. See the pull request for the revert/fails table.
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { SUPABASE_STUB } from "./supabase-stub.mjs";

register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const entitlementRuntime = await load("lib", "cloudflare", "entitlement-runtime.ts");
const entitlements = await load("lib", "billing", "entitlements.ts");
const promo = await load("lib", "billing", "promo.ts");
const billingReplica = await load("lib", "cloudflare", "billing-replica.ts");
const sourceClockModule = await load("lib", "cloudflare", "source-clock.ts");
const { canonicalCloudflareSourceClock } = sourceClockModule;

/* --------------------------------------------------------- D1 test harness -- */

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

function fakeR2() {
  const objects = new Map();
  return {
    async put(key, value) { objects.set(key, value); },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { arrayBuffer: async () => (value instanceof Uint8Array ? value.buffer : new TextEncoder().encode(value).buffer) };
    },
    async delete(key) { objects.delete(key); },
  };
}

function d1Through(lastMigration) {
  const database = new DatabaseSync(":memory:");
  const dir = join(ROOT, "cloudflare", "migrations");
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && name <= lastMigration)
    .sort()) {
    database.exec(readFileSync(join(dir, file), "utf8"));
  }
  return database;
}

function freshD1() {
  return d1Through("9999");
}

function prePromoD1() {
  return d1Through("0017_native_email_actions.sql");
}

/* The two hand-run rebuilds from the pull request body, verbatim. */
const WIDEN_SUBSCRIPTIONS_PROVIDER = `
PRAGMA foreign_keys=OFF;

CREATE TABLE subscriptions_widen_provider (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'apple', 'promo')),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'trialing', 'past_due', 'canceled', 'expired', 'paused', 'refunded')
  ),
  tier TEXT NOT NULL,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  original_transaction_id TEXT,
  external_price_id TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  provider_event_at TEXT,
  verified_at TEXT NOT NULL,
  raw_inline TEXT CHECK (raw_inline IS NULL OR json_valid(raw_inline)),
  raw_object_key TEXT,
  raw_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (raw_inline IS NULL OR raw_object_key IS NULL)
) STRICT;

INSERT INTO subscriptions_widen_provider (
  id, user_id, provider, status, tier, external_customer_id, external_subscription_id,
  original_transaction_id, external_price_id, current_period_end, cancel_at_period_end,
  provider_event_at, verified_at, raw_inline, raw_object_key, raw_sha256, created_at, updated_at
)
SELECT
  id, user_id, provider, status, tier, external_customer_id, external_subscription_id,
  original_transaction_id, external_price_id, current_period_end, cancel_at_period_end,
  provider_event_at, verified_at, raw_inline, raw_object_key, raw_sha256, created_at, updated_at
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_widen_provider RENAME TO subscriptions;

CREATE UNIQUE INDEX subscriptions_provider_external_unique
  ON subscriptions(provider, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_apple_original_unique
  ON subscriptions(original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;
CREATE INDEX subscriptions_user_status_idx
  ON subscriptions(user_id, status, current_period_end);

CREATE TRIGGER subscriptions_deletion_insert_guard
BEFORE INSERT ON subscriptions
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER subscriptions_deletion_update_guard
BEFORE UPDATE ON subscriptions
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER subscription_replica_cleanup_update
AFTER UPDATE OF raw_object_key ON subscriptions
WHEN OLD.raw_object_key IS NOT NULL
 AND (NEW.raw_object_key IS NULL OR NEW.raw_object_key <> OLD.raw_object_key)
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.raw_object_key, OLD.user_id, 0, 'pending', NEW.updated_at,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER subscription_replica_cleanup_delete
AFTER DELETE ON subscriptions
WHEN OLD.raw_object_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.raw_object_key, OLD.user_id, 0, 'pending', OLD.updated_at,
    OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

PRAGMA foreign_keys=ON;
`;

const WIDEN_OUTBOX_OPERATION = `
PRAGMA foreign_keys=OFF;

CREATE TABLE cloudflare_replica_outbox_widen_operation (
  task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 3 AND 512),
  operation TEXT NOT NULL CHECK (operation IN (
    'learner_profile', 'account_identity', 'username', 'progress_snapshot',
    'avatar_put', 'avatar_delete', 'stripe_billing', 'promo_subscription',
    'usage_event', 'ai_cost_event', 'ai_cost_coverage'
  )),
  subject_user_id TEXT,
  source_updated_at TEXT NOT NULL,
  payload_inline TEXT CHECK (payload_inline IS NULL OR json_valid(payload_inline)),
  payload_object_key TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 2 AND 1900000),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 2147483647),
  attempts_made INTEGER NOT NULL DEFAULT 0 CHECK (attempts_made BETWEEN 0 AND 12),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (payload_inline IS NOT NULL AND payload_object_key IS NULL)
    OR (payload_inline IS NULL AND payload_object_key IS NOT NULL)
  ),
  CHECK (
    payload_object_key IS NULL
    OR instr(payload_object_key, 'private/replica-outbox/') = 1
  ),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status = 'pending' OR (status = 'dead' AND attempts_made = 12))
) STRICT;

INSERT INTO cloudflare_replica_outbox_widen_operation (
  task_id, operation, subject_user_id, source_updated_at, payload_inline,
  payload_object_key, payload_sha256, payload_bytes, generation, attempts_made,
  status, available_at, lease_token, lease_expires_at, last_attempt_at,
  last_error_code, created_at, updated_at
)
SELECT
  task_id, operation, subject_user_id, source_updated_at, payload_inline,
  payload_object_key, payload_sha256, payload_bytes, generation, attempts_made,
  status, available_at, lease_token, lease_expires_at, last_attempt_at,
  last_error_code, created_at, updated_at
FROM cloudflare_replica_outbox;

DROP TABLE cloudflare_replica_outbox;
ALTER TABLE cloudflare_replica_outbox_widen_operation RENAME TO cloudflare_replica_outbox;

CREATE INDEX cloudflare_replica_outbox_due_idx
  ON cloudflare_replica_outbox(status, available_at, lease_expires_at);
CREATE INDEX cloudflare_replica_outbox_subject_idx
  ON cloudflare_replica_outbox(subject_user_id, status, available_at)
  WHERE subject_user_id IS NOT NULL;

CREATE TRIGGER cloudflare_replica_outbox_object_cleanup_update
AFTER UPDATE OF payload_object_key ON cloudflare_replica_outbox
WHEN OLD.payload_object_key IS NOT NULL
 AND (NEW.payload_object_key IS NULL OR NEW.payload_object_key <> OLD.payload_object_key)
 AND (
   OLD.subject_user_id IS NULL OR NOT EXISTS (
     SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.subject_user_id
   )
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, OLD.subject_user_id, 0, 'pending', NEW.updated_at,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET
    subject_user_id = coalesce(
      cloudflare_replica_object_cleanup.subject_user_id,
      excluded.subject_user_id
    ),
    attempts_made = 0,
    status = 'pending',
    available_at = min(
      cloudflare_replica_object_cleanup.available_at,
      excluded.available_at
    ),
    last_error_code = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER cloudflare_replica_outbox_object_cleanup_delete
AFTER DELETE ON cloudflare_replica_outbox
WHEN OLD.payload_object_key IS NOT NULL
 AND (
   OLD.subject_user_id IS NULL OR NOT EXISTS (
     SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.subject_user_id
   )
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, OLD.subject_user_id, 0, 'pending', OLD.updated_at,
    OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET
    subject_user_id = coalesce(
      cloudflare_replica_object_cleanup.subject_user_id,
      excluded.subject_user_id
    ),
    attempts_made = 0,
    status = 'pending',
    available_at = min(
      cloudflare_replica_object_cleanup.available_at,
      excluded.available_at
    ),
    last_error_code = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER cloudflare_replica_outbox_deletion_insert_guard
BEFORE INSERT ON cloudflare_replica_outbox
WHEN NEW.subject_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.subject_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER cloudflare_replica_outbox_deletion_update_guard
BEFORE UPDATE ON cloudflare_replica_outbox
WHEN NEW.subject_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.subject_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

PRAGMA foreign_keys=ON;
`;

function widenedD1() {
  return freshD1();
}

test("the shipped promo migration remains equivalent to the reviewed rebuilds", () => {
  const migration = readFileSync(
    join(ROOT, "cloudflare", "migrations", "0018_promo_subscription_replica.sql"),
    "utf8",
  );
  const normaliseSql = (value) => value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "")
    .replaceAll(";", "");
  assert.equal(
    normaliseSql(migration),
    normaliseSql(`${WIDEN_SUBSCRIPTIONS_PROVIDER}\n${WIDEN_OUTBOX_OPERATION}`),
  );
});

/* ------------------------------------------------------- hand-run rebuilds -- */

test("the shipped subscriptions.provider widening preserves data, indexes and triggers", () => {
  const database = prePromoD1();
  database.exec(`INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES ('50000000-0000-4000-8000-000000000001', 'a@example.test', 'user', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);
  database.exec(`INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
    VALUES ('sub-existing', '50000000-0000-4000-8000-000000000001', 'stripe', 'active', 'pro', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);

  database.exec(WIDEN_SUBSCRIPTIONS_PROVIDER);

  assert.deepEqual(
    { ...database.prepare("SELECT id, provider FROM subscriptions WHERE id='sub-existing'").get() },
    { id: "sub-existing", provider: "stripe" },
  );

  database.exec(`INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
    VALUES ('sub-promo', '50000000-0000-4000-8000-000000000001', 'promo', 'active', 'pro', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);

  assert.throws(() => database.exec(`INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
    VALUES ('sub-bogus', '50000000-0000-4000-8000-000000000001', 'bogus', 'active', 'pro', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`), /provider/);

  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='subscriptions'").all().map((r) => r.name);
  for (const name of ["subscriptions_provider_external_unique", "subscriptions_apple_original_unique", "subscriptions_user_status_idx"]) {
    assert.ok(indexes.includes(name), `missing index ${name}`);
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='subscriptions'").all().map((r) => r.name);
  for (const name of ["subscriptions_deletion_insert_guard", "subscriptions_deletion_update_guard", "subscription_replica_cleanup_update", "subscription_replica_cleanup_delete"]) {
    assert.ok(triggers.includes(name), `missing trigger ${name}`);
  }

  database.exec(`INSERT INTO account_deletion_tombstones (user_id, operation_id, state, prepared_at, lease_expires_at, updated_at)
    VALUES ('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000099', 'prepared', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:01:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);
  assert.throws(() => database.exec(`INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
    VALUES ('sub-blocked', '50000000-0000-4000-8000-000000000001', 'promo', 'active', 'pro', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`), /account deletion is in progress/);
});

test("the shipped outbox operation widening preserves the queue and its triggers", () => {
  const database = prePromoD1();
  database.exec(`INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES ('50000000-0000-4000-8000-000000000001', 'a@example.test', 'user', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);
  database.exec(`INSERT INTO cloudflare_replica_outbox (task_id, operation, subject_user_id, source_updated_at, payload_inline, payload_sha256, payload_bytes, available_at, created_at, updated_at)
    VALUES ('task-existing', 'stripe_billing', '50000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000000000Z', '{}', '${"0".repeat(64)}', 2, '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);

  database.exec(WIDEN_OUTBOX_OPERATION);

  assert.deepEqual(
    { ...database.prepare("SELECT task_id, operation FROM cloudflare_replica_outbox WHERE task_id='task-existing'").get() },
    { task_id: "task-existing", operation: "stripe_billing" },
  );

  database.exec(`INSERT INTO cloudflare_replica_outbox (task_id, operation, subject_user_id, source_updated_at, payload_inline, payload_sha256, payload_bytes, available_at, created_at, updated_at)
    VALUES ('task-promo', 'promo_subscription', '50000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000000000Z', '{}', '${"0".repeat(64)}', 2, '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`);

  assert.throws(() => database.exec(`INSERT INTO cloudflare_replica_outbox (task_id, operation, subject_user_id, source_updated_at, payload_inline, payload_sha256, payload_bytes, available_at, created_at, updated_at)
    VALUES ('task-bogus', 'bogus_operation', '50000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000000000Z', '{}', '${"0".repeat(64)}', 2, '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`), /operation/);

  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cloudflare_replica_outbox'").all().map((r) => r.name);
  for (const name of ["cloudflare_replica_outbox_due_idx", "cloudflare_replica_outbox_subject_idx"]) {
    assert.ok(indexes.includes(name), `missing index ${name}`);
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='cloudflare_replica_outbox'").all().map((r) => r.name);
  for (const name of [
    "cloudflare_replica_outbox_object_cleanup_update",
    "cloudflare_replica_outbox_object_cleanup_delete",
    "cloudflare_replica_outbox_deletion_insert_guard",
    "cloudflare_replica_outbox_deletion_update_guard",
  ]) {
    assert.ok(triggers.includes(name), `missing trigger ${name}`);
  }
});

/* ------------------------------------------------- promo mirror + resolver -- */

test("replicateAuthoritativePromoState writes a provider='promo' D1 row and the resolver reads it back", async () => {
  const database = widenedD1();
  const bindings = { db: runtimeD1(database), files: fakeR2() };
  const row = {
    id: "50000000-0000-4000-8000-0000000000aa",
    userId: "50000000-0000-4000-8000-000000000001",
    status: "active",
    tier: "pro",
    currentPeriodEnd: null,
    raw: { kind: "free-pro-trial", acceptedAt: "2026-08-17T00:00:00.000Z" },
    verifiedAt: "2026-08-17T00:00:00.000Z",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
  assert.equal(await billingReplica.replicateAuthoritativePromoState(row, bindings), true);

  const stored = database.prepare("SELECT provider, status, tier, current_period_end FROM subscriptions WHERE id = ?").get(row.id);
  assert.deepEqual({ ...stored }, { provider: "promo", status: "active", tier: "pro", current_period_end: null });

  const resolved = await entitlementRuntime.resolveEntitlementFromCloudflare(row.userId, bindings);
  assert.deepEqual(resolved, { tier: "pro", source: "promo", expires_at: null });
});

test("a stale (older updated_at) promo replay does not clobber a newer status", async () => {
  const database = widenedD1();
  const bindings = { db: runtimeD1(database), files: fakeR2() };
  const base = {
    id: "50000000-0000-4000-8000-0000000000bb",
    userId: "50000000-0000-4000-8000-000000000002",
    tier: "pro",
    currentPeriodEnd: null,
    raw: { kind: "free-pro-trial", acceptedAt: "2026-08-01T00:00:00.000Z" },
    verifiedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  await billingReplica.replicateAuthoritativePromoState(
    { ...base, status: "active", updatedAt: "2026-08-01T00:00:00.000Z" },
    bindings,
  );
  // A learner gives the trial up: a newer write pauses it.
  await billingReplica.replicateAuthoritativePromoState(
    { ...base, status: "paused", updatedAt: "2026-08-10T00:00:00.000Z" },
    bindings,
  );
  // A retried, older-dated task for the original acceptance replays late.
  await billingReplica.replicateAuthoritativePromoState(
    { ...base, status: "active", updatedAt: "2026-08-01T00:00:00.000Z" },
    bindings,
  );
  const stored = database.prepare("SELECT status FROM subscriptions WHERE id = ?").get(base.id);
  assert.equal(stored.status, "paused", "a stale replay must not resurrect a status the learner already changed");

  const resolved = await entitlementRuntime.resolveEntitlementFromCloudflare(base.userId, bindings);
  assert.equal(resolved.tier, "free", "'paused' must grant nothing");
});

/* ---------------------------------------------- Postgres <-> D1 boundary --- */

const MIGRATIONS = join(ROOT, "supabase", "migrations");
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function findPostgresBin() {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  for (const version of readdirSync(base).filter((value) => /^\d+$/.test(value)).sort((a, b) => Number(b) - Number(a))) {
    const bin = join(base, version, "bin");
    if (existsSync(join(bin, "initdb")) && existsSync(join(bin, "psql"))) return bin;
  }
  return null;
}

function runner(bin, dir) {
  return (command, args, options = {}) => {
    const executable = join(bin, command);
    const base = { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd: dir, ...options };
    return AS_ROOT
      ? execFileSync("runuser", ["-u", "postgres", "--", executable, ...args], base)
      : execFileSync(executable, args, base);
  };
}

function provision() {
  const bin = findPostgresBin();
  if (!bin) return { skip: "no PostgreSQL installation found under /usr/lib/postgresql" };
  if (AS_ROOT) {
    try { execFileSync("id", ["postgres"], { stdio: "ignore" }); }
    catch { return { skip: "running as root with no postgres account" }; }
  }
  const dir = mkdtempSync(join(tmpdir(), "bandup-entitlement-parity-pg-"));
  const data = join(dir, "data");
  const socket = join(dir, "sock");
  try {
    execFileSync("mkdir", ["-p", socket]);
    if (AS_ROOT) execFileSync("chown", ["-R", "postgres:postgres", dir]);
    const run = runner(bin, dir);
    run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    run("pg_ctl", ["-D", data, "-o", `-p 5432 -k ${socket} -c listen_addresses='' -c fsync=off`, "-w", "-l", join(dir, "log"), "start"]);
    const psql = (sql) => run("psql", ["-h", socket, "-p", "5432", "-U", "postgres", "-d", "postgres", "-tAq", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
    const psqlFile = (file) => run("psql", ["-h", socket, "-p", "5432", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);
    return { dir, data, run, psql, psqlFile };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return { skip: `could not start a cluster (${error instanceof Error ? error.message.split("\n")[0] : error})` };
  }
}

function teardown(pg) {
  try { pg.run("pg_ctl", ["-D", pg.data, "-m", "immediate", "-w", "stop"]); } catch { /* already stopped */ }
  rmSync(pg.dir, { recursive: true, force: true });
}

/** One nine-digit-fraction unit before a canonical clock string, for a precise boundary test. */
function oneUnitEarlier(canonical) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{9})Z$/.exec(canonical);
  if (!match) throw new Error(`not a canonical clock string: ${canonical}`);
  const [, whole, fraction] = match;
  const fractionNum = BigInt(fraction);
  if (fractionNum > 0n) {
    return `${whole}.${(fractionNum - 1n).toString().padStart(9, "0")}Z`;
  }
  const prevSecond = new Date(new Date(`${whole}Z`).getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, "");
  return `${prevSecond}.999999999Z`;
}

/** Inserts the same logical row into both databases, in each one's own shape. */
function mirrorScenario(pg, database, { userId, subs }) {
  pg.psql(`insert into auth.users (id, email) values ('${userId}'::uuid, '${userId}@example.test') on conflict (id) do nothing`);
  for (const sub of subs) {
    pg.psql(`insert into public.subscriptions (id, user_id, provider, status, tier, current_period_end, verified_at)
      values ('${sub.id}'::uuid, '${userId}'::uuid, '${sub.provider}', '${sub.status}', '${sub.tier}',
        ${sub.currentPeriodEnd ? `'${sub.currentPeriodEnd}'::timestamptz` : "null"}, '${sub.verifiedAt}'::timestamptz)`);
    database.prepare(`INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, ?, 'user', ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(userId, `${userId}@example.test`, canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"), canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"));
    database.prepare(`INSERT INTO subscriptions (id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sub.id, userId, sub.provider, sub.status, sub.tier,
      sub.currentPeriodEnd ? canonicalCloudflareSourceClock(sub.currentPeriodEnd) : null,
      canonicalCloudflareSourceClock(sub.verifiedAt),
      canonicalCloudflareSourceClock(sub.verifiedAt),
      canonicalCloudflareSourceClock(sub.verifiedAt),
    );
  }
}

test("D1 resolveEntitlementFromCloudflare agrees with Postgres resolve_entitlement, row for row", async (t) => {
  const pg = provision();
  if (pg.skip) {
    t.diagnostic(`skipped: ${pg.skip}`);
    return;
  }
  const database = widenedD1();
  try {
    const stub = join(pg.dir, "stub.sql");
    execFileSync("tee", [stub], { input: SUPABASE_STUB, stdio: ["pipe", "ignore", "ignore"] });
    if (AS_ROOT) execFileSync("chown", ["postgres:postgres", stub]);
    pg.psqlFile(stub);
    for (const name of readdirSync(MIGRATIONS).filter((value) => value.endsWith(".sql")).sort()) {
      const copy = join(pg.dir, name);
      execFileSync("tee", [copy], { input: readFileSync(join(MIGRATIONS, name)), stdio: ["pipe", "ignore", "ignore"] });
      if (AS_ROOT) execFileSync("chown", ["postgres:postgres", copy]);
      pg.psqlFile(copy);
    }
    // The provider check on Postgres's own side is the one #129/#138 already
    // ask the owner to widen by hand — do the same here so a promo row can
    // exist to compare against.
    pg.psql(`alter table public.subscriptions
      drop constraint subscriptions_provider_check,
      add constraint subscriptions_provider_check check (provider in ('stripe', 'apple', 'promo'))`);

    const bindings = { db: runtimeD1(database), files: fakeR2() };

    /*
      Offsets from *real* wall-clock time, not a fixed fictional instant.
      `resolveEntitlementFromCloudflare` reads `new Date()` when no `now`
      override is passed, and `new Date()` does not observe a monkey-patched
      `Date.now` — V8 calls its own internal clock rather than the
      (possibly overridden) static property — so there is no way to freeze
      "now" for it short of the explicit override tested separately below.
      Day-scale margins absorb the seconds a real Postgres round trip and a
      real D1 query can cost between "the fixture decided this row's period
      end" and "each database asked what time it is", without depending on
      the two ever agreeing to the millisecond.
    */
    const day = 24 * 60 * 60 * 1000;
    const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

    const scenarios = [
      {
        name: "one active row",
        userId: "50000000-0000-4000-8000-000000000010",
        subs: [{ id: "60000000-0000-4000-8000-000000000010", provider: "stripe", status: "active", tier: "plus", currentPeriodEnd: iso(30 * day), verifiedAt: iso(-16 * day) }],
      },
      {
        name: "overlapping tiers, rank picks the higher one regardless of dates",
        userId: "50000000-0000-4000-8000-000000000011",
        subs: [
          { id: "60000000-0000-4000-8000-000000000011", provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: iso(2 * day), verifiedAt: iso(-2 * day) },
          { id: "60000000-0000-4000-8000-000000000012", provider: "apple", status: "trialing", tier: "plus", currentPeriodEnd: iso(730 * day), verifiedAt: iso(0) },
        ],
      },
      {
        name: "expired, refunded and canceled rows all grant nothing; only 'standard' status counts",
        userId: "50000000-0000-4000-8000-000000000012",
        subs: [
          { id: "60000000-0000-4000-8000-000000000013", provider: "stripe", status: "expired", tier: "pro", currentPeriodEnd: iso(150 * day), verifiedAt: iso(-16 * day) },
          { id: "60000000-0000-4000-8000-000000000014", provider: "apple", status: "refunded", tier: "pro", currentPeriodEnd: iso(150 * day), verifiedAt: iso(-16 * day) },
          { id: "60000000-0000-4000-8000-000000000015", provider: "stripe", status: "canceled", tier: "pro", currentPeriodEnd: iso(150 * day), verifiedAt: iso(-16 * day) },
          { id: "60000000-0000-4000-8000-000000000016", provider: "apple", status: "trialing", tier: "standard", currentPeriodEnd: iso(3 * day), verifiedAt: iso(-16 * day) },
        ],
      },
      {
        name: "expired long ago grants nothing",
        userId: "50000000-0000-4000-8000-000000000013",
        subs: [{ id: "60000000-0000-4000-8000-000000000017", provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: iso(-30 * day), verifiedAt: iso(-60 * day) }],
      },
      {
        name: "expires well into the future still grants",
        userId: "50000000-0000-4000-8000-000000000014",
        subs: [{ id: "60000000-0000-4000-8000-000000000018", provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: iso(30 * day), verifiedAt: iso(-16 * day) }],
      },
      {
        name: "no period end never expires",
        userId: "50000000-0000-4000-8000-000000000015",
        subs: [{ id: "60000000-0000-4000-8000-000000000019", provider: "promo", status: "active", tier: "pro", currentPeriodEnd: null, verifiedAt: iso(-16 * day) }],
      },
      {
        name: "a paused promo grant is free, exactly like Postgres",
        userId: "50000000-0000-4000-8000-000000000016",
        subs: [{ id: "60000000-0000-4000-8000-00000000001a", provider: "promo", status: "paused", tier: "pro", currentPeriodEnd: null, verifiedAt: iso(-16 * day) }],
      },
      {
        name: "no subscription at all resolves to free/default",
        userId: "50000000-0000-4000-8000-000000000017",
        subs: [],
      },
      {
        name: "tie-break: same tier and period, the later-verified row wins",
        userId: "50000000-0000-4000-8000-000000000018",
        subs: [
          { id: "60000000-0000-4000-8000-00000000001b", provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: iso(14 * day), verifiedAt: iso(-16 * day) },
          { id: "60000000-0000-4000-8000-00000000001c", provider: "apple", status: "active", tier: "pro", currentPeriodEnd: iso(14 * day), verifiedAt: iso(-7 * day) },
        ],
      },
      {
        // Same tier and rank; one row never expires and the other does. If a
        // SQLite `ORDER BY current_period_end DESC` were used without the
        // "nulls first" adjustment, SQLite would put the NULL row *last*
        // (opposite of Postgres), so this row's dated sibling would win the
        // tie-break instead — same tier, but a wrong (non-null) `expires_at`.
        name: "nulls-first tie-break: a never-expiring row outranks a dated one at the same tier",
        userId: "50000000-0000-4000-8000-000000000019",
        subs: [
          { id: "60000000-0000-4000-8000-00000000001d", provider: "promo", status: "active", tier: "pro", currentPeriodEnd: null, verifiedAt: iso(-16 * day) },
          { id: "60000000-0000-4000-8000-00000000001e", provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: iso(14 * day), verifiedAt: iso(-16 * day) },
        ],
      },
    ];

    for (const scenario of scenarios) {
      mirrorScenario(pg, database, scenario);
    }

    for (const scenario of scenarios) {
      const pgRow = JSON.parse(pg.psql(
        `select row_to_json(public.resolve_entitlement('${scenario.userId}'::uuid))`,
      ));
      const d1Row = await entitlementRuntime.resolveEntitlementFromCloudflare(scenario.userId, bindings);
      assert.equal(d1Row.tier, pgRow.tier, `${scenario.name}: tier`);
      assert.equal(d1Row.source, pgRow.source, `${scenario.name}: source`);
      const pgExpires = pgRow.expires_at ? new Date(pgRow.expires_at).toISOString() : null;
      const d1Expires = d1Row.expires_at ? new Date(d1Row.expires_at).toISOString() : null;
      assert.equal(d1Expires, pgExpires, `${scenario.name}: expires_at`);
    }

    /*
      The boundary itself, deterministically: a row whose `current_period_end`
      is Postgres's own `now()`, to the microsecond — the one instant where a
      `>=` mistake and a `>` correct answer disagree. `resolve_entitlement`
      only ever asks Postgres's own clock, so there is no way to hold *that*
      still; instead this reads it once and feeds the identical value to the
      D1 side's `now` override, so both are judged against the same instant
      rather than two clocks that merely agree to the day.
    */
    const pgNow = pg.psql(`select to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
    const boundaryUser = "50000000-0000-4000-8000-00000000001f";
    const boundarySub = "60000000-0000-4000-8000-00000000001f";
    mirrorScenario(pg, database, {
      userId: boundaryUser,
      subs: [{ id: boundarySub, provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: pgNow, verifiedAt: pgNow }],
    });
    const pgBoundary = JSON.parse(pg.psql(`select row_to_json(public.resolve_entitlement('${boundaryUser}'::uuid))`));
    assert.equal(pgBoundary.tier, "free", "Postgres: current_period_end equal to now() must not count as still current");
    const d1AtNow = await entitlementRuntime.resolveEntitlementFromCloudflare(
      boundaryUser, bindings, canonicalCloudflareSourceClock(pgNow),
    );
    assert.equal(d1AtNow.tier, "free", "D1: current_period_end equal to now must not count as still current (strict '>', not '>=')");
    const justBeforeNow = oneUnitEarlier(canonicalCloudflareSourceClock(pgNow));
    const d1JustBefore = await entitlementRuntime.resolveEntitlementFromCloudflare(
      boundaryUser, bindings, justBeforeNow,
    );
    assert.equal(d1JustBefore.tier, "pro", "D1: current_period_end fractionally after 'now' must still grant");
  } finally {
    teardown(pg);
  }
});

/* --------------------------------------------------- entitlements.ts wiring -- */

async function withStubbedSupabase(responder, fn) {
  const saved = {
    fetch: globalThis.fetch,
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anon: process.env.SUPABASE_ANON_KEY,
  };
  const calls = [];
  process.env.SUPABASE_URL = "https://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub-key";
  process.env.SUPABASE_ANON_KEY = "anon-stub-key";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const outcome = responder(String(url), calls.length);
    return new Response(JSON.stringify(outcome), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.service], ["SUPABASE_ANON_KEY", saved.anon]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

test("ADMIN_EMAILS short-circuits before either backend is asked anything", async () => {
  const saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "owner@example.test";
  delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  try {
    // No fetch stub and no fake D1 context installed: if either backend were
    // asked, this would throw (fetch to a real host, or a missing binding).
    const result = await entitlements.resolveEntitlement(
      "50000000-0000-4000-8000-000000000099",
      "owner@example.test",
    );
    assert.deepEqual(result, { role: "admin", tier: "admin", source: "role", expiresAt: null });
  } finally {
    if (saved === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = saved;
  }
});

test("resolveEntitlement asks Supabase when the domain's mode is not Cloudflare (the default)", async () => {
  await withDomainMode(undefined, async () => {
    await withStubbedSupabase(
      () => ({ role: "user", tier: "plus", source: "stripe", expires_at: null }),
      async (calls) => {
        const result = await entitlements.resolveEntitlement("50000000-0000-4000-8000-000000000020", "learner@example.test");
        assert.deepEqual(result, { role: "user", tier: "plus", source: "stripe", expiresAt: null });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /resolve_entitlement/);
      },
    );
  });
});

test("resolveEntitlement asks Cloudflare when the domain's override says read_cloudflare", async () => {
  await withDomainMode("read_cloudflare", async () => {
    const database = widenedD1();
    globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: runtimeD1(database), BANDUP_FILES: fakeR2() } };
    try {
      const userId = "50000000-0000-4000-8000-000000000021";
      database.prepare(`INSERT INTO app_users (id, email, role, created_at, updated_at)
        VALUES (?, ?, 'user', ?, ?)`).run(userId, "learner2@example.test", canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"), canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"));
      database.prepare(`INSERT INTO subscriptions (id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at)
        VALUES (?, ?, 'stripe', 'active', 'plus', NULL, ?, ?, ?)`).run(
        "60000000-0000-4000-8000-000000000021", userId,
        canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"), canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"), canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"),
      );
      await withStubbedSupabase(
        () => { throw new Error("must not call Supabase in this mode"); },
        async () => {
          const result = await entitlements.resolveEntitlement(userId, "learner2@example.test");
          assert.deepEqual(result, { role: "user", tier: "plus", source: "stripe", expiresAt: null });
        },
      );
    } finally {
      delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    }
  });
});

test("resolveEntitlementForParity asks both backends regardless of mode, and surfaces a database-role admin ADMIN_EMAILS no longer names", async () => {
  await withDomainMode(undefined, async () => {
    const database = widenedD1();
    globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: runtimeD1(database), BANDUP_FILES: fakeR2() } };
    const savedAdmins = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "current-owner@example.test";
    try {
      const userId = "50000000-0000-4000-8000-000000000022";
      // Nothing in D1 for this account: a role-only admin never had a
      // subscription row, in either database.
      await withStubbedSupabase(
        () => ({ role: "admin", tier: "admin", source: "role", expires_at: null }),
        async () => {
          const pair = await entitlements.resolveEntitlementForParity(userId, "retired-admin@example.test");
          assert.equal(pair.supabase.tier, "admin");
          assert.equal(pair.supabase.source, "role");
          assert.equal(pair.cloudflare.tier, "free", "D1 never grants admin by role");
          assert.equal(pair.cloudflare.source, "default");
        },
      );

      // The account ADMIN_EMAILS *does* still name: both sides agree without
      // touching either backend.
      const adminPair = await entitlements.resolveEntitlementForParity(userId, "current-owner@example.test");
      assert.deepEqual(adminPair.supabase, adminPair.cloudflare);
      assert.equal(adminPair.supabase.tier, "admin");
    } finally {
      delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
      if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = savedAdmins;
    }
  });
});

/* --------------------------------------------------------- promo write path -- */

test("accepting the trial mirrors a promo row to D1 only when mirrorsWritesToCloudflare() is true", async () => {
  const database = widenedD1();
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: runtimeD1(database), BANDUP_FILES: fakeR2() } };
  const savedMode = process.env.CLOUDFLARE_DATA_MODE;
  process.env.CLOUDFLARE_DATA_MODE = "dual";
  const userId = "50000000-0000-4000-8000-000000000030";
  const subscriptionId = "60000000-0000-4000-8000-000000000030";
  const now = "2026-08-17T00:00:00.000000Z";
  // The capability probe (promoProviderAllowed) inserts and deletes its own
  // row for the all-zero uuid; skipping past it here rather than modelling it
  // keeps the state machine below about the one account this test cares
  // about, not about a probe every real caller already pays for once.
  promo.forgetPromoCapability?.();
  try {
    let inserted = false;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (/\/rpc\/resolve_entitlement/.test(u)) {
        return Response.json({ role: "user", tier: "free", source: "default", expires_at: null });
      }
      // The capability probe: any write naming the all-zero uuid.
      if (body?.user_id === "00000000-0000-0000-0000-000000000000") {
        return init.method === "POST" ? new Response(null, { status: 201 }) : new Response(null, { status: 204 });
      }
      if (init.method === "GET" && u.includes(`user_id=eq.${userId}`) && u.includes("provider=eq.promo") && !u.includes("order=")) {
        return Response.json(inserted ? [{ id: subscriptionId }] : []);
      }
      if (init.method === "POST" && u.endsWith("/subscriptions") && body?.user_id === userId) {
        inserted = true;
        return new Response(null, { status: 201 });
      }
      if (init.method === "GET" && u.includes(`user_id=eq.${userId}`) && u.includes("order=created_at.desc")) {
        return Response.json(inserted ? [{
          id: subscriptionId,
          user_id: userId,
          status: "active",
          tier: "pro",
          current_period_end: null,
          raw: { kind: "free-pro-trial", acceptedAt: now },
          verified_at: now,
          created_at: now,
          updated_at: now,
        }] : []);
      }
      throw new Error(`unexpected fetch: ${init.method} ${u} ${init.body ?? ""}`);
    };
    process.env.SUPABASE_URL = "https://stub.supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub-key";
    process.env.SUPABASE_ANON_KEY = "anon-stub-key";

    const outcome = await promo.acceptPromo(userId, "learner3@example.test");
    assert.equal(outcome, "granted");

    const stored = database.prepare("SELECT provider, status, tier FROM subscriptions WHERE user_id = ?").get(userId);
    assert.deepEqual({ ...stored }, { provider: "promo", status: "active", tier: "pro" });
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    delete globalThis.fetch;
    if (savedMode === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = savedMode;
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]) delete process.env[key];
  }
});

test("accepting the trial does not touch D1 when the deployment is not mirroring writes", async () => {
  const savedMode = process.env.CLOUDFLARE_DATA_MODE;
  delete process.env.CLOUDFLARE_DATA_MODE; // "supabase": mirrorsWritesToCloudflare() is false
  delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__; // proves nothing tries to reach D1
  const userId = "50000000-0000-4000-8000-000000000031";
  const subscriptionId = "60000000-0000-4000-8000-000000000031";
  // Relies on the previous test having already cached a "yes" for the
  // capability probe (see the module comment on `capability` in
  // lib/billing/promo.ts: "for ever once it is yes"). A "yes" already cached
  // means this test's own accept never triggers a fresh probe, so the state
  // machine below only has the real account's requests to model.
  try {
    let inserted = false;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (/resolve_entitlement/.test(u)) return Response.json({ role: "user", tier: "free", source: "default", expires_at: null });
      if (init.method === "GET" && u.includes(`user_id=eq.${userId}`) && u.includes("provider=eq.promo")) {
        return Response.json(inserted ? [{ id: subscriptionId }] : []);
      }
      if (init.method === "POST" && u.endsWith("/subscriptions") && body?.user_id === userId) {
        inserted = true;
        return new Response(null, { status: 201 });
      }
      throw new Error(`unexpected fetch: ${init.method} ${u} ${init.body ?? ""}`);
    };
    process.env.SUPABASE_URL = "https://stub.supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub-key";
    process.env.SUPABASE_ANON_KEY = "anon-stub-key";

    const outcome = await promo.acceptPromo(userId, "learner4@example.test");
    assert.equal(outcome, "granted");
  } finally {
    delete globalThis.fetch;
    if (savedMode === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = savedMode;
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]) delete process.env[key];
  }
});

test("replicatePromoSubscriptionDurably uses a stable per-account task id, so retries coalesce", () => {
  const source = readFileSync(join(ROOT, "lib", "cloudflare", "replica-replay.ts"), "utf8");
  assert.match(source, /taskId: `promo:\$\{authoritative\.userId\}`/);
});

test("the registry marks billing entitlement supported after the native payment migration", () => {
  const registry = readFileSync(join(ROOT, "lib", "cloudflare", "cutover-domains.ts"), "utf8");
  assert.match(registry, /domain: "billing_entitlement_runtime"/);
  assert.match(registry, /CLOUDFLARE_NATIVE_STRIPE_BILLING/);
  assert.match(registry, /reconciled before/);
  assert.match(registry, /billing_entitlement_runtime[\s\S]{0,500}supported: true/);
});

test("the D1 resolver never reads a role, keeping ADMIN_EMAILS the only admin authority", () => {
  const source = readFileSync(join(ROOT, "lib", "cloudflare", "entitlement-runtime.ts"), "utf8");
  const query = source.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(query, /\brole\b/);
  assert.doesNotMatch(query, /profiles/);
});
