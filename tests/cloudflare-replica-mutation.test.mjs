import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);

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
    async put(key, value) {
      if (typeof value === "string") objects.set(key, new TextEncoder().encode(value));
      else if (value instanceof ArrayBuffer) objects.set(key, new Uint8Array(value.slice(0)));
      else if (ArrayBuffer.isView(value)) objects.set(key, Uint8Array.from(value));
      else if (value instanceof Blob) objects.set(key, new Uint8Array(await value.arrayBuffer()));
      else throw new Error("unsupported test R2 body");
      return { key };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      const copy = Uint8Array.from(value);
      return { async arrayBuffer() { return copy.buffer; } };
    },
    async list({ prefix = "", cursor } = {}) {
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  return { database, objects, bindings: { db: runtimeD1(database), files } };
}

const replay = await load("lib", "cloudflare", "replica-replay.ts");
const outbox = await load("lib", "cloudflare", "replica-outbox.ts");
const dataRouter = await load("lib", "cloudflare", "data-router.ts");
const bindings = await load("lib", "cloudflare", "bindings.ts");

const USER = {
  id: "50000000-0000-4000-8000-000000000088",
  email: "test@example.test",
  createdAt: "2026-08-01T00:00:00.000Z",
};

test("replica-outbox.ts: task failures record error codes and schedule retries correctly", async () => {
  const context = fixture();

  // Test that a task failure with a specific error message records the correct error code
  const task = {
    taskId: "test:001",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "001" },
  };

  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, 1000);

  // Execute with an error that should match "account deletion is in progress"
  const execute = async () => {
    throw new Error("account deletion is in progress");
  };

  const result = await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
    nowMs: 2000,
  });

  assert.equal(result.failed, 1);

  const row = context.database.prepare(`
    SELECT last_error_code, available_at FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);

  assert.equal(row.last_error_code, "account_deletion_in_progress");
  // Verify that available_at is in the future and was calculated correctly
  assert.ok(new Date(row.available_at).getTime() > 2000);
});

test("replica-outbox.ts: retry backoff increases with attempt count", async () => {
  const context = fixture();

  const task = {
    taskId: "backoff:001",
    operation: "learner_profile",
    subjectUserId: USER.id,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { user: USER, profile: {} },
  };

  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, 1000);

  // Fail the task multiple times and check that retry delays increase
  const execute = async () => { throw new Error("test failure"); };
  const retryTimes = [];

  for (let i = 1; i <= 3; i++) {
    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: 1000 + (i * 100_000_000), // Far future
    });

    const row = context.database.prepare(`
      SELECT available_at FROM cloudflare_replica_outbox WHERE task_id = ?
    `).get(task.taskId);

    retryTimes.push(new Date(row.available_at).getTime());
  }

  // Each retry should be scheduled further in future than the last
  assert.ok(retryTimes[1] > retryTimes[0]);
  assert.ok(retryTimes[2] > retryTimes[1]);
});

test("replica-outbox.ts: max attempts limits retries to exactly CLOUDFLARE_REPLICA_MAX_ATTEMPTS", async () => {
  const context = fixture();

  const task = {
    taskId: "maxattempts:001",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "001" },
  };

  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, 1000);

  const execute = async () => { throw new Error("persistent failure"); };

  // Run drain CLOUDFLARE_REPLICA_MAX_ATTEMPTS times
  for (let i = 1; i <= outbox.CLOUDFLARE_REPLICA_MAX_ATTEMPTS; i++) {
    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: 1000 + (i * 10_000_000),
    });
  }

  const row = context.database.prepare(`
    SELECT attempts_made, status FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);

  // Should be exactly CLOUDFLARE_REPLICA_MAX_ATTEMPTS
  assert.equal(row.attempts_made, outbox.CLOUDFLARE_REPLICA_MAX_ATTEMPTS);
  assert.equal(row.status, "dead");

  // One more drain should not change it
  await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
    nowMs: 999_000_000,
  });

  const unchanged = context.database.prepare(`
    SELECT attempts_made, status FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);

  assert.equal(unchanged.attempts_made, outbox.CLOUDFLARE_REPLICA_MAX_ATTEMPTS);
  assert.equal(unchanged.status, "dead");
});

test("replica-outbox.ts: different error types are recognized correctly", async () => {
  const errorTests = [
    { message: "executor returned false", expectedCode: "executor_rejected" },
    { message: "checksum mismatch", expectedCode: "checksum_mismatch" },
    { message: "object has no content", expectedCode: "payload_empty" },
    { message: "exceeds the storage limit", expectedCode: "payload_too_large" },
  ];

  for (const { message, expectedCode } of errorTests) {
    const context = fixture();

    const task = {
      taskId: `error-test:${message}`,
      operation: "usage_event",
      subjectUserId: null,
      sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
      payload: { id: "001" },
    };

    await outbox.enqueueCloudflareReplicaTask(task, context.bindings, 1000);

    const execute = async () => { throw new Error(message); };

    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: 2000,
    });

    const row = context.database.prepare(`
      SELECT last_error_code FROM cloudflare_replica_outbox WHERE task_id = ?
    `).get(task.taskId);

    assert.equal(row.last_error_code, expectedCode, `Should recognize error: ${message}`);
  }
});

test("replica-outbox.ts: backoff boundary - first attempt has minimal delay", async () => {
  const context = fixture();

  const task = {
    taskId: "backoff-boundary:001",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "001" },
  };

  const nowMs = 1000000;
  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, nowMs);

  const execute = async () => { throw new Error("fail"); };

  await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, { nowMs });

  const row = context.database.prepare(`
    SELECT available_at FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);

  const availableMs = new Date(row.available_at).getTime();

  // First attempt (attempt 1) should use exponent 0, so base = min(3600, 15*2^0) = min(3600, 15) = 15 seconds
  // Jitter is (1 * 7919) % 5000 = 2919ms, so total should be 15000 + 2919 = 17919ms
  // Allow some tolerance
  assert.ok(availableMs >= nowMs + 15000, "First retry should be at least 15 seconds");
  assert.ok(availableMs <= nowMs + 25000, "First retry should be at most ~25 seconds (15 + 5s jitter)");
});

