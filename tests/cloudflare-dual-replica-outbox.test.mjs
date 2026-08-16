import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const outbox = await load("lib", "cloudflare", "replica-outbox.ts");
const replay = await load("lib", "cloudflare", "replica-replay.ts");

function runtimeD1(database, beforeRun = null) {
  const execute = (statement) => {
    beforeRun?.(statement);
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

function fixture(beforeRun = null) {
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
      assert.equal(cursor, undefined);
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  return { database, objects, bindings: { db: runtimeD1(database, beforeRun), files } };
}

const USER = {
  id: "50000000-0000-4000-8000-000000000088",
  email: "outbox@example.test",
  createdAt: "2026-08-01T00:00:00.000Z",
};

function task(sourceUpdatedAt, payload = { value: sourceUpdatedAt }) {
  return {
    taskId: `profile:${USER.id}`,
    operation: "learner_profile",
    subjectUserId: USER.id,
    sourceUpdatedAt,
    payload,
  };
}

test("a newer coalesced snapshot wins and an old enqueue cannot reset its retry budget", async () => {
  const context = fixture();
  const newer = task("2026-08-14T10:00:00.000Z", { value: "new" });
  const older = task("2026-08-14T09:00:00.000Z", { value: "old" });
  assert.equal(await outbox.enqueueCloudflareReplicaTask(newer, context.bindings, 1_000), true);
  context.database.prepare(`
    UPDATE cloudflare_replica_outbox SET attempts_made = 3 WHERE task_id = ?
  `).run(newer.taskId);
  assert.equal(await outbox.enqueueCloudflareReplicaTask(older, context.bindings, 2_000), true);
  const row = context.database.prepare(`
    SELECT source_updated_at, payload_inline, attempts_made, generation
      FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(newer.taskId);
  assert.equal(row.source_updated_at, "2026-08-14T10:00:00.000000000Z");
  assert.deepEqual(JSON.parse(row.payload_inline), { value: "new" });
  assert.equal(row.attempts_made, 3);
  assert.equal(row.generation, 1);
});

test("source clocks preserve ordering for two commits inside the same millisecond", async () => {
  const context = fixture();
  const first = task("2026-08-14T10:00:00.123001+00:00", { value: "first" });
  const second = task("2026-08-14T10:00:00.123002+00:00", { value: "second" });
  await outbox.enqueueCloudflareReplicaTask(first, context.bindings, 1_000);
  await outbox.enqueueCloudflareReplicaTask(second, context.bindings, 2_000);
  await outbox.enqueueCloudflareReplicaTask(first, context.bindings, 3_000);
  const row = context.database.prepare(`
    SELECT source_updated_at, payload_inline, generation
      FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(first.taskId);
  assert.deepEqual({ ...row }, {
    source_updated_at: "2026-08-14T10:00:00.123002000Z",
    payload_inline: JSON.stringify({ value: "second" }),
    generation: 2,
  });
});

test("a failed task is leased, backed off and replayed idempotently", async () => {
  let failAcknowledgement = true;
  const context = fixture((statement) => {
    if (
      failAcknowledgement
      && statement.sql.includes("DELETE FROM cloudflare_replica_outbox")
    ) {
      failAcknowledgement = false;
      throw new Error("simulated crash after target commit");
    }
  });
  context.database.exec("CREATE TABLE replay_target (id TEXT PRIMARY KEY) STRICT");
  const item = {
    taskId: "usage:701",
    operation: "usage_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "701" },
  };
  await outbox.enqueueCloudflareReplicaTask(item, context.bindings, 1_000);
  const execute = async (queued) => {
    context.database.prepare("INSERT OR IGNORE INTO replay_target (id) VALUES (?)")
      .run(queued.payload.id);
    return true;
  };
  const first = await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
    nowMs: 2_000,
  });
  assert.equal(first.failed, 1);
  assert.equal(context.database.prepare("SELECT count(*) count FROM replay_target").get().count, 1);
  const retained = context.database.prepare(`
    SELECT attempts_made, status, lease_token FROM cloudflare_replica_outbox
  `).get();
  assert.deepEqual({ ...retained }, { attempts_made: 1, status: "pending", lease_token: null });

  const second = await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
    nowMs: 100_000,
  });
  assert.equal(second.succeeded, 1);
  assert.equal(context.database.prepare("SELECT count(*) count FROM replay_target").get().count, 1);
  assert.equal(context.database.prepare("SELECT count(*) count FROM cloudflare_replica_outbox").get().count, 0);
});

