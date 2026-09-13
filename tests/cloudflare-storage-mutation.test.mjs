/*
  Mutation-killing tests for the lib/cloudflare replica/authority/storage
  layer: the app-settings replica, the AI-cost ledger's read and write
  authority gates, account-status assembly, avatar R2 storage/delivery, and
  the payload inline-vs-R2 helpers.

  Same conventions as the other tests/cloudflare-*.test.mjs files: a real
  in-memory D1 (node:sqlite loaded with the actual cloudflare/migrations
  SQL) where a module talks to D1 shaped bindings, and a hand-rolled stub
  where a module's own contract is narrow enough that a real database adds
  nothing (account-status.ts, avatar-storage.ts). Every test asserts on a
  return value, a thrown message, or a recorded side effect — never on
  source text — because a mutation only dies to a difference an importer of
  the module could actually observe.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const appSettings = await load("lib", "cloudflare", "app-settings.ts");
const aiCostRead = await load("lib", "cloudflare", "ai-cost-read-authority.ts");
const aiCostWrite = await load("lib", "cloudflare", "ai-cost-write-authority.ts");
const accountStatus = await load("lib", "cloudflare", "account-status.ts");
const avatarDelivery = await load("lib", "cloudflare", "avatar-delivery.ts");
const avatarStorage = await load("lib", "cloudflare", "avatar-storage.ts");
const avatarParity = await load("lib", "cloudflare", "avatar-parity.ts");
const payloads = await load("lib", "cloudflare", "payloads.ts");
const payloadCanonical = await load("lib", "cloudflare", "payload-canonical.ts");

/*
  assertServerOnly (lib/auth/server-only.ts) only throws when `window` is
  defined. It never does anything else observable, so the only way to prove
  a call to it is actually still there — rather than deleted by a mutant —
  is to define `window` for one call and expect the throw.
*/
async function withFakeWindow(work) {
  globalThis.window = {};
  try {
    return await work();
  } finally {
    delete globalThis.window;
  }
}

function runtimeD1(database) {
  const bound = (sql, values) => ({
    async run() {
      const result = database.prepare(sql).run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
    },
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
      return Promise.all(statements.map((s) => s.run ? s.run() : s));
    },
  };
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return database;
}