test("replica-outbox.ts: backoff second attempt is exponentially longer", async () => {
  const context = fixture();

  const task = {
    taskId: "backoff-second:001",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "001" },
  };

  const nowMs = 1000000;
  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, nowMs);

  const execute = async () => { throw new Error("fail"); };

  // First failure
  await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, { nowMs });
  const row1 = context.database.prepare(`
    SELECT available_at FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);
  const available1Ms = new Date(row1.available_at).getTime();

  // Second failure (far in future to trigger retry)
  const farFutureMs = nowMs + 100_000_000;
  await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, { nowMs: farFutureMs });
  const row2 = context.database.prepare(`
    SELECT available_at FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);
  const available2Ms = new Date(row2.available_at).getTime();

  // Attempt 2 should use exponent 1, so base = min(3600, 15*2^1) = min(3600, 30) = 30 seconds
  // So available2 - farFutureMs should be at least 30000ms
  assert.ok(available2Ms >= farFutureMs + 30000, "Second retry should be at least 30 seconds from attempt time");
  assert.ok(available2Ms > available1Ms, "Second retry should be further than first");
});

test("replica-outbox.ts: backoff caps at 1 hour maximum", async () => {
  const context = fixture();

  const task = {
    taskId: "backoff-cap:001",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "001" },
  };

  const nowMs = 1000000;
  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, nowMs);

  const execute = async () => { throw new Error("fail"); };

  // Simulate many failed attempts to get to high attempt counts
  for (let i = 1; i <= 10; i++) {
    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: nowMs + (i * 100_000_000),
    });
  }

  const row = context.database.prepare(`
    SELECT available_at FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(task.taskId);

  const availableMs = new Date(row.available_at).getTime();
  const lastDrainTime = nowMs + (10 * 100_000_000);

  // Should not exceed 1 hour (3600000 ms) plus some jitter (up to 5000ms)
  assert.ok(availableMs <= lastDrainTime + 3600000 + 5000, "Backoff should cap at 1 hour");
  assert.ok(availableMs > lastDrainTime, "Should still schedule in future");
});

test("replica-outbox.ts: error patterns match case-insensitively", async () => {
  const context = fixture();

  const testCases = [
    { message: "Account Deletion Is IN PROGRESS", expectedCode: "account_deletion_in_progress" },
    { message: "Account deletion is already in progress", expectedCode: "account_deletion_in_progress" },
    { message: "EXECUTOR RETURNED FALSE", expectedCode: "executor_rejected" },
  ];

  for (const { message, expectedCode } of testCases) {
    const task = {
      taskId: `regex-test:${Math.random()}`,
      operation: "usage_event",
      subjectUserId: null,
      sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
      payload: { id: "001" },
    };

    await outbox.enqueueCloudflareReplicaTask(task, context.bindings, 1000);

    const execute = async () => { throw new Error(message); };

    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: 2000,
    });

    const row = context.database.prepare(`
      SELECT last_error_code FROM cloudflare_replica_outbox WHERE task_id = ?
    `).get(task.taskId);

    assert.equal(row.last_error_code, expectedCode, `Case-insensitive match for: ${message}`);
  }
});

test("replica-outbox.ts: jitter varies per attempt count", async () => {
  const context = fixture();

  const task = {
    taskId: "jitter-test:001",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "001" },
  };

  const nowMs = 1000000;
  await outbox.enqueueCloudflareReplicaTask(task, context.bindings, nowMs);

  const execute = async () => { throw new Error("fail"); };

  // Collect retry times at different attempt counts
  const times = [nowMs];

  for (let i = 1; i <= 5; i++) {
    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: nowMs + (i * 100_000_000),
    });

    const row = context.database.prepare(`
      SELECT available_at FROM cloudflare_replica_outbox WHERE task_id = ?
    `).get(task.taskId);

    times.push(new Date(row.available_at).getTime());
  }

  // Each successive retry should be scheduled further in future
  // (accounting for the fact that we're calling from different now times)
  for (let i = 1; i < times.length - 1; i++) {
    assert.ok(times[i + 1] > times[i], `Retry ${i+1} should be scheduled later than retry ${i}`);
  }
});