test("retry attempts are bounded and a dead task remains visible for parity", async () => {
  const context = fixture();
  const item = {
    taskId: "ai-cost:801",
    operation: "ai_cost_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "801" },
  };
  await outbox.enqueueCloudflareReplicaTask(item, context.bindings, 1_000);
  const execute = async () => { throw new Error("persistent target failure"); };
  for (let attempt = 1; attempt <= outbox.CLOUDFLARE_REPLICA_MAX_ATTEMPTS; attempt += 1) {
    await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
      nowMs: attempt * 10_000_000,
    });
  }
  const row = context.database.prepare(`
    SELECT attempts_made, status FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(item.taskId);
  assert.deepEqual({ ...row }, { attempts_made: 12, status: "dead" });
  const after = await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, {
    nowMs: 999_000_000,
  });
  assert.equal(after.selected, 0);
  const status = await outbox.cloudflareReplicaOutboxStatus(context.bindings);
  assert.equal(status.dead, 1);
  assert.equal(status.pending, 0);
  assert.deepEqual(
    await outbox.requeueDeadCloudflareReplicaTasks(context.bindings, 1, 1_000_000_000),
    { tasks: 1, objects: 0 },
  );
  assert.deepEqual(
    { ...context.database.prepare(`
      SELECT attempts_made, status FROM cloudflare_replica_outbox WHERE task_id = ?
    `).get(item.taskId) },
    { attempts_made: 0, status: "pending" },
  );
});

test("superseded R2 outbox payloads are deleted only after pointer recheck", async () => {
  const context = fixture();
  const first = task("2026-08-14T10:00:00.000Z", { body: "a".repeat(600_000) });
  const second = task("2026-08-14T11:00:00.000Z", { body: "b".repeat(600_000) });
  await outbox.enqueueCloudflareReplicaTask(first, context.bindings, 1_000);
  const oldKey = context.database.prepare(`
    SELECT payload_object_key FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(first.taskId).payload_object_key;
  await outbox.enqueueCloudflareReplicaTask(second, context.bindings, 2_000);
  const newKey = context.database.prepare(`
    SELECT payload_object_key FROM cloudflare_replica_outbox WHERE task_id = ?
  `).get(first.taskId).payload_object_key;
  assert.notEqual(oldKey, newKey);
  assert.equal(context.objects.has(oldKey), true);
  assert.equal(context.objects.has(newKey), true);
  const cleaned = await outbox.drainCloudflareReplicaObjectCleanup(context.bindings, {
    nowMs: 3_000,
  });
  assert.equal(cleaned.succeeded, 1);
  assert.equal(context.objects.has(oldKey), false);
  assert.equal(context.objects.has(newKey), true);
});

test("a delayed identity replay cannot roll a newer username or profile backwards", async () => {
  const context = fixture();
  const identityTask = (at, username, displayName) => ({
    taskId: `identity:${USER.id}`,
    operation: "account_identity",
    subjectUserId: USER.id,
    sourceUpdatedAt: at,
    payload: {
      user: USER,
      identity: { username, displayName, accountKind: "student", birthDate: null },
    },
  });
  assert.equal(await replay.executeCloudflareReplicaTask(
    identityTask("2026-08-14T11:00:00.000Z", "fresh.name", "Fresh"),
    context.bindings,
  ), true);
  assert.equal(await replay.executeCloudflareReplicaTask(
    identityTask("2026-08-14T10:00:00.000Z", "stale.name", "Stale"),
    context.bindings,
  ), true);
  const row = context.database.prepare(`
    SELECT n.username, n.source_updated_at, p.display_name, p.source_updated_at profile_at
      FROM usernames n JOIN learner_profiles p ON p.user_id = n.user_id
     WHERE n.user_id = ?
  `).get(USER.id);
  assert.deepEqual({ ...row }, {
    username: "fresh.name",
    source_updated_at: "2026-08-14T11:00:00.000000000Z",
    display_name: "Fresh",
    profile_at: "2026-08-14T11:00:00.000000000Z",
  });
});