function fixture() {
  const database = migratedDatabase();
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

/** An in-memory stand-in for the R2 binding. */
function filesStub() {
  const store = new Map();
  const puts = [];
  return {
    async put(key, bytes, options) {
      store.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      puts.push({ key, options });
    },
    async get(key) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    async delete(key) {
      store.delete(key);
    },
    _store: store,
    _puts: puts,
  };
}

const ACTOR = "10000000-0000-4000-8000-000000000001";
const OLD = "2026-08-14T08:00:00.000Z";
const NEW = "2026-08-14T09:00:00.000Z";

function seedActor(context) {
  context.database.prepare(`
    INSERT INTO app_users (id,email,role,created_at,updated_at)
    VALUES (?, 'owner@example.test', 'admin', ?, ?)
  `).run(ACTOR, OLD, OLD);
}

/* ------------------------------------------------------------------------ *
 * app-settings.ts
 * ------------------------------------------------------------------------ */

function baseRecord(overrides = {}) {
  return {
    key: "maintenance",
    value: { closed: false },
    updatedAt: OLD,
    updatedBy: ACTOR,
    ...overrides,
  };
}

test("app-settings: key length is validated at both boundaries, on both sides", async () => {
  const context = fixture();
  seedActor(context);

  await assert.rejects(
    () => appSettings.putCloudflareAppSetting(baseRecord({ key: "" }), context.bindings),
    /Cloudflare app setting key is invalid/,
  );
  await assert.rejects(
    () => appSettings.putCloudflareAppSetting(baseRecord({ key: "k".repeat(121) }), context.bindings),
    /Cloudflare app setting key is invalid/,
  );
  // Exactly 1 and exactly 120 characters must both be accepted, not rejected
  // by an off-by-one on either boundary.
  assert.equal(await appSettings.putCloudflareAppSetting(baseRecord({ key: "k" }), context.bindings), true);
  assert.equal(
    await appSettings.putCloudflareAppSetting(baseRecord({ key: "k".repeat(120) }), context.bindings),
    true,
  );
});

test("app-settings: updatedAt must parse as a date, with the exact message", async () => {
  const context = fixture();
  seedActor(context);
  await assert.rejects(
    () => appSettings.putCloudflareAppSetting(baseRecord({ updatedAt: "not-a-timestamp" }), context.bindings),
    /Cloudflare app setting clock is invalid/,
  );
});

test("app-settings: updatedBy length is validated at both boundaries, on both sides", async () => {
  const context = fixture();
  seedActor(context);
  const actorOfLength = (n) => n === 0 ? null : "a".repeat(n);

  // 15 and 81 are one past each boundary and must be rejected.
  await assert.rejects(
    () => appSettings.putCloudflareAppSetting(baseRecord({ updatedBy: actorOfLength(15) }), context.bindings),
    /Cloudflare app setting actor is invalid/,
  );
  await assert.rejects(
    () => appSettings.putCloudflareAppSetting(baseRecord({ updatedBy: actorOfLength(81) }), context.bindings),
    /Cloudflare app setting actor is invalid/,
  );
  // 16 and 80 are exactly on the boundary and must be accepted.
  assert.equal(
    await appSettings.putCloudflareAppSetting(baseRecord({ updatedBy: actorOfLength(16) }), context.bindings),
    true,
  );
  assert.equal(
    await appSettings.putCloudflareAppSetting(baseRecord({ updatedBy: actorOfLength(80) }), context.bindings),
    true,
  );
});

test("app-settings: putCloudflareAppSetting still validates before writing (the call is not dropped)", async () => {
  const context = fixture();
  seedActor(context);
  await assert.rejects(
    () => appSettings.putCloudflareAppSetting(baseRecord({ key: "" }), context.bindings),
    /key is invalid/,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM app_settings").get().n,
    0,
    "an invalid record must never reach the INSERT",
  );
});

test("app-settings: setCloudflareAppSetting surfaces a write failure with its own message", async () => {
  const failingBindings = {
    db: {
      prepare() {
        return { bind: () => ({ async run() { return { success: false, results: [], meta: { changes: 0 } }; } }) };
      },
    },
    files: {},
  };
  await assert.rejects(
    () => appSettings.setCloudflareAppSetting("k", { a: 1 }, null, failingBindings),
    /Cloudflare app setting write failed/,
  );
});

test("app-settings: canonical() sorts object keys recursively before hashing/equality", async () => {
  const context = fixture();
  seedActor(context);
  const outOfOrder = baseRecord({ key: "order-check", value: { b: 1, a: { d: 2, c: 1 } } });
  await appSettings.putCloudflareAppSetting(outOfOrder, context.bindings);
  const row = context.database.prepare("SELECT value_json FROM app_settings WHERE key = 'order-check'").get();
  assert.equal(row.value_json, '{"a":{"c":1,"d":2},"b":1}');
});

test("app-settings: canonicalJson refuses a value JSON.stringify cannot represent", async () => {
  const source = baseRecord({ value: undefined });
  const target = { ...source, value: undefined, mirroredAt: NEW };
  assert.throws(
    () => appSettings.appSettingRecordsEqual(source, target),
    /Cloudflare app setting value is not JSON/,
  );
});

test("app-settings: getCloudflareAppSetting's guard actually short-circuits before D1, at both boundaries", async () => {
  // app_settings itself has a `length(key) BETWEEN 1 AND 120` CHECK
  // constraint, so an out-of-range key can never be seeded there to prove
  // the point the ordinary way. Instead, use a stub D1 that always answers
  // with a row, so "null" can only mean the guard short-circuited before
  // ever calling it.
  const sentinelRow = {
    key: "whatever", value_json: "{}", source_updated_at: OLD, updated_by: null, mirrored_at: OLD,
  };
  const sentinelBindings = {
    db: { prepare() { return { bind() { return { async first() { return sentinelRow; } }; } }; } },
  };

  assert.equal(await appSettings.getCloudflareAppSetting("", sentinelBindings), null);
  assert.equal(await appSettings.getCloudflareAppSetting("k".repeat(121), sentinelBindings), null);
  assert.notEqual(await appSettings.getCloudflareAppSetting("k", sentinelBindings), null);
  assert.notEqual(await appSettings.getCloudflareAppSetting("k".repeat(120), sentinelBindings), null);
});

test("app-settings: deleteCloudflareAppSettingReplica's guard rejects invalid keys and lets valid ones through", async () => {
  const context = fixture();
  assert.equal(await appSettings.deleteCloudflareAppSettingReplica("", context.bindings), false);
  assert.equal(await appSettings.deleteCloudflareAppSettingReplica("k".repeat(121), context.bindings), false);
  // A DELETE on a key that does not exist still "succeeds" — this is only
  // reachable, and only true, when the guard let it through.
  assert.equal(await appSettings.deleteCloudflareAppSettingReplica("k", context.bindings), true);
  assert.equal(await appSettings.deleteCloudflareAppSettingReplica("k".repeat(120), context.bindings), true);
});

test("app-settings: appSettingRecordsEqual — both-null, and each single-sided null", () => {
  assert.equal(appSettings.appSettingRecordsEqual(null, null), true);
  assert.equal(appSettings.appSettingRecordsEqual(null, { ...baseRecord(), mirroredAt: NEW }), false);
  assert.equal(appSettings.appSettingRecordsEqual(baseRecord(), null), false);
});

test("app-settings: appSettingRecordsEqual compares every field independently", () => {
  const common = { key: "k", updatedAt: OLD, updatedBy: ACTOR, value: { a: 1 } };
  const target = { ...common, mirroredAt: NEW };
  assert.equal(appSettings.appSettingRecordsEqual(common, target), true);
  assert.equal(appSettings.appSettingRecordsEqual({ ...common, key: "other" }, target), false);
  assert.equal(appSettings.appSettingRecordsEqual({ ...common, updatedAt: NEW }, target), false);
  assert.equal(appSettings.appSettingRecordsEqual({ ...common, updatedBy: "20000000-0000-4000-8000-000000000002" }, target), false);
  assert.equal(appSettings.appSettingRecordsEqual({ ...common, value: { a: 2 } }, target), false);
});

/* ------------------------------------------------------------------------ *
 * ai-cost-read-authority.ts
 * ------------------------------------------------------------------------ */

const AS_OF = new Date("2026-08-12T12:34:56.000Z");

function costRow(overrides = {}) {
  return {
    id: "1",
    source: "calculated_tokens",
    cost_usd: "1.00",
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    occurred_at: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

test("ai-cost-read: assertServerOnly is still called by both exported entry points", async () => {
  await withFakeWindow(() => {
    assert.throws(
      () => aiCostRead.summarizeCloudflareAiCostLedger([], null, 30, AS_OF),
      /lib\/cloudflare\/ai-cost-read-authority\.ts is server-only/,
    );
  });
  await withFakeWindow(async () => {
    await assert.rejects(
      () => aiCostRead.readCloudflareAdminAiCostSnapshot(30, { db: { prepare() { throw new Error("must not reach D1"); } } }),
      /lib\/cloudflare\/ai-cost-read-authority\.ts is server-only/,
    );
  });
});

test("ai-cost-read: a malformed occurred_at is rejected by validTimestamp with its own message", () => {
  assert.throws(
    () => aiCostRead.summarizeCloudflareAiCostLedger([costRow({ occurred_at: "not-a-timestamp" })], null, 30, AS_OF),
    /D1 AI-cost ledger returned an invalid occurrence timestamp/,
  );
});

test("ai-cost-read: a non-string cost value is rejected with the exact message", () => {
  assert.throws(
    () => aiCostRead.summarizeCloudflareAiCostLedger([costRow({ cost_usd: 5 })], null, 30, AS_OF),
    /D1 AI-cost ledger returned an invalid cost/,
  );
});

test("ai-cost-read: a negative cost is rejected — startsWith, not endsWith, and with its own message", () => {
  assert.throws(
    () => aiCostRead.summarizeCloudflareAiCostLedger([costRow({ cost_usd: "-5" })], null, 30, AS_OF),
    /D1 AI-cost ledger returned a negative cost/,
  );
});

test("ai-cost-read: token counters accept null (as zero) and reject negative, at the zero boundary", () => {
  // null must be treated as zero, not thrown on.
  const snapshot = aiCostRead.summarizeCloudflareAiCostLedger(
    [costRow({ input_tokens: null, output_tokens: 0 })],
    null,
    30,
    AS_OF,
  );
  assert.equal(snapshot.lifetime.inputTokens, "0");
  assert.equal(snapshot.lifetime.outputTokens, "0");

  for (const [field, name] of [
    ["input_tokens", "input tokens"],
    ["output_tokens", "output tokens"],
    ["cache_creation_input_tokens", "cache-creation tokens"],
    ["cache_read_input_tokens", "cache-read tokens"],
  ]) {
    assert.throws(
      () => aiCostRead.summarizeCloudflareAiCostLedger([costRow({ [field]: -1 })], null, 30, AS_OF),
      new RegExp(`D1 AI-cost ledger returned an invalid ${name}`),
      `negative ${field} must throw naming "${name}"`,
    );
  }
});

test("ai-cost-read: includesProviderBackfill reflects only provider_backfill rows, never a false positive", () => {
  const snapshot = aiCostRead.summarizeCloudflareAiCostLedger(
    [costRow({ id: "1" }), costRow({ id: "2" })],
    null,
    30,
    AS_OF,
  );
  assert.equal(snapshot.coverage.includesProviderBackfill, false);
});

test("ai-cost-read: the period window includes both its start and its end instant, and excludes past the end", () => {
  const periodStart = new Date(Date.UTC(2026, 7, 12, 0, 0, 0));
  const asOf = new Date(Date.UTC(2026, 7, 12, 12, 0, 0));
  const atStart = costRow({ id: "start", occurred_at: periodStart.toISOString() });
  const atEnd = costRow({ id: "end", occurred_at: asOf.toISOString() });
  const pastEnd = costRow({ id: "past", occurred_at: new Date(asOf.getTime() + 3_600_000).toISOString() });

  const snapshot = aiCostRead.summarizeCloudflareAiCostLedger([atStart, atEnd, pastEnd], null, 1, asOf);
  // Lifetime sees all three; the period (exactly today) must see only the
  // two within [periodStart, asOf].
  assert.equal(snapshot.lifetime.requestCount, "3");
  assert.equal(snapshot.period.requestCount, "2");
});

test("ai-cost-read: a malformed coverage.starts_at is rejected naming 'coverage start'", () => {
  assert.throws(
    () => aiCostRead.summarizeCloudflareAiCostLedger(
      [costRow()],
      { source: "provider_console", starts_at: "not-a-date", historical_complete: 1 },
      30,
      AS_OF,
    ),
    /D1 AI-cost ledger returned an invalid coverage start/,
  );
});

test("ai-cost-read: a null coverage never touches coverage.source (short-circuits, does not throw)", () => {
  const snapshot = aiCostRead.summarizeCloudflareAiCostLedger([costRow()], null, 30, AS_OF);
  assert.equal(snapshot.coverage.source, null);
  assert.equal(snapshot.coverage.startsAt, null);
  assert.equal(snapshot.coverage.historicalComplete, false);
});

test("ai-cost-read: coverage.source accepts both known values and rejects an unknown one", () => {
  const withSource = (source) => aiCostRead.summarizeCloudflareAiCostLedger(
    [costRow()],
    { source, starts_at: OLD, historical_complete: 1 },
    30,
    AS_OF,
  );
  assert.doesNotThrow(() => withSource("provider_console"));
  assert.doesNotThrow(() => withSource("local_tracking"));
  assert.throws(() => withSource("made_up_source"), /D1 AI-cost ledger returned invalid coverage/);
});

test("ai-cost-read: historical_complete accepts 0 and 1 and rejects anything else", () => {
  const withComplete = (historical_complete) => aiCostRead.summarizeCloudflareAiCostLedger(
    [costRow()],
    { source: "provider_console", starts_at: OLD, historical_complete },
    30,
    AS_OF,
  );
  assert.doesNotThrow(() => withComplete(0));
  assert.doesNotThrow(() => withComplete(1));
  assert.throws(() => withComplete(2), /D1 AI-cost ledger returned invalid coverage/);
});

test("ai-cost-read: historicalComplete on the result is exactly (historical_complete === 1)", () => {
  const withComplete = (historical_complete) => aiCostRead.summarizeCloudflareAiCostLedger(
    [costRow()],
    { source: "provider_console", starts_at: OLD, historical_complete },
    30,
    AS_OF,
  ).coverage.historicalComplete;
  assert.equal(withComplete(1), true);
  assert.equal(withComplete(0), false);
});

test("ai-cost-read: the period-days guard rejects one past each boundary and accepts each boundary", () => {
  assert.throws(
    () => aiCostRead.summarizeCloudflareAiCostLedger([], null, 0, AS_OF),
    /AI-cost ledger period must be between 1 and 366 days/,
  );
  assert.throws(
    () => aiCostRead.summarizeCloudflareAiCostLedger([], null, 367, AS_OF),
    /AI-cost ledger period must be between 1 and 366 days/,
  );
  assert.doesNotThrow(() => aiCostRead.summarizeCloudflareAiCostLedger([], null, 1, AS_OF));
  assert.doesNotThrow(() => aiCostRead.summarizeCloudflareAiCostLedger([], null, 366, AS_OF));
});

/** A synthetic D1 for allCostRows/readCloudflareAdminAiCostSnapshot: rows are
 *  generated on demand rather than actually stored, so a page-boundary or a
 *  50,000-row test costs nothing to run. */
function fakeCostLedgerBindings(totalRows, coverageRow = null) {
  return {
    db: {
      prepare(sql) {
        const bound = (args) => ({
          async all() {
            if (!sql.includes("FROM ai_cost_events")) throw new Error(`unexpected query: ${sql}`);
            const [limit, offset] = args;
            const rows = [];
            for (let i = offset; i < Math.min(offset + limit, totalRows); i += 1) {
              rows.push(costRow({
                id: String(i + 1),
                occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
              }));
            }
            return { results: rows };
          },
          async first() {
            if (!sql.includes("FROM ai_cost_coverage")) throw new Error(`unexpected query: ${sql}`);
            return coverageRow;
          },
        });
        return { bind: (...args) => bound(args), ...bound([]) };
      },
    },
  };
}

test("ai-cost-read: allCostRows crosses a page boundary — one page is not the whole story", async () => {
  const bindings = fakeCostLedgerBindings(700);
  const snapshot = await aiCostRead.readCloudflareAdminAiCostSnapshot(30, bindings);
  assert.equal(snapshot.lifetime.requestCount, "700");
});

test("ai-cost-read: exactly MAX_D1_COST_EVENTS rows is accepted; one more is refused", async () => {
  const ok = await aiCostRead.readCloudflareAdminAiCostSnapshot(30, fakeCostLedgerBindings(50_000));
  assert.equal(ok.lifetime.requestCount, "50000");

  await assert.rejects(
    () => aiCostRead.readCloudflareAdminAiCostSnapshot(30, fakeCostLedgerBindings(50_001)),
    /D1 AI-cost ledger is too large for an exact owner snapshot/,
  );
});

test("ai-cost-read: readCloudflareAdminAiCostSnapshot clamps days at both ends rather than passing them through", async () => {
  const tooMany = await aiCostRead.readCloudflareAdminAiCostSnapshot(500, fakeCostLedgerBindings(0));
  assert.equal(tooMany.periodDays, 366);
  const tooFew = await aiCostRead.readCloudflareAdminAiCostSnapshot(-5, fakeCostLedgerBindings(0));
  assert.equal(tooFew.periodDays, 1);
});

/* ------------------------------------------------------------------------ *
 * ai-cost-write-authority.ts
 * ------------------------------------------------------------------------ */

function writeRuntimeD1(database) {
  const execute = (sql, values) => {
    const result = database.prepare(sql).run(...values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    async run() { return execute(sql, values); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
  });
  return { prepare(sql) { return { bind: (...values) => bound(sql, values), ...bound(sql, []) }; } };
}

function writeFixture({ seedSequence = true } = {}) {
  const database = migratedDatabase();
  database.exec(`
    CREATE TABLE IF NOT EXISTS cloudflare_id_sequences (
      sequence_name TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL
    ) STRICT;
  `);
  if (seedSequence) {
    database.prepare(
      "INSERT INTO cloudflare_id_sequences (sequence_name, next_value) VALUES ('ai_cost_events', 500)",
    ).run();
  }
  return { database, bindings: { db: writeRuntimeD1(database), files: {} } };
}

function writeInput(overrides = {}) {
  return {
    providerRequestId: "msg_1",
    route: "chat",
    model: "claude-haiku-4-5",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: "0.001",
    occurredAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

test("ai-cost-write: the id-sequence-not-seeded error names its class and quotes every part of its message", async () => {
  const context = writeFixture({ seedSequence: false });
  await assert.rejects(
    () => aiCostWrite.recordAiCostEventOnCloudflare(writeInput(), context.bindings),
    (error) => {
      assert.equal(error.name, "CloudflareAiCostIdSequenceNotSeededError");
      assert.match(error.message, /is not seeded\. This is an operator step, not/);
      assert.match(error.message, /a bug: see the pull request that added lib\/cloudflare\/ai-cost-write-authority\.ts for/);
      assert.match(error.message, /the exact wrangler d1 execute commands, and run them before setting this domain's/);
      assert.match(error.message, /mode to 'cloudflare'\./);
      return true;
    },
  );
});

test("ai-cost-write: assertServerOnly is still called (module path shows up when window is defined)", async () => {
  await withFakeWindow(async () => {
    await assert.rejects(
      () => aiCostWrite.recordAiCostEventOnCloudflare(writeInput(), { db: { prepare() { throw new Error("must not reach D1"); } } }),
      /lib\/cloudflare\/ai-cost-write-authority\.ts is server-only/,
    );
  });
});

test("ai-cost-write: providerRequestId is trimmed before it is stored or checked", async () => {
  const context = writeFixture();
  const result = await aiCostWrite.recordAiCostEventOnCloudflare(
    writeInput({ providerRequestId: "  msg_padded  " }),
    context.bindings,
  );
  assert.equal(result.event.providerRequestId, "msg_padded");
  assert.equal(
    context.database.prepare("SELECT provider_request_id FROM ai_cost_events WHERE id = ?").get(result.event.id)
      .provider_request_id,
    "msg_padded",
  );
});

test("ai-cost-write: an all-whitespace providerRequestId is rejected as absent", async () => {
  const context = writeFixture();
  await assert.rejects(
    () => aiCostWrite.recordAiCostEventOnCloudflare(writeInput({ providerRequestId: "   " }), context.bindings),
    /Cloudflare AI cost write has no provider request id/,
  );
});

test("ai-cost-write: an invalid occurredAt is rejected before any D1 write", async () => {
  const context = writeFixture();
  await assert.rejects(
    () => aiCostWrite.recordAiCostEventOnCloudflare(writeInput({ occurredAt: "not-a-date" }), context.bindings),
    /Invalid Cloudflare AI cost occurrence timestamp/,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM ai_cost_events").get().n, 0);
});

test("ai-cost-write: an unavailable insert (success: false) throws its own message, never inventing a row", async () => {
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("cloudflare_id_sequences")) return { id: "1" };
                return null;
              },
              async run() {
                return { success: false, meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };
  await assert.rejects(
    () => aiCostWrite.recordAiCostEventOnCloudflare(writeInput(), bindings),
    /Cloudflare AI cost write is unavailable/,
  );
});

test("ai-cost-write: an insert that reports success but leaves no readable row still throws", async () => {
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("cloudflare_id_sequences")) return { id: "1" };
                return null; // the post-insert SELECT finds nothing
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
  await assert.rejects(
    () => aiCostWrite.recordAiCostEventOnCloudflare(writeInput(), bindings),
    /Cloudflare AI cost write committed no row/,
  );
});

test("ai-cost-write: toReplica's model fallback is the empty string, not a placeholder", async () => {
  const context = writeFixture();
  context.database.prepare(`
    INSERT INTO ai_cost_events (
      id, source, provider_request_id, route, model, input_tokens, output_tokens,
      cache_creation_input_tokens, cache_creation_5m_input_tokens,
      cache_creation_1h_input_tokens, cache_read_input_tokens, cost_usd,
      occurred_at, recorded_at
    ) VALUES ('9', 'calculated_tokens', 'msg_null_model', 'chat', NULL, 1, 1, 0, 0, 0, 0, '0.01',
      '2026-08-17T00:00:00.000000000Z', '2026-08-17T00:00:00.000000000Z')
  `).run();
  const result = await aiCostWrite.recordAiCostEventOnCloudflare(
    writeInput({ providerRequestId: "msg_null_model" }),
    context.bindings,
  );
  assert.equal(result.inserted, false, "the pre-seeded row must win via ON CONFLICT DO NOTHING");
  assert.equal(result.event.model, "");
});

/* ------------------------------------------------------------------------ *
 * account-status.ts
 * ------------------------------------------------------------------------ */

function statusBindings({ oldest = null, grouped = [], grants = [], poison = false } = {}) {
  const queries = [];
  if (poison) {
    return {
      db: {
        prepare() { throw new Error("must not query D1 for an invalid userId"); },
        async batch() { throw new Error("must not batch D1 for an invalid userId"); },
      },
      queries,
    };
  }
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              queries.push({ sql, values });
              if (sql.includes("MIN(created_at)")) {
                if (oldest === "MISSING") return undefined;
                return { success: true, results: [oldest ?? { oldest_at: null }], meta: {} };
              }
              if (sql.includes("GROUP BY route")) {
                if (grouped === "MISSING") return undefined;
                return { success: true, results: grouped, meta: {} };
              }
              if (sql.includes("FROM subscriptions")) {
                return { success: true, results: grants, meta: {} };
              }
              throw new Error(`unexpected query: ${sql}`);
            },
          };
        },
      };
    },
    async batch(statements) {
      if (oldest === "FAIL_ONE") {
        const results = await Promise.all(statements.map((s) => s.all()));
        results[0] = { success: false, results: [], meta: {} };
        return results;
      }
      return Promise.all(statements.map((s) => s.all()));
    },
  };
  return { db, queries };
}

