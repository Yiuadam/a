/*
  The queue is drained by a schedule, not only by whoever happens to be writing.

  Between 14 and 16 August 2026 nothing drained the Cloudflare replica outbox.
  Every drain the app had was hung off a learner's own write, two rows at a
  time, and two of the three call sites filtered to that learner's own user id
  — so a row belonging to somebody who had stopped using BandUp was not retried
  slowly, it was never retried at all. These tests hold the three things that
  fixes: a scheduled drain with a page size worth having, rows that can never
  be leased staying out of that page, and a receipt that makes a schedule which
  has stopped firing visible from outside the Worker.
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
const outbox = await load("lib", "cloudflare", "replica-outbox.ts");
const scheduled = await load("lib", "cloudflare", "scheduled-replica-drain.ts");
const health = await load("lib", "cloudflare", "replica-health.ts");
const ticket = await load("lib", "cloudflare", "scheduled-drain-ticket.ts");

/* A test that asserts on source text must not be satisfied by a comment
   quoting the code it is looking for. One has passed that way here before. */
const strip = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

function runtimeD1(database) {
  const execute = ({ sql, values }) => {
    const result = database.prepare(sql).run(...values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
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
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(read("cloudflare", "migrations", file));
  }
  const objects = new Map();
  const files = {
    async put(key, value) {
      objects.set(key, typeof value === "string" ? value : String(value));
      return { key };
    },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { async arrayBuffer() { return new TextEncoder().encode(value).buffer; } };
    },
    async delete(key) { objects.delete(key); },
  };
  return { database, objects, bindings: { db: runtimeD1(database), files } };
}

const USER = "50000000-0000-4000-8000-000000000123";
const OTHER = "50000000-0000-4000-8000-000000000456";

function task(index, subjectUserId = USER) {
  return {
    taskId: `usage:${index}`,
    operation: "usage_event",
    subjectUserId,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: index },
  };
}