test("an older leased avatar replay cannot replace a newer avatar", async () => {
  const context = fixture();
  const avatarTask = (at, bytes) => ({
    taskId: `avatar:${USER.id}`,
    operation: "avatar_put",
    subjectUserId: USER.id,
    sourceUpdatedAt: at,
    payload: {
      user: USER,
      base64: Buffer.from(bytes).toString("base64"),
      kind: { ext: "webp", mime: "image/webp" },
    },
  });
  const newer = avatarTask("2026-08-14T10:00:00.123002Z", [2, 2, 2]);
  const older = avatarTask("2026-08-14T10:00:00.123001Z", [1, 1, 1]);
  assert.equal(await replay.executeCloudflareReplicaTask(newer, context.bindings), true);
  const current = context.database.prepare(`
    SELECT avatar_object_key, avatar_source_updated_at
      FROM learner_profiles WHERE user_id = ?
  `).get(USER.id);
  assert.equal(await replay.executeCloudflareReplicaTask(older, context.bindings), true);
  const retained = context.database.prepare(`
    SELECT avatar_object_key, avatar_source_updated_at
      FROM learner_profiles WHERE user_id = ?
  `).get(USER.id);
  assert.deepEqual({ ...retained }, { ...current });
  assert.equal(retained.avatar_source_updated_at, "2026-08-14T10:00:00.123002000Z");
  assert.equal(context.objects.has(retained.avatar_object_key), true);
  assert.equal([...context.objects.keys()].filter((key) => key.startsWith(
    `private/avatars/${USER.id}/`,
  )).length, 1);
});