test("account-status: assertServerOnly still guards both entry points", async () => {
  await withFakeWindow(async () => {
    await assert.rejects(
      () => accountStatus.cloudflareUsageDetail("u1", 3600, { db: { prepare() { throw new Error("no"); }, batch() { throw new Error("no"); } } }),
      /lib\/cloudflare\/account-status\.ts is server-only/,
    );
  });
  await withFakeWindow(async () => {
    await assert.rejects(
      () => accountStatus.currentCloudflareAccessGrants("u1", { db: { prepare() { throw new Error("no"); } } }),
      /lib\/cloudflare\/account-status\.ts is server-only/,
    );
  });
});

test("account-status: an invalid userId short-circuits to the safe default without touching D1, at both ends", async () => {
  const empty = statusBindings({ poison: true });
  assert.deepEqual(
    await accountStatus.cloudflareUsageDetail("", 3600, empty),
    { oldestAt: null, byRoute: {} },
  );
  assert.deepEqual(
    await accountStatus.cloudflareUsageDetail("u".repeat(81), 3600, empty),
    { oldestAt: null, byRoute: {} },
  );
  assert.deepEqual(await accountStatus.currentCloudflareAccessGrants("", empty), []);
  assert.deepEqual(await accountStatus.currentCloudflareAccessGrants("u".repeat(81), empty), []);
});

