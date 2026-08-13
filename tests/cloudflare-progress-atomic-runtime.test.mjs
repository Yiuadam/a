import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const learner = await import(pathToFileURL(
  join(process.cwd(), "lib", "cloudflare", "learner-data.ts"),
).href);

function runtimeD1(database, beforeRun = null) {
  const result = (statement) => {
    beforeRun?.(statement);
    const executed = database.prepare(statement.sql).run(...statement.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(executed.changes ?? 0) },
    };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() {
      return result({ sql, values });
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
      return {
        bind: (...values) => bound(sql, values),
        ...bound(sql, []),
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          beforeRun?.(statement);
          if (/^\s*WITH expected[\s\S]*SELECT count\(\*\) AS conflict_count/i.test(statement.sql)) {
            return {
              success: true,
              results: database.prepare(statement.sql).all(...statement.values),
              meta: {},
            };
          }
          return result(statement);
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fixture(beforeRun = null) {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  const id = "50000000-0000-4000-8000-000000000002";
  const stamp = "2026-08-13T10:00:00.000Z";
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, 'learner@example.test', 'user', ?, ?)
  `).run(id, stamp, stamp);
  const files = {
    async put() {},
    async delete() {},
    async get() { return null; },
  };
  return {
    database,
    bindings: { db: runtimeD1(database, beforeRun), files },
    user: { id, email: "learner@example.test" },
  };
}

function expected(storeKey, payload = null, clientUpdatedAt = null) {
  return { storeKey, exists: payload !== null, payload, clientUpdatedAt };
}

test("Cloudflare commits the three progress stores as one guarded statement", async () => {
  const context = fixture();
  const batch = [
    { storeKey: "ielts-prep-v1", payload: { visited: ["reading"] } },
    { storeKey: "bandup.drills.v1", payload: { articles: { correct: 7, total: 8, at: "now" } } },
    { storeKey: "bandup.lookups.v1", payload: { cohort: { definition: "group" } } },
  ];
  const result = await learner.compareAndSwapCloudflareProgressSnapshots(
    context.user,
    batch.map((item) => expected(item.storeKey)),
    batch,
    context.bindings,
  );
  assert.equal(result.status, "committed");
  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM progress_snapshots").get().count,
    3,
  );
});

test("a stale Cloudflare expectation conflicts and changes no key", async () => {
  const context = fixture();
  const first = [{ storeKey: "ielts-prep-v1", payload: { visited: ["reading"] } }];
  const committed = await learner.compareAndSwapCloudflareProgressSnapshots(
    context.user,
    [expected("ielts-prep-v1")],
    first,
    context.bindings,
  );
  assert.equal(committed.status, "committed");

  const stale = await learner.compareAndSwapCloudflareProgressSnapshots(
    context.user,
    [expected("ielts-prep-v1")],
    [{ storeKey: "ielts-prep-v1", payload: { visited: ["listening"] } }],
    context.bindings,
  );
  assert.equal(stale.status, "conflict");
  const row = context.database.prepare(
    "SELECT payload_inline FROM progress_snapshots WHERE store_key = 'ielts-prep-v1'",
  ).get();
  assert.deepEqual(JSON.parse(row.payload_inline), { visited: ["reading"] });
});

test("a database error rolls the Cloudflare batch back rather than partially saving", async () => {
  let failProgressWrite = true;
  const context = fixture((statement) => {
    if (failProgressWrite && statement.sql.includes("INSERT INTO progress_snapshots")) {
      failProgressWrite = false;
      throw new Error("simulated D1 outage");
    }
  });
  const batch = [
    { storeKey: "ielts-prep-v1", payload: { visited: ["reading"] } },
    { storeKey: "bandup.drills.v1", payload: { articles: { correct: 7 } } },
    { storeKey: "bandup.lookups.v1", payload: { cohort: { definition: "group" } } },
  ];
  await assert.rejects(
    learner.compareAndSwapCloudflareProgressSnapshots(
      context.user,
      batch.map((item) => expected(item.storeKey)),
      batch,
      context.bindings,
    ),
    /simulated D1 outage/,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM progress_snapshots").get().count,
    0,
  );
});
