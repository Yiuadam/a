/*
  The D1-only AI cost ledger write (lib/cloudflare/ai-cost-write-authority.ts).

  Same node:sqlite harness as tests/cloudflare-usage-quota-authority.test.mjs
  — see that file's header for why a real database rather than a JS mock.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const authority = await import(pathToFileURL(
  join(process.cwd(), "lib", "cloudflare", "ai-cost-write-authority.ts"),
).href);

function runtimeD1(database) {
  const execute = (sql, values) => {
    const result = database.prepare(sql).run(...values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes ?? 0) },
    };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute(sql, values); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
  });
  return {
    prepare(sql) {
      return {
        bind: (...values) => bound(sql, values),
        ...bound(sql, []),
      };
    },
  };
}

function fixture({ seedSequence = true } = {}) {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS cloudflare_id_sequences (
      sequence_name TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL
    ) STRICT;
  `);
  if (seedSequence) {
    database.prepare(
      "INSERT INTO cloudflare_id_sequences (sequence_name, next_value) VALUES ('ai_cost_events', 2000)",
    ).run();
  }
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

function baseInput(overrides = {}) {
  return {
    providerRequestId: "msg_authority_1",
    route: "chat",
    model: "claude-haiku-4-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: "0.00035",
    occurredAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

test("a fresh response is inserted once with a minted numeric id", async () => {
  const context = fixture();
  const result = await authority.recordAiCostEventOnCloudflare(baseInput(), context.bindings);
  assert.equal(result.inserted, true);
  assert.match(result.event.id, /^[1-9]\d*$/);
  assert.equal(result.event.providerRequestId, "msg_authority_1");
  assert.equal(result.event.costUsd, "0.00035");
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM ai_cost_events").get().n,
    1,
  );
});

test("a retry of the same provider request id is idempotent and returns the stored row", async () => {
  const context = fixture();
  const first = await authority.recordAiCostEventOnCloudflare(baseInput(), context.bindings);
  const second = await authority.recordAiCostEventOnCloudflare(
    baseInput({ inputTokens: 999, costUsd: "9.99" }),
    context.bindings,
  );
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false, "a duplicate provider request id must not insert a second row");
  assert.equal(second.event.id, first.event.id, "a retry must return the row that was actually stored");
  assert.equal(second.event.inputTokens, 100, "a retry must not overwrite the stored row with new numbers");
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM ai_cost_events").get().n,
    1,
  );
});

test("two different responses mint two different ids", async () => {
  const context = fixture();
  const a = await authority.recordAiCostEventOnCloudflare(
    baseInput({ providerRequestId: "msg_authority_a" }),
    context.bindings,
  );
  const b = await authority.recordAiCostEventOnCloudflare(
    baseInput({ providerRequestId: "msg_authority_b" }),
    context.bindings,
  );
  assert.notEqual(a.event.id, b.event.id);
});

test("an unseeded ai_cost_events id sequence fails loudly", async () => {
  const context = fixture({ seedSequence: false });
  await assert.rejects(
    () => authority.recordAiCostEventOnCloudflare(baseInput(), context.bindings),
    authority.CloudflareAiCostIdSequenceNotSeededError,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM ai_cost_events").get().n,
    0,
  );
});

test("many concurrent writes for distinct responses never collide on id or drop a row", async () => {
  const context = fixture();
  const N = 30;
  const results = await Promise.all(
    Array.from({ length: N }, (_, index) => authority.recordAiCostEventOnCloudflare(
      baseInput({ providerRequestId: `msg_authority_concurrent_${index}` }),
      context.bindings,
    )),
  );
  assert.equal(results.every((result) => result.inserted), true);
  const ids = new Set(results.map((result) => result.event.id));
  assert.equal(ids.size, N, "every concurrent write must mint a distinct id");
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM ai_cost_events").get().n,
    N,
  );
});