test("account-status: a userId of exactly 80 characters is valid, on both entry points", async () => {
  // The stub answers with a recognisable non-default value, so the
  // assertion can tell "the guard let this through and D1 was actually
  // queried" apart from "the guard's default happens to look the same".
  const userId = "u".repeat(80);
  const working = statusBindings({ oldest: { oldest_at: "2026-01-01T00:00:00.000Z" }, grouped: [], grants: [] });
  assert.equal((await accountStatus.cloudflareUsageDetail(userId, 3600, working)).oldestAt, "2026-01-01T00:00:00.000Z");

  const grantsWorking = statusBindings({
    grants: [{ provider: "stripe", tier: "ai", external_price_id: null, current_period_end: null, cancel_at_period_end: 0 }],
  });
  assert.equal((await accountStatus.currentCloudflareAccessGrants(userId, grantsWorking)).length, 1);
});

test("account-status: windowFloor rejects a non-positive window with its own message, and the boundary of 1 is valid", async () => {
  const working = statusBindings({ oldest: { oldest_at: null }, grouped: [] });
  await assert.rejects(
    () => accountStatus.cloudflareUsageDetail("u1", 0, working),
    /usage window must be a positive integer/,
  );
  await assert.doesNotReject(() => accountStatus.cloudflareUsageDetail("u1", 1, working));
});

test("account-status: windowFloor subtracts, in milliseconds, not adds or divides", async () => {
  const bindings = statusBindings({ oldest: { oldest_at: null }, grouped: [] });
  const now = Date.UTC(2026, 7, 28, 1, 0, 0);
  await accountStatus.cloudflareUsageDetail("u1", 10, bindings, now);
  const floorUsed = bindings.queries[0].values[1];
  assert.equal(floorUsed, new Date(now - 10_000).toISOString());
});

test("account-status: a batch failure on either query is reported, distinctly from a merely-empty result", async () => {
  await assert.rejects(
    () => accountStatus.cloudflareUsageDetail("u1", 3600, statusBindings({ oldest: "MISSING", grouped: [] })),
    /Cloudflare usage detail is unavailable/,
  );
  await assert.rejects(
    () => accountStatus.cloudflareUsageDetail("u1", 3600, statusBindings({ oldest: { oldest_at: null }, grouped: "MISSING" })),
    /Cloudflare usage detail is unavailable/,
  );
  await assert.rejects(
    () => accountStatus.cloudflareUsageDetail("u1", 3600, statusBindings({ oldest: "FAIL_ONE", grouped: [] })),
    /Cloudflare usage detail is unavailable/,
  );
});

test("account-status: byRoute keeps only rows with a string route and a non-negative safe-integer count", async () => {
  const bindings = statusBindings({
    oldest: { oldest_at: null },
    grouped: [
      { route: "kept-zero", used: 0 },
      { route: "dropped-negative", used: -1 },
      { route: 42, used: 5 },
      { route: "kept-normal", used: 3 },
    ],
  });
  const result = await accountStatus.cloudflareUsageDetail("u1", 3600, bindings);
  assert.deepEqual(result.byRoute, { "kept-zero": 0, "kept-normal": 3 });
});

test("account-status: cancelAtPeriodEnd is exactly (cancel_at_period_end === 1)", async () => {
  const bindings = statusBindings({
    grants: [
      {
        provider: "stripe", tier: "ai", external_price_id: null,
        current_period_end: null, cancel_at_period_end: 1,
      },
      {
        provider: "stripe", tier: "tracking", external_price_id: null,
        current_period_end: null, cancel_at_period_end: 0,
      },
    ],
  });
  const grants = await accountStatus.currentCloudflareAccessGrants("u1", bindings);
  assert.equal(grants[0].cancelAtPeriodEnd, true);
  assert.equal(grants[1].cancelAtPeriodEnd, false);
});

/* ------------------------------------------------------------------------ *
 * avatar-delivery.ts
 * ------------------------------------------------------------------------ */

const AVATAR_SECRET = "avatar-storage-mutation-signing-key-32-bytes-plus";
const AVATAR_USER = "499f408e-a012-48a0-ab0d-7aa1f7ca103b";
const AVATAR_KEY = `private/avatars/${AVATAR_USER}/${"a".repeat(64)}.webp`;
const AVATAR_NOW = 1_800_000_000;

test("avatar-delivery: assertServerOnly still guards the env-var signing path", async () => {
  await withFakeWindow(() => {
    assert.throws(
      () => avatarDelivery.cloudflareAvatarDeliveryConfigured(),
      /lib\/cloudflare\/avatar-delivery\.ts is server-only/,
    );
  });
});

test("avatar-delivery: AVATAR_URL_TTL_SECONDS is exactly one hour", () => {
  assert.equal(avatarDelivery.AVATAR_URL_TTL_SECONDS, 3600);
});

test("avatar-delivery: an explicit secret under 32 characters is rejected, at the boundary", async () => {
  assert.equal(
    await avatarDelivery.cloudflareAvatarUrl("https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY, {
      nowSeconds: AVATAR_NOW, secret: "x".repeat(31),
    }),
    null,
  );
  assert.notEqual(
    await avatarDelivery.cloudflareAvatarUrl("https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY, {
      nowSeconds: AVATAR_NOW, secret: "x".repeat(32),
    }),
    null,
  );
});

test("avatar-delivery: signingSecret's length gate is >= 32, at both an explicit secret and the env var", () => {
  const previous = process.env.AVATAR_URL_SIGNING_KEY;
  try {
    process.env.AVATAR_URL_SIGNING_KEY = "x".repeat(32);
    assert.equal(avatarDelivery.cloudflareAvatarDeliveryConfigured(), true);
    process.env.AVATAR_URL_SIGNING_KEY = "x".repeat(31);
    assert.equal(avatarDelivery.cloudflareAvatarDeliveryConfigured(), false);
  } finally {
    if (previous === undefined) delete process.env.AVATAR_URL_SIGNING_KEY;
    else process.env.AVATAR_URL_SIGNING_KEY = previous;
  }
});

test("avatar-delivery: a grant round-trips at several payload lengths (exercises every base64 padding case)", async () => {
  for (let length = 1; length <= 6; length += 1) {
    const userId = "u".repeat(length);
    const objectKey = `private/avatars/${userId}/${"k".repeat(length)}.webp`;
    const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
      "https://api.bandup.test/account",
      userId,
      objectKey,
      { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
    ));
    const grant = await avatarDelivery.verifyCloudflareAvatarGrant(url.searchParams.get("grant"), {
      nowSeconds: AVATAR_NOW,
      secret: AVATAR_SECRET,
    });
    assert.deepEqual(grant, { userId, objectKey, expiresAt: AVATAR_NOW + avatarDelivery.AVATAR_URL_TTL_SECONDS }, `length ${length}`);
  }
});

test("avatar-delivery: a grant generated with the real clock still verifies against a pinned, current nowSeconds", async () => {
  const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account",
    AVATAR_USER,
    AVATAR_KEY,
    { secret: AVATAR_SECRET },
  ));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const grant = await avatarDelivery.verifyCloudflareAvatarGrant(url.searchParams.get("grant"), {
    nowSeconds,
    secret: AVATAR_SECRET,
  });
  assert.notEqual(grant, null);
  assert.equal(grant.userId, AVATAR_USER);
});