test("all Supabase-authoritative dual writers use the durable replay bridge", () => {
  const router = readFileSync(join(process.cwd(), "lib/cloudflare/data-router.ts"), "utf8");
  const avatar = readFileSync(join(process.cwd(), "app/api/account/avatar/route.ts"), "utf8");
  const billing = readFileSync(join(process.cwd(), "lib/billing/subscriptions.ts"), "utf8");
  const usage = readFileSync(join(process.cwd(), "lib/usage/guard.ts"), "utf8");
  const cost = readFileSync(join(process.cwd(), "lib/ai/cost-tracking.ts"), "utf8");
  const deletion = readFileSync(join(process.cwd(), "lib/cloudflare/account-deletion.ts"), "utf8");
  const operator = readFileSync(
    join(process.cwd(), "app/api/admin/cloudflare/replica-outbox/route.ts"),
    "utf8",
  );
  assert.match(router, /replicateLearnerProfileDurably/);
  assert.match(router, /replicateAccountIdentityDurably/);
  assert.match(router, /replicateUsernameDurably/);
  assert.match(router, /replicateProgressDurably/);
  assert.match(avatar, /replicateAvatarPutDurably/);
  assert.match(avatar, /replicateAvatarDeleteDurably/);
  assert.match(billing, /replicateStripeBillingDurably/);
  assert.match(usage, /replicateUsageEventDurably/);
  assert.match(cost, /replicateAiCostEventDurably/);
  assert.match(cost, /replicateAiCostCoverageDurably/);
  assert.match(deletion, /cloudflare_replica_outbox/);
  assert.match(deletion, /cloudflare_replica_object_cleanup/);
  assert.match(operator, /isAdminEmail/);
  assert.match(operator, /drainCloudflareReplicaOutbox/);
  assert.match(operator, /requeueDeadCloudflareReplicaTasks/);
  assert.match(operator, /Math\.max\(1, Math\.min\(8/);
  const sourceClock = readFileSync(
    join(process.cwd(), "supabase/migrations/0030_replica_source_clock_ordering.sql"),
    "utf8",
  );
  assert.match(sourceClock, /greatest\([\s\S]*interval '1 microsecond'/);
  assert.match(sourceClock, /set search_path = ''/);
  assert.match(sourceClock, /revoke all on function public\.claim_username/);
});

test("a stuck queue reports the classified reason, its age and where to look", async () => {
  const context = fixture();
  const item = {
    taskId: "ai-cost:901",
    operation: "ai_cost_event",
    subjectUserId: null,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: "901" },
  };
  await outbox.enqueueCloudflareReplicaTask(item, context.bindings, 1_000);
  // The message classifies; error.name is "Error" for every throw in this
  // pipeline, which is exactly why the recorded code used to say nothing.
  const execute = async () => { throw new Error("Cloudflare object is missing"); };
  await outbox.drainCloudflareReplicaOutbox(execute, context.bindings, { nowMs: 2_000 });

  const key = `private/progress/ielts-prep-v1/${USER.id}/${"a".repeat(64)}.json`;
  await outbox.enqueueCloudflareObjectCleanup(context.bindings, key, USER.id, 1_000);
  context.bindings.files.delete = async () => { throw new Error("Network connection lost"); };
  for (let attempt = 1; attempt <= outbox.CLOUDFLARE_REPLICA_MAX_ATTEMPTS; attempt += 1) {
    await outbox.drainCloudflareReplicaObjectCleanup(context.bindings, {
      nowMs: attempt * 10_000_000,
    });
  }

  const status = await outbox.cloudflareReplicaOutboxStatus(context.bindings, 200_000_000);
  assert.deepEqual(status.failures.map((group) => [group.code, group.status, group.count]), [
    ["object_missing", "pending", 1],
  ]);
  assert.deepEqual(status.failures[0].detail, ["ai_cost_event"]);
  assert.equal(status.failures[0].maxAttempts, 1);
  assert.equal(status.failures[0].oldestAgeSeconds, 199_998);

  assert.deepEqual(status.cleanupFailures.map((group) => [group.code, group.status, group.count]), [
    ["transient", "dead", 1],
  ]);
  // The owner id and the content hash are not operational evidence.
  assert.deepEqual(status.cleanupFailures[0].detail, ["private/progress/ielts-prep-v1"]);
  assert.equal(status.cleanupFailures[0].detail.join("").includes(USER.id), false);
  assert.equal(status.cleanupFailures[0].maxAttempts, 12);
});

test("an outbox row frozen by an account-deletion tombstone is counted rather than skipped in silence", async () => {
  const context = fixture();
  const item = task("2026-08-14T10:00:00.000Z", { value: "frozen" });
  await outbox.enqueueCloudflareReplicaTask(item, context.bindings, 1_000);
  context.database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, ?, 'prepared', ?, ?, ?)
  `).run(
    USER.id,
    "op-000000000000001",
    "2026-08-14T10:00:00.000Z",
    "2026-08-14T11:00:00.000Z",
    "2026-08-14T10:00:00.000Z",
  );

  const drained = await outbox.drainCloudflareReplicaOutbox(
    async () => true,
    context.bindings,
    { nowMs: 2_000 },
  );
  /*
    The deletion guard aborts the lease UPDATE, so the row cannot be attempted,
    records no reason and never dies. It used to be *selected* on every pass
    all the same — filling a slot in a page of two, failing silently, and
    keeping whatever was behind it from ever being reached. It is now left out
    of selection and counted instead, which is the only evidence there is.
  */
  assert.equal(drained.selected, 0);
  assert.equal(drained.succeeded, 0);
  assert.equal(drained.failed, 0);
  const status = await outbox.cloudflareReplicaOutboxStatus(context.bindings, 3_000);
  assert.equal(status.pending, 1);
  assert.equal(status.blockedByAccountDeletion, 1);
  assert.equal(status.oldestRetryablePendingAt, null);
  assert.deepEqual(status.failures, []);
});

test("the readiness report and its admin panel name the reason, not only the count", () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const readiness = strip(readFileSync(
    join(process.cwd(), "lib/cloudflare/migration-readiness.ts"),
    "utf8",
  ));
  const panel = strip(readFileSync(
    join(process.cwd(), "components/admin/CloudflareMigrationReadiness.tsx"),
    "utf8",
  ));
  assert.match(readiness, /outboxResult\.failures/);
  assert.match(readiness, /outboxResult\.cleanupFailures/);
  assert.match(readiness, /blockedByAccountDeletion/);
  assert.match(panel, /Why the replica queues are stuck/);
  assert.match(panel, /cleanupFailures/);
  assert.match(panel, /blockedByAccountDeletion/);
});