function tombstone(database, userId) {
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, ?, 'prepared', ?, ?, ?)
  `).run(
    userId,
    `operation-${userId}`,
    "2026-08-14T10:00:00.000Z",
    "2026-08-14T11:00:00.000Z",
    "2026-08-14T10:00:00.000Z",
  );
}

test("one scheduled run clears a backlog the two-row request path never would", async () => {
  const context = fixture();
  for (let index = 0; index < 20; index += 1) {
    await outbox.enqueueCloudflareReplicaTask(task(index), context.bindings, 1_000);
  }
  const seen = [];
  const run = await scheduled.runScheduledReplicaDrain(context.bindings, {
    nowMs: 2_000,
    execute: async (item) => { seen.push(item.taskId); return true; },
  });

  // The whole point: 20 in a single pass, where the request-path drain takes
  // two and only for the learner who happens to be writing at the time.
  assert.equal(seen.length, 20);
  assert.equal(run.outbox.succeeded, 20);
  assert.equal(run.status.pending, 0);
  assert.ok(scheduled.SCHEDULED_REPLICA_OUTBOX_BATCH >= 20);
  const left = context.database.prepare(
    "SELECT count(*) AS rows FROM cloudflare_replica_outbox",
  ).get();
  assert.equal(left.rows, 0);
});

test("every run leaves a receipt, so a schedule that stopped firing is visible", async () => {
  const context = fixture();
  const run = await scheduled.runScheduledReplicaDrain(context.bindings, {
    nowMs: Date.parse("2026-08-16T16:00:00.000Z"),
    execute: async () => true,
  });
  assert.equal(run.ranAt, "2026-08-16T16:00:00.000Z");

  const marker = await scheduled.lastScheduledReplicaDrain(context.bindings);
  assert.equal(marker.ranAt, "2026-08-16T16:00:00.000Z");
  assert.equal(marker.pending, 0);
  // The receipt is operational evidence, not a copy of the queue's contents.
  const raw = context.objects.get(scheduled.REPLICA_DRAIN_MARKER_KEY);
  assert.equal(raw.includes(USER), false);
  assert.equal(raw.includes("payload"), false);
  // Outside every per-user prefix, so account deletion's object sweep and the
  // pointer-safe cleanup queue both leave it alone.
  assert.equal(scheduled.REPLICA_DRAIN_MARKER_KEY.startsWith("private/ops/"), true);

  const unreadable = fixture();
  await unreadable.bindings.files.put(scheduled.REPLICA_DRAIN_MARKER_KEY, "{ half-writ");
  assert.equal(await scheduled.lastScheduledReplicaDrain(unreadable.bindings), null);
});

test("a row the deletion guard has frozen does not eat the drain's budget", async () => {
  const context = fixture();
  await outbox.enqueueCloudflareReplicaTask(task(1, OTHER), context.bindings, 1_000);
  tombstone(context.database, OTHER);
  await outbox.enqueueCloudflareReplicaTask(task(2, USER), context.bindings, 1_100);

  // A page of one, which is what the frozen row used to consume every pass:
  // selected, lease aborted by the guard, nothing attempted, and the healthy
  // row behind it never reached.
  const drained = await outbox.drainCloudflareReplicaOutbox(
    async () => true,
    context.bindings,
    { limit: 1, nowMs: 2_000 },
  );
  assert.equal(drained.selected, 1);
  assert.equal(drained.succeeded, 1);

  const remaining = context.database.prepare(
    "SELECT task_id FROM cloudflare_replica_outbox",
  ).all();
  assert.deepEqual(remaining.map((row) => row.task_id), ["usage:1"]);

  // Still counted, still named: excluded from selection is not hidden.
  const status = await outbox.cloudflareReplicaOutboxStatus(context.bindings, 3_000);
  assert.equal(status.pending, 1);
  assert.equal(status.blockedByAccountDeletion, 1);
  // And it cannot hold the health alarm red for ever, because it is not a row
  // any drain could ever have cleared.
  assert.equal(status.oldestPendingAt !== null, true);
  assert.equal(status.oldestRetryablePendingAt, null);
});

test("health is red when the drain stops and when the backlog stops clearing", () => {
  const now = Date.parse("2026-08-16T16:00:00.000Z");
  const failing = (report) => report.checks.filter((check) => !check.ok).map((c) => c.name);

  const healthy = health.evaluateReplicaHealth({
    lastRunAt: "2026-08-16T15:56:00.000Z",
    oldestRetryablePendingAt: "2026-08-16T15:40:00.000Z",
    nowMs: now,
  });
  assert.equal(healthy.ok, true);

  // The 14-16 August outage, as this endpoint would have reported it.
  const stalled = health.evaluateReplicaHealth({
    lastRunAt: null,
    oldestRetryablePendingAt: "2026-08-15T02:25:23.000Z",
    nowMs: now,
  });
  assert.equal(stalled.ok, false);
  assert.deepEqual(failing(stalled), [
    "replica_drain_ran_recently",
    "replica_backlog_within_bound",
  ]);

  // Firing, but not clearing.
  const stuck = health.evaluateReplicaHealth({
    lastRunAt: "2026-08-16T15:57:00.000Z",
    oldestRetryablePendingAt: "2026-08-16T02:00:00.000Z",
    nowMs: now,
  });
  assert.deepEqual(failing(stuck), ["replica_backlog_within_bound"]);

  // An empty queue has no oldest row, and an empty queue is the healthy case.
  assert.equal(health.evaluateReplicaHealth({
    lastRunAt: "2026-08-16T15:57:00.000Z",
    oldestRetryablePendingAt: null,
    nowMs: now,
  }).ok, true);

  // Counts, depths and reasons stay behind the admin session.
  for (const report of [healthy, stalled, stuck]) {
    for (const check of report.checks) {
      assert.deepEqual(Object.keys(check).sort(), ["name", "ok"]);
    }
  }
});

test("the scheduled drain route is reachable by the cron handler and by nobody else", () => {
  const store = globalThis.__bandupScheduledDrainTickets;
  delete globalThis.__bandupScheduledDrainTickets;
  try {
    const value = `${"a".repeat(36)}${"b".repeat(36)}`;
    // Between runs there is no valid ticket at all, so there is nothing to
    // present and nothing to guess.
    assert.equal(ticket.consumeScheduledDrainTicket(value), false);
    assert.equal(ticket.consumeScheduledDrainTicket(null), false);

    ticket.issueScheduledDrainTicket(value);
    assert.equal(ticket.consumeScheduledDrainTicket("short"), false);
    assert.equal(ticket.consumeScheduledDrainTicket(`${"a".repeat(36)}${"c".repeat(36)}`), false);
    assert.equal(ticket.consumeScheduledDrainTicket(value), true);
    // Single use: a replay of the same value fails.
    assert.equal(ticket.consumeScheduledDrainTicket(value), false);

    ticket.issueScheduledDrainTicket(value);
    ticket.revokeScheduledDrainTicket(value);
    assert.equal(ticket.consumeScheduledDrainTicket(value), false);

    // A value too short to be unguessable is not a ticket.
    ticket.issueScheduledDrainTicket("tiny");
    assert.equal(ticket.consumeScheduledDrainTicket("tiny"), false);
  } finally {
    if (store === undefined) delete globalThis.__bandupScheduledDrainTickets;
    else globalThis.__bandupScheduledDrainTickets = store;
  }
});

test("the cron trigger, the Worker entry and the drain route are actually wired together", () => {
  const config = JSON.parse(
    read("wrangler.jsonc")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"])\/\/.*$/gm, "$1"),
  );
  assert.deepEqual(
    config.triggers?.crons,
    ["*/5 * * * *"],
    "without a cron trigger nothing drains the replica queue in the background, " +
      "which is the whole of the 14-16 August outage",
  );
  assert.equal(
    config.main,
    "cloudflare/worker-entry.mjs",
    "OpenNext's generated worker exports only `fetch`; pointing main back at it " +
      "removes the scheduled handler and the cron above fires into nothing",
  );

  const entry = strip(read("cloudflare", "worker-entry.mjs"));
  assert.match(entry, /async scheduled\(/);
  assert.match(entry, /\.open-next\/worker\.js/);
  assert.match(entry, /\/api\/internal\/replica-drain/);
  assert.match(entry, /x-bandup-scheduled-drain/);
  // A cron invocation that swallows a failure is indistinguishable from one
  // with nothing to do — which is the failure mode being removed.
  assert.match(entry, /throw new Error/);

  const route = strip(read("app", "api", "internal", "replica-drain", "route.ts"));
  assert.match(route, /consumeScheduledDrainTicket/);
  assert.match(route, /return notFound\(\)/);
  assert.match(route, /runScheduledReplicaDrain/);
  // Threat 7: never the provider's own words.
  assert.match(route, /logInternal/);
  assert.equal(/error instanceof Error \? error\.message/.test(route), false);

  const healthRoute = strip(read("app", "api", "replica", "health", "route.ts"));
  assert.match(healthRoute, /cloudflareReplicaHealth/);
  assert.match(healthRoute, /no-store/);

  const workflow = read(".github", "workflows", "replica-health.yml");
  assert.match(workflow, /https:\/\/bandup\.life\/api\/replica\/health/);
  assert.match(workflow, /cron: "41 \* \* \* \*"/);
  // The dead workers.dev hostname is gone; see PR #131.
  assert.equal(workflow.includes("workers.dev"), false);
});