test("avatar-delivery: a grant verified with the real clock (no pinned nowSeconds) still succeeds", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY,
    { nowSeconds, secret: AVATAR_SECRET },
  ));
  const grant = await avatarDelivery.verifyCloudflareAvatarGrant(url.searchParams.get("grant"), {
    secret: AVATAR_SECRET,
  });
  assert.notEqual(grant, null);
});

test("avatar-delivery: a grant is rejected the instant it expires, and accepted the instant before", async () => {
  const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY,
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  ));
  const grant = url.searchParams.get("grant");
  const expiresAt = AVATAR_NOW + avatarDelivery.AVATAR_URL_TTL_SECONDS;
  assert.notEqual(
    await avatarDelivery.verifyCloudflareAvatarGrant(grant, { nowSeconds: expiresAt - 1, secret: AVATAR_SECRET }),
    null,
  );
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(grant, { nowSeconds: expiresAt, secret: AVATAR_SECRET }),
    null,
  );
});

test("avatar-delivery: null, tampered, and cross-owner grants are all rejected", async () => {
  const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY,
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  ));
  const signed = url.searchParams.get("grant");
  assert.equal(await avatarDelivery.verifyCloudflareAvatarGrant(null, { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }), null);

  const [token, signature] = signed.split(".");
  const tampered = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(`${token}.${tampered}`, { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
  );

  const otherUser = "0cebdcfd-ecd6-4242-9361-25f8c0f7cb7c";
  const mismatchedOwner = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY.replace(AVATAR_USER, otherUser),
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  ));
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(mismatchedOwner.searchParams.get("grant"), { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
  );
});

/** Signs an arbitrary raw token with the same HMAC scheme cloudflareAvatarUrl uses, so a test can forge a validly-signed grant whose payload is not JSON at all. */
async function signRawToken(token, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(token)));
  let binary = "";
  for (const byte of signatureBytes) binary += String.fromCharCode(byte);
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${token}.${signature}`;
}

function base64UrlEncode(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signPayload(payloadObject, secret) {
  return signRawToken(base64UrlEncode(JSON.stringify(payloadObject)), secret);
}

function validPayload(overrides = {}) {
  return { v: 1, u: AVATAR_USER, k: AVATAR_KEY, e: AVATAR_NOW + 100, ...overrides };
}

test("avatar-delivery: grant.v must be exactly 1", async () => {
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(await signPayload(validPayload({ v: 2 }), AVATAR_SECRET), { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
  );
  assert.notEqual(
    await avatarDelivery.verifyCloudflareAvatarGrant(await signPayload(validPayload({ v: 1 }), AVATAR_SECRET), { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
  );
});

test("avatar-delivery: grant.u length is validated at both boundaries", async () => {
  const at = async (length) => avatarDelivery.verifyCloudflareAvatarGrant(
    await signPayload(validPayload({ u: "u".repeat(length), k: `private/avatars/${"u".repeat(length)}/x` }), AVATAR_SECRET),
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  );
  assert.equal(await at(0), null, "empty u must be rejected");
  assert.equal(await at(129), null, "u over 128 must be rejected");
  assert.notEqual(await at(1), null, "u of length 1 must be accepted");
  assert.notEqual(await at(128), null, "u of length 128 must be accepted");
});

test("avatar-delivery: grant.k length is validated at both boundaries", async () => {
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(
      await signPayload(validPayload({ k: "" }), AVATAR_SECRET),
      { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
    ),
    null,
    "empty k must be rejected",
  );
  // Isolate the upper-length gate with k values that keep the required
  // object-key prefix, so a too-long k is not instead caught by the prefix
  // check further down.
  const prefix = `private/avatars/${AVATAR_USER}/`;
  const atLen = async (total) => avatarDelivery.verifyCloudflareAvatarGrant(
    await signPayload(validPayload({ k: `${prefix}${"k".repeat(Math.max(0, total - prefix.length))}` }), AVATAR_SECRET),
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  );
  assert.equal(await atLen(513), null, "k over 512 must be rejected");
  assert.notEqual(await atLen(512), null, "k of length 512 must be accepted");
  assert.notEqual(await atLen(prefix.length), null, "k at the prefix's own length must be accepted");
});

test("avatar-delivery: grant.e is rejected past now + MAX_GRANT_SECONDS, and accepted exactly at that boundary", async () => {
  const maxGrantSeconds = avatarDelivery.AVATAR_URL_TTL_SECONDS + 60;
  const at = async (e) => avatarDelivery.verifyCloudflareAvatarGrant(
    await signPayload(validPayload({ e }), AVATAR_SECRET),
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  );
  assert.equal(await at(AVATAR_NOW + maxGrantSeconds + 1), null, "one second past the cap must be rejected");
  assert.notEqual(await at(AVATAR_NOW + maxGrantSeconds), null, "exactly at the cap must be accepted");
});

test("avatar-delivery: a validly-signed grant whose payload is not JSON at all is rejected, not thrown", async () => {
  const forged = await signRawToken(base64UrlEncode("not json at all {{{"), AVATAR_SECRET);
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(forged, { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
  );
});

test("avatar-delivery: a grant value with no separator, or more than one, is rejected as malformed", async () => {
  const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account", AVATAR_USER, AVATAR_KEY,
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  ));
  const signed = url.searchParams.get("grant");
  const [token, signature] = signed.split(".");
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(`${token}${signature}`, { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
    "no separator at all",
  );
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(`${token}.${signature}.${signature}`, { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
    "more than one separator",
  );
  assert.equal(
    await avatarDelivery.verifyCloudflareAvatarGrant(`.${token}${signature}`, { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET }),
    null,
    "separator as the very first character",
  );
});

test("avatar-delivery: the owner segment used to check the object-key prefix is sanitised and length-capped", async () => {
  // grant.u itself is capped at 128 by the field check; this exercises the
  // *separate* replace+slice(0,180) used only to build the expected prefix.
  const weirdUser = "weird/user name";
  const objectKey = `private/avatars/weird_user_name/${"a".repeat(64)}.webp`;
  const url = new URL(await avatarDelivery.cloudflareAvatarUrl(
    "https://api.bandup.test/account", weirdUser, objectKey,
    { nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET },
  ));
  const grant = await avatarDelivery.verifyCloudflareAvatarGrant(url.searchParams.get("grant"), {
    nowSeconds: AVATAR_NOW, secret: AVATAR_SECRET,
  });
  assert.notEqual(grant, null);
  assert.equal(grant.objectKey, objectKey);
});

/* ------------------------------------------------------------------------ *
 * avatar-storage.ts — pure callback orchestration, no bindings needed.
 * ------------------------------------------------------------------------ */

test("avatar-storage: replaceAvatarObject — same-key retry never deletes the still-live object", async () => {
  const events = [];
  const result = await avatarStorage.replaceAvatarObject({
    previousKey: "same",
    nextKey: "same",
    storeNext: async () => { events.push("store"); },
    setPointer: async () => false,
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.equal(result, false);
  assert.deepEqual(events, ["store"]);
});

test("avatar-storage: replaceAvatarObject — a failed pointer update deletes only the new orphan", async () => {
  const events = [];
  const result = await avatarStorage.replaceAvatarObject({
    previousKey: "old",
    nextKey: "next",
    storeNext: async () => { events.push("store"); },
    setPointer: async () => false,
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.equal(result, false);
  assert.deepEqual(events, ["store", "delete:next"]);
});

test("avatar-storage: replaceAvatarObject — success stores, points, then deletes the old object", async () => {
  const events = [];
  const result = await avatarStorage.replaceAvatarObject({
    previousKey: "old",
    nextKey: "next",
    storeNext: async () => { events.push("store"); },
    setPointer: async (key) => { events.push(`pointer:${key}`); return true; },
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.equal(result, true);
  assert.deepEqual(events, ["store", "pointer:next", "delete:old"]);
});

test("avatar-storage: replaceAvatarObject — no previousKey means nothing is deleted after success", async () => {
  const events = [];
  await avatarStorage.replaceAvatarObject({
    previousKey: null,
    nextKey: "next",
    storeNext: async () => {},
    setPointer: async () => true,
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.deepEqual(events, []);
});

test("avatar-storage: replaceAvatarObject — setPointer throwing is treated as a failed pointer update", async () => {
  const events = [];
  const result = await avatarStorage.replaceAvatarObject({
    previousKey: "old",
    nextKey: "next",
    storeNext: async () => {},
    setPointer: async () => { throw new Error("d1 unavailable"); },
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.equal(result, false);
  assert.deepEqual(events, ["delete:next"]);
});

test("avatar-storage: replaceAvatarObject — a failing deleteObject on the old key calls onDeleteFailure with that exact key", async () => {
  const failures = [];
  const result = await avatarStorage.replaceAvatarObject({
    previousKey: "old",
    nextKey: "next",
    storeNext: async () => {},
    setPointer: async () => true,
    deleteObject: async () => { throw new Error("r2 unavailable"); },
    onDeleteFailure: async (key) => { failures.push(key); },
  });
  assert.equal(result, true);
  assert.deepEqual(failures, ["old"]);
});

test("avatar-storage: clearAvatarObject — a failed clearPointer never deletes the object", async () => {
  const events = [];
  const result = await avatarStorage.clearAvatarObject({
    previousKey: "old",
    clearPointer: async () => false,
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.equal(result, false);
  assert.deepEqual(events, []);
});

test("avatar-storage: clearAvatarObject — a throwing clearPointer is treated as failure, not propagated", async () => {
  const result = await avatarStorage.clearAvatarObject({
    previousKey: "old",
    clearPointer: async () => { throw new Error("d1 unavailable"); },
    deleteObject: async () => {},
  });
  assert.equal(result, false);
});

test("avatar-storage: clearAvatarObject — success with no previousKey deletes nothing", async () => {
  const events = [];
  const result = await avatarStorage.clearAvatarObject({
    previousKey: null,
    clearPointer: async () => true,
    deleteObject: async (key) => { events.push(`delete:${key}`); },
  });
  assert.equal(result, true);
  assert.deepEqual(events, []);
});

test("avatar-storage: clearAvatarObject — a failing deleteObject calls onDeleteFailure with the exact key, and still reports success", async () => {
  const failures = [];
  const result = await avatarStorage.clearAvatarObject({
    previousKey: "old",
    clearPointer: async () => true,
    deleteObject: async () => { throw new Error("r2 unavailable"); },
    onDeleteFailure: async (key) => { failures.push(key); },
  });
  assert.equal(result, true);
  assert.deepEqual(failures, ["old"]);
});

/* ------------------------------------------------------------------------ *
 * avatar-parity.ts
 * ------------------------------------------------------------------------ */

function parityFixture(files = {}) {
  const database = migratedDatabase();
  return { database, bindings: { db: runtimeD1(database), files: filesStub2(files) } };
}

function filesStub2(entries) {
  const store = new Map(Object.entries(entries));
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (value === "CORRUPT") return { async arrayBuffer() { throw new Error("unreadable"); } };
      return { async arrayBuffer() { return value.buffer; } };
    },
  };
}

const PARITY_USERS = [
  "50000000-0000-4000-8000-000000000011",
  "50000000-0000-4000-8000-000000000012",
];

function seedParityTarget(database, users, withAvatar = []) {
  for (const user of users) {
    database.prepare(`
      INSERT INTO app_users (id,email,role,created_at,updated_at)
      VALUES (?, ?, 'user', ?, ?)
    `).run(user, `${user}@example.test`, OLD, NEW);
    const objectKey = withAvatar.includes(user) ? `private/avatars/${user}/${user}.jpg` : null;
    database.prepare(`
      INSERT INTO learner_profiles (user_id,display_name,avatar_object_key,source_updated_at,avatar_source_updated_at,updated_at)
      VALUES (?, 'Learner', ?, ?, ?, ?)
    `).run(user, objectKey, NEW, objectKey ? NEW : null, NEW);
  }
}

function sourcePageFrom(rows) {
  return async (after, limit) => rows
    .filter((row) => row.userId > after)
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .slice(0, limit);
}

test("avatar-parity: rowLimit, sampleLimit and byteCheckLimit are each clamped at both ends", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([]),
    rowLimit: -5,
    sampleLimit: 0,
    byteCheckLimit: -1,
  });
  assert.equal(report.rowLimit, 1);
  assert.equal(report.sampleLimit, 1);
  assert.equal(report.byteCheckLimit, 0);

  const capped = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([]),
    rowLimit: 10 ** 9,
    sampleLimit: 10 ** 9,
    byteCheckLimit: 10 ** 9,
  });
  assert.equal(capped.rowLimit, avatarParity.MAX_AVATAR_PARITY_ROW_LIMIT);
  assert.equal(capped.sampleLimit, avatarParity.MAX_AVATAR_PARITY_SAMPLE_LIMIT);
  assert.equal(capped.byteCheckLimit, avatarParity.MAX_AVATAR_PARITY_BYTE_LIMIT);
});

test("avatar-parity: the presence stream reports exhaustion exactly at (not before or after) a short final page", async () => {
  const context = parityFixture({ [`private/avatars/${PARITY_USERS[0]}/${PARITY_USERS[0]}.jpg`]: new Uint8Array([1]) });
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[0]]);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([{ userId: PARITY_USERS[0], avatarPath: "p" }]),
    readSourceBytes: async () => new Uint8Array([1]),
  });
  // A single short page must mark the stream exhausted (presenceComplete),
  // not merely "no more buffered rows".
  assert.equal(report.presenceComplete, true);
  assert.equal(report.complete, true);
});

test("avatar-parity: an exhausted stream never re-reads its source once the last short page is seen", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS, PARITY_USERS);
  let sourceReads = 0;
  const rows = [{ userId: PARITY_USERS[0], avatarPath: "p0" }];
  const countedSource = async (after, limit) => {
    sourceReads += 1;
    return sourcePageFrom(rows)(after, limit);
  };
  await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: countedSource,
    readSourceBytes: async () => null,
  });
  // The source stream sees one row (short of PAGE_SIZE, so it is marked
  // exhausted on that same read) while the target stream still has one more
  // row to walk through; each further loop iteration must not re-read an
  // already-exhausted source.
  assert.equal(sourceReads, 1);
});

test("avatar-parity: a source with no rows at all is marked exhausted on its first (empty) read, and never read again", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS, PARITY_USERS);
  let sourceReads = 0;
  const emptySource = async (after, limit) => {
    sourceReads += 1;
    return sourcePageFrom([])(after, limit);
  };
  await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: emptySource,
    readSourceBytes: async () => null,
  });
  assert.equal(sourceReads, 1);
});

test("avatar-parity: a source larger than one internal page is read to the end, not stopped after the first full page", async () => {
  const context = parityFixture();
  // Target is left empty: every source row becomes a disappearing face, so
  // the total is a direct, exact count of how many source rows were walked.
  const total = 600;
  const rows = Array.from({ length: total }, (_, index) => ({
    userId: `60${String(index).padStart(38, "0")}`,
    avatarPath: `${index}/original.jpg`,
  }));
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom(rows),
  });
  assert.equal(report.disappearingFaces.total, total);
  assert.equal(report.comparedSourceRows, total);
  assert.equal(report.presenceComplete, true);
});

test("avatar-parity: byte comparison uses length first — a length mismatch is 'different' without hashing", async () => {
  const context = parityFixture({
    [`private/avatars/${PARITY_USERS[0]}/${PARITY_USERS[0]}.jpg`]: new Uint8Array([1, 2, 3]),
  });
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[0]]);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([{ userId: PARITY_USERS[0], avatarPath: "p" }]),
    readSourceBytes: async () => new Uint8Array([1, 2]),
  });
  assert.equal(report.bytes.different.total, 1);
  assert.equal(report.bytes.equal.total, 0);
});

test("avatar-parity: the presence-scan bound stops after exactly one matched pair, never reaching the row beyond it", async () => {
  const context = parityFixture({ [`private/avatars/${PARITY_USERS[0]}/${PARITY_USERS[0]}.jpg`]: new Uint8Array([1]) });
  // PARITY_USERS[0] matches on both sides (one full comparison, both
  // streams advance); PARITY_USERS[1] would be a disappearing face, but
  // rowLimit must stop the scan before either stream ever reaches it.
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[0]]);
  const rows = [
    { userId: PARITY_USERS[0], avatarPath: "p0" },
    { userId: PARITY_USERS[1], avatarPath: "p1" },
  ];
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom(rows),
    readSourceBytes: async () => new Uint8Array([1]),
    rowLimit: 1,
  });
  assert.equal(report.presenceComplete, false);
  assert.equal(report.comparedSourceRows, 1);
  assert.equal(report.disappearingFaces.total, 0, "the row beyond the bound must not be reached at all");
});

test("avatar-parity: the presence-scan bound is the larger of the two streams' progress, not the smaller", async () => {
  const context = parityFixture();
  // Target is left empty, so every source row only ever advances the
  // source side. If the bound used the smaller of the two counters, an
  // empty target (stuck at 0) would let the whole source through
  // regardless of rowLimit.
  const rows = Array.from({ length: 5 }, (_, index) => ({ userId: `${index}`, avatarPath: "p" }));
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom(rows),
    rowLimit: 2,
  });
  assert.equal(report.presenceComplete, false);
  assert.equal(report.disappearingFaces.total, 2);
});

test("avatar-parity: ordering compares keys both ways — a source-only key is not mistaken for a target-only one", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[1]]);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    // Source names a key strictly before the one D1 has.
    readSourcePage: sourcePageFrom([{ userId: "10000000-0000-4000-8000-000000000000", avatarPath: "p" }]),
    readSourceBytes: async () => null,
  });
  assert.equal(report.disappearingFaces.total, 1);
  assert.deepEqual(report.disappearingFaces.sample, ["10000000-0000-4000-8000-000000000000"]);
  assert.equal(report.targetOnly.total, 1);
  assert.deepEqual(report.targetOnly.sample, [PARITY_USERS[1]]);
});

test("avatar-parity: a target-only key strictly before a still-pending source key is named while the source stream is not yet exhausted", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[0]]);
  // The one source row sorts after PARITY_USERS[0], so when the merge
  // compares them both are non-null and the target key is the lesser one —
  // this is the "left.key > right.key" branch, not the "left === null" one.
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([{ userId: "90000000-0000-4000-8000-000000000000", avatarPath: "p" }]),
    readSourceBytes: async () => null,
  });
  assert.equal(report.targetOnly.total, 1);
  assert.deepEqual(report.targetOnly.sample, [PARITY_USERS[0]]);
});

test("avatar-parity: drifted totals sum all six buckets, not a subset of them", async () => {
  const context = parityFixture({
    [`private/avatars/${PARITY_USERS[1]}/${PARITY_USERS[1]}.jpg`]: "CORRUPT",
  });
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[1]]);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    // PARITY_USERS[0]: disappearing face (source only).
    // PARITY_USERS[1]: target-unreadable (recorded on both, R2 corrupt).
    readSourcePage: sourcePageFrom([
      { userId: PARITY_USERS[0], avatarPath: "p0" },
      { userId: PARITY_USERS[1], avatarPath: "p1" },
    ]),
    readSourceBytes: async () => new Uint8Array([1]),
  });
  assert.equal(report.status, "drifted");
  assert.equal(report.disappearingFaces.total, 1);
  assert.equal(report.bytes.targetUnreadable.total, 1);
});

test("avatar-parity: a source-unreadable pair alone is enough to drift the status, not to cancel it out", async () => {
  const context = parityFixture({ [`private/avatars/${PARITY_USERS[0]}/${PARITY_USERS[0]}.jpg`]: new Uint8Array([1]) });
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[0]]);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([{ userId: PARITY_USERS[0], avatarPath: "p" }]),
    readSourceBytes: async () => null,
  });
  assert.equal(report.bytes.sourceUnreadable.total, 1);
  assert.equal(report.bytes.bothUnreadable.total, 0);
  assert.equal(report.status, "drifted");
});

test("avatar-parity: a both-unreadable pair alone is enough to drift the status, not to cancel it out", async () => {
  const context = parityFixture();
  // No R2 object stored for this key, and the source read also fails —
  // bothUnreadable is the only bucket with anything in it.
  seedParityTarget(context.database, PARITY_USERS, [PARITY_USERS[0]]);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom([{ userId: PARITY_USERS[0], avatarPath: "p" }]),
    readSourceBytes: async () => null,
  });
  assert.equal(report.bytes.bothUnreadable.total, 1);
  assert.equal(report.disappearingFaces.total, 0);
  assert.equal(report.targetOnly.total, 0);
  assert.equal(report.status, "drifted");
});

test("avatar-parity: sampleLimit bounds a bucket's stored sample, but the total keeps counting past it", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS);
  const rows = PARITY_USERS.map((userId) => ({ userId, avatarPath: "p" }));
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePageFrom(rows),
    sampleLimit: 1,
  });
  assert.equal(report.disappearingFaces.total, 2);
  assert.equal(report.disappearingFaces.sample.length, 1);
});

test("avatar-parity: an aborted comparison reports every completeness flag as false, never true", async () => {
  const context = parityFixture();
  seedParityTarget(context.database, PARITY_USERS);
  const report = await avatarParity.avatarObjectParityReport(context.bindings, {
    readSourcePage: async () => { throw new Error("source unavailable"); },
  });
  assert.equal(report.status, "unavailable");
  assert.equal(report.complete, false);
  assert.equal(report.presenceComplete, false);
  assert.equal(report.bytesComplete, false);
});

test("parseAvatarObjectParityFlag: only '1', 'true' and 'all' turn it on", () => {
  assert.equal(avatarParity.parseAvatarObjectParityFlag(null), false);
  assert.equal(avatarParity.parseAvatarObjectParityFlag("0"), false);
  assert.equal(avatarParity.parseAvatarObjectParityFlag("TRUE"), false);
  assert.equal(avatarParity.parseAvatarObjectParityFlag("1"), true);
  assert.equal(avatarParity.parseAvatarObjectParityFlag("true"), true);
  assert.equal(avatarParity.parseAvatarObjectParityFlag("all"), true);
});

/* ------------------------------------------------------------------------ *
 * payloads.ts
 * ------------------------------------------------------------------------ */

function payloadsFixture() {
  const database = migratedDatabase();
  const files = filesStub();
  return { database, files, bindings: { db: runtimeD1(database), files } };
}

const PAYLOAD_OWNER = "50000000-0000-4000-8000-000000000021";

function seedPayloadUser(database, userId) {
  database.prepare(`
    INSERT INTO app_users (id,email,role,created_at,updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(userId, `${userId}@example.test`, OLD, NEW);
}

test("payloads: a value at or under the inline limit is stored inline; one byte over goes to R2", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);

  // 96 * 1024 bytes exactly, once JSON-encoded, must stay inline.
  const atLimit = "a".repeat(96 * 1024 - 2); // -2 for the JSON quotes
  const inlineResult = await payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, atLimit);
  assert.notEqual(inlineResult.inline, null);
  assert.equal(inlineResult.objectKey, null);

  const overLimit = "a".repeat(96 * 1024 - 1);
  const objectResult = await payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, overLimit);
  assert.equal(objectResult.inline, null);
  assert.notEqual(objectResult.objectKey, null);
});

test("payloads: safeSegment caps a segment at 180 characters and substitutes disallowed characters with _", async () => {
  const context = payloadsFixture();
  const longOwner = "o".repeat(300);
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const result = await payloads.storeJson(context.bindings, "ns", longOwner, "x".repeat(200 * 1024));
  // private/ns/<owner>/<digest>.json
  const ownerSegment = result.objectKey.split("/")[2];
  assert.equal(ownerSegment.length, 180);
});

test("payloads: an empty segment from a doubled slash is dropped, not kept as a blank path component", async () => {
  const context = payloadsFixture();
  const result = await payloads.storeJson(context.bindings, "a//b", PAYLOAD_OWNER, "x".repeat(200 * 1024));
  assert.match(result.objectKey, /^private\/a\/b\//);
});

test("payloads: safeSegment substitutes a disallowed character with _, not with nothing", async () => {
  const context = payloadsFixture();
  const result = await payloads.storeJson(context.bindings, "ns", "weird owner", "x".repeat(200 * 1024));
  const ownerSegment = result.objectKey.split("/")[2];
  assert.equal(ownerSegment, "weird_owner");
});

test("payloads: a payload over MAX_JSON_BYTES is refused with its own message, before any write", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const huge = "a".repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(
    () => payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, huge),
    /JSON payload exceeds the storage limit/,
  );
  assert.equal(context.files._store.size, 0);
});

test("payloads: exactly MAX_JSON_BYTES is accepted; one byte more is refused", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const maxJsonBytes = 2 * 1024 * 1024;
  const atLimit = "a".repeat(maxJsonBytes - 2); // -2 for the JSON string's quotes
  await assert.doesNotReject(() => payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, atLimit));
  await assert.rejects(
    () => payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, "a".repeat(maxJsonBytes - 1)),
    /JSON payload exceeds the storage limit/,
  );
});

test("payloads: an R2 object is stored with its exact JSON content type, cache header and checksum metadata", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const stored = await payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, "x".repeat(200 * 1024));
  assert.equal(context.files._puts.length, 1);
  const { options } = context.files._puts[0];
  assert.deepEqual(options, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { sha256: stored.sha256 },
  });
});

test("payloads: a multi-segment namespace keeps its separators — each segment is sanitised on its own", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const big = "x".repeat(200 * 1024);
  const result = await payloads.storeJson(context.bindings, "progress/ielts-prep-v1", PAYLOAD_OWNER, big);
  assert.match(result.objectKey, /^private\/progress\/ielts-prep-v1\//);
});

test("payloads: a namespace that sanitises down to nothing is an invalid namespace, not a silent empty segment", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const big = "x".repeat(200 * 1024);
  await assert.rejects(
    () => payloads.storeJson(context.bindings, "./..", PAYLOAD_OWNER, big),
    /Invalid storage namespace/,
  );
});

function seedTombstone(database, userId, state) {
  const completedAt = state === "complete" ? NEW : null;
  database.prepare(`
    INSERT INTO account_deletion_tombstones
      (user_id, operation_id, state, prepared_at, lease_expires_at,
       auth_deleted_at, data_deleted_at, completed_at, updated_at)
    VALUES (?, 'op-0000000000000001', ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, state, OLD, NEW, completedAt, completedAt, completedAt, NEW);
}

test("payloads: storeJson refuses to write while account deletion is in progress, for the object path only", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  seedTombstone(context.database, PAYLOAD_OWNER, "prepared");
  const big = "x".repeat(200 * 1024);
  await assert.rejects(
    () => payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, big),
    /Cloudflare account deletion is already in progress/,
  );
  assert.equal(context.files._store.size, 0, "the object must never be captured by the race table without the deletion error");
});

test("payloads: a same-key race with a completed deletion deletes the just-written object instead of keeping it", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const big = "x".repeat(200 * 1024);
  // Seed the tombstone as already 'complete' before the write races past it.
  seedTombstone(context.database, PAYLOAD_OWNER, "complete");
  await assert.rejects(
    () => payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, big),
    /Cloudflare account deletion is already in progress/,
  );
  assert.equal(context.files._store.size, 0, "a completed deletion must delete the object the write just put, not keep it");
});

test("payloads: a deletion that starts mid-upload is caught after the R2 write, not just before it", async () => {
  // The pre-write check (deletionState) finds nothing; a tombstone is
  // inserted for real only once R2's put() has been called — simulating a
  // deletion that began strictly after storeJson's own pre-check already
  // passed. captureDeletionRace's own post-write check must still catch it.
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  let putCalled = false;
  const racingFiles = {
    ...context.files,
    async put(key, bytes, options) {
      await context.files.put(key, bytes, options);
      putCalled = true;
      seedTombstone(context.database, PAYLOAD_OWNER, "prepared");
    },
  };
  const bindings = { db: context.bindings.db, files: racingFiles };
  await assert.rejects(
    () => payloads.storeJson(bindings, "progress/v1", PAYLOAD_OWNER, "x".repeat(200 * 1024)),
    /Cloudflare account deletion is already in progress/,
  );
  assert.equal(putCalled, true, "the race can only be observed after put() actually ran");
});

test("payloads: a race captured while the deletion is not yet complete leaves the just-written object in place", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const racingFiles = {
    ...context.files,
    async put(key, bytes, options) {
      await context.files.put(key, bytes, options);
      seedTombstone(context.database, PAYLOAD_OWNER, "prepared");
    },
  };
  const bindings = { db: context.bindings.db, files: racingFiles };
  await assert.rejects(() => payloads.storeJson(bindings, "progress/v1", PAYLOAD_OWNER, "x".repeat(200 * 1024)));
  // 'prepared' (not 'complete') must not delete the object it just wrote.
  assert.equal(context.files._store.size, 1);
});

test("payloads: a race captured while the deletion has already completed deletes the just-written object", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const racingFiles = {
    ...context.files,
    async put(key, bytes, options) {
      await context.files.put(key, bytes, options);
      seedTombstone(context.database, PAYLOAD_OWNER, "complete");
    },
  };
  const bindings = { db: context.bindings.db, files: racingFiles };
  await assert.rejects(() => payloads.storeJson(bindings, "progress/v1", PAYLOAD_OWNER, "x".repeat(200 * 1024)));
  assert.equal(context.files._store.size, 0, "'complete' arriving mid-upload must delete the object the write just made");
});

test("payloads: readStoredJson accepts an inline payload and rejects a tampered byte count or checksum", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const stored = await payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, { a: 1 });
  assert.deepEqual(await payloads.readStoredJson(context.bindings, stored), { a: 1 });

  await assert.rejects(
    () => payloads.readStoredJson(context.bindings, { ...stored, bytes: stored.bytes + 1 }),
    /Cloudflare object checksum mismatch/,
  );
  await assert.rejects(
    () => payloads.readStoredJson(context.bindings, { ...stored, sha256: "0".repeat(64) }),
    /Cloudflare object checksum mismatch/,
  );
});

test("payloads: readStoredJson on an R2 object distinguishes missing-object from no-content-at-all", async () => {
  const context = payloadsFixture();
  seedPayloadUser(context.database, PAYLOAD_OWNER);
  const big = "x".repeat(200 * 1024);
  const stored = await payloads.storeJson(context.bindings, "progress/v1", PAYLOAD_OWNER, big);
  context.files._store.delete(stored.objectKey);
  await assert.rejects(
    () => payloads.readStoredJson(context.bindings, stored),
    /Cloudflare object is missing/,
  );
  await assert.rejects(
    () => payloads.readStoredJson(context.bindings, { inline: null, objectKey: null, sha256: "x", bytes: 0 }),
    /Stored payload has no content/,
  );
});

/* ------------------------------------------------------------------------ *
 * payload-canonical.ts
 * ------------------------------------------------------------------------ */

test("payload-canonical: compareUtf8Bytes drives object key ordering by UTF-8 byte value, not JS string compare", () => {
  // "é" (2-byte UTF-8) vs "z" (1 byte, smaller byte value 0x7A < 0xC3):
  // byte order puts "z" first even though "é" < "z" in a naive compare
  // only sometimes — use a pair where the two orders disagree unambiguously.
  const result = payloadCanonical.canonicalizePayloadJson({ "é": 1, "z": 2 });
  assert.equal(result, '{"z":2,"é":1}');
});

test("payload-canonical: a key that is a byte-prefix of another sorts first, using only the shorter length", () => {
  // "a" and "ab" agree on every byte of the shorter key, so the comparison
  // only resolves via a.length - b.length once the common bytes run out —
  // using the longer length here would read past "a"'s own bytes.
  const result = payloadCanonical.canonicalizePayloadJson({ ab: 1, a: 2 });
  assert.equal(result, '{"a":2,"ab":1}');
});

test("payload-canonical: expandScientificNotation covers a positive and a negative exponent, and a negative sign", () => {
  assert.equal(payloadCanonical.canonicalPayloadNumber(1e21), "1000000000000000000000");
  assert.equal(payloadCanonical.canonicalPayloadNumber(1.5e-7), "0.00000015");
  assert.equal(payloadCanonical.canonicalPayloadNumber(-1.5e21), "-1500000000000000000000");
});

test("payload-canonical: expandScientificNotation captures every fractional digit, not just the first", () => {
  // (123.456e20).toString() is "1.23456e+22" — a five-digit fraction.
  assert.equal(payloadCanonical.canonicalPayloadNumber(123.456e20), "12345600000000000000000");
});

test("payload-canonical: trailing-zero trimming stops at the first non-zero digit, and a whole result never keeps a bare dot", () => {
  assert.equal(payloadCanonical.canonicalPayloadNumber(1.10), "1.1");
  assert.equal(payloadCanonical.canonicalPayloadNumber(100), "100");
  assert.equal(payloadCanonical.canonicalPayloadNumber(1.0), "1");
});

test("payload-canonical: -0 folds to 0, and a genuine negative stays negative", () => {
  assert.equal(payloadCanonical.canonicalPayloadNumber(-0), "0");
  assert.equal(payloadCanonical.canonicalPayloadNumber(-5), "-5");
});

test("payload-canonical: non-finite numbers refuse to hash, both at the top level and nested in an object", () => {
  assert.throws(() => payloadCanonical.canonicalPayloadNumber(Number.NaN), /cannot hash a non-finite number/);
  assert.throws(() => payloadCanonical.canonicalPayloadNumber(Number.POSITIVE_INFINITY), /cannot hash a non-finite number/);
  assert.throws(() => payloadCanonical.canonicalizePayloadJson({ a: Number.NEGATIVE_INFINITY }));
});

test("payload-canonical: an unsupported JSON-incompatible type reports its own typeof in the message", () => {
  assert.throws(() => payloadCanonical.canonicalizePayloadJson(() => {}), /cannot hash a function/);
  assert.throws(() => payloadCanonical.canonicalizePayloadJson(Symbol("x")), /cannot hash a symbol/);
});

test("payload-canonical: array order is preserved; object key order is not", () => {
  assert.equal(payloadCanonical.canonicalizePayloadJson([3, 1, 2]), "[3,1,2]");
  assert.equal(payloadCanonical.canonicalizePayloadJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("payload-canonical: canonicalPayloadHash hashes the canonical string, and key order never changes the hash", async () => {
  const a = { z: 1, a: 2 };
  const b = { a: 2, z: 1 };
  assert.equal(await payloadCanonical.canonicalPayloadHash(a), await payloadCanonical.canonicalPayloadHash(b));
});
