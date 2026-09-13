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
register("./cloudflare-context-stub.mjs", import.meta.url);

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

test("one scheduled run drains exactly its own page, leaving the rest of a bigger backlog pending", async () => {
  /*
    Until the Workers Free plan's 50-subrequest ceiling forced
    SCHEDULED_REPLICA_OUTBOX_BATCH down (see scheduled-replica-drain.ts), this
    test enqueued 20 rows and watched one run clear all of them — the batch
    was comfortably bigger than any backlog this test cared to simulate. It no
    longer is, on purpose, so the interesting behavior now is the other half
    of the same fact: a backlog bigger than one page is not silently dropped,
    it is left pending for the next tick. tests/replica-drain-free-budget.test.mjs
    covers the arithmetic that sizes the page itself.
  */
  const context = fixture();
  const seeded = scheduled.SCHEDULED_REPLICA_OUTBOX_BATCH + 2;
  for (let index = 0; index < seeded; index += 1) {
    await outbox.enqueueCloudflareReplicaTask(task(index), context.bindings, 1_000);
  }
  const seen = [];
  const run = await scheduled.runScheduledReplicaDrain(context.bindings, {
    nowMs: 2_000,
    execute: async (item) => { seen.push(item.taskId); return true; },
  });

  // A scheduled run's page size is its own knob (SCHEDULED_REPLICA_OUTBOX_BATCH),
  // sized for what a Worker invocation can afford — not the fixed two rows a
  // request-path drain takes for whichever learner happens to be writing.
  const expectedDrained = scheduled.SCHEDULED_REPLICA_OUTBOX_BATCH;
  assert.equal(seen.length, expectedDrained);
  assert.equal(run.outbox.succeeded, expectedDrained);
  const remaining = seeded - expectedDrained;
  assert.equal(run.status.pending, remaining);
  const left = context.database.prepare(
    "SELECT count(*) AS rows FROM cloudflare_replica_outbox",
  ).get();
  assert.equal(left.rows, remaining);
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

/*
  ---------------------------------------------------------------------------
  scheduled-drain-ticket.ts: the header name, and the two length gates around
  a one-time-use ticket. The suite above already proves a ticket is single-use
  and that a too-short value never validates; what it does not reach is
  whether the *minimum-length* gate sits on issuing, on presenting, or on
  neither, because every value it tries is either comfortably long or
  comfortably short of 32 characters. The tests below sit exactly on that
  boundary, and directly at the isolate-global state issue writes to, which is
  the only place a ticket that should never have been issued can be seen.
*/

test("SCHEDULED_DRAIN_HEADER is the literal header name the Worker entry and the route both key off", () => {
  assert.equal(ticket.SCHEDULED_DRAIN_HEADER, "x-bandup-scheduled-drain");
});

test("a value shorter than the minimum ticket length is never issued in the first place", () => {
  const store = globalThis.__bandupScheduledDrainTickets;
  delete globalThis.__bandupScheduledDrainTickets;
  try {
    // Force the lazily-created set to exist first, the same way a real
    // deployment's first-ever issued ticket would — otherwise "absent" and
    // "the set itself was never created" look identical.
    ticket.issueScheduledDrainTicket("z".repeat(32));
    const short = "s".repeat(31);
    ticket.issueScheduledDrainTicket(short);
    // consumeScheduledDrainTicket rejects any presented value this short on
    // its own, regardless of what issuing did — so the set itself, which
    // issuing and nothing else writes to, is the only place left to tell
    // "never added" apart from "added, but unpresentable".
    assert.equal(globalThis.__bandupScheduledDrainTickets.has(short), false);
  } finally {
    if (store === undefined) delete globalThis.__bandupScheduledDrainTickets;
    else globalThis.__bandupScheduledDrainTickets = store;
  }
});

test("consuming rejects a short presented value on its own length gate, even if that exact value is already in the set", () => {
  const store = globalThis.__bandupScheduledDrainTickets;
  // Bypasses issueScheduledDrainTicket's own gate entirely, so this is
  // purely a test of consumeScheduledDrainTicket's *separate* gate on the
  // presented value — dropping it would let the search loop below run and
  // find this exact entry.
  globalThis.__bandupScheduledDrainTickets = new Set(["short"]);
  try {
    assert.equal(ticket.consumeScheduledDrainTicket("short"), false);
  } finally {
    if (store === undefined) delete globalThis.__bandupScheduledDrainTickets;
    else globalThis.__bandupScheduledDrainTickets = store;
  }
});

test("the minimum ticket length is a boundary a caller can sit exactly on, not an approximation", () => {
  const store = globalThis.__bandupScheduledDrainTickets;
  delete globalThis.__bandupScheduledDrainTickets;
  try {
    const exact = "e".repeat(32);
    ticket.issueScheduledDrainTicket(exact);
    // A ">" in place of ">=" on either issuing or consuming's own gate would
    // reject this same 32-character value.
    assert.equal(ticket.consumeScheduledDrainTicket(exact), true);
  } finally {
    if (store === undefined) delete globalThis.__bandupScheduledDrainTickets;
    else globalThis.__bandupScheduledDrainTickets = store;
  }
});

test("constant-time comparison never treats a longer, prefix-matching value as the same ticket", () => {
  const store = globalThis.__bandupScheduledDrainTickets;
  delete globalThis.__bandupScheduledDrainTickets;
  try {
    const real = "p".repeat(32);
    ticket.issueScheduledDrainTicket(real);
    // Every one of the real ticket's 32 characters is also the first 32 of
    // this presented value — a comparison that dropped the length check and
    // only walked the shorter string would call that a match.
    assert.equal(ticket.consumeScheduledDrainTicket(`${real}${"x".repeat(8)}`), false);
    // The rejected attempt above must not have spent the real ticket.
    assert.equal(ticket.consumeScheduledDrainTicket(real), true);
  } finally {
    if (store === undefined) delete globalThis.__bandupScheduledDrainTickets;
    else globalThis.__bandupScheduledDrainTickets = store;
  }
});

test("constant-time comparison never calls a length mismatch an outright match", () => {
  const store = globalThis.__bandupScheduledDrainTickets;
  delete globalThis.__bandupScheduledDrainTickets;
  try {
    ticket.issueScheduledDrainTicket("q".repeat(32));
    // Different length and different content: a comparison that short-
    // circuited a length mismatch straight to "equal" would call this a hit.
    assert.equal(ticket.consumeScheduledDrainTicket("z".repeat(40)), false);
  } finally {
    if (store === undefined) delete globalThis.__bandupScheduledDrainTickets;
    else globalThis.__bandupScheduledDrainTickets = store;
  }
});

/*
  ---------------------------------------------------------------------------
  replica-health.ts: the two staleness boundaries, "every" rather than "some",
  and the three async branches (supabase/no-bindings/no-status) of
  cloudflareReplicaHealth itself. evaluateReplicaHealth's own pure-function
  tests above never sit exactly on either threshold and never mix a passing
  check with a failing one while asserting the *overall* verdict; the async
  wrapper's non-happy branches have no test at all yet, because they need a
  Cloudflare context to intercept, which nothing above this point sets up.
*/

test("the drain-staleness check is a boundary at exactly thirty minutes, not an approximation", () => {
  const nowMs = 2_000_000_000_000;
  const DRAIN_STALE_MS = 30 * 60 * 1000;
  const atBoundary = health.evaluateReplicaHealth({
    lastRunAt: new Date(nowMs - DRAIN_STALE_MS).toISOString(),
    oldestRetryablePendingAt: null,
    nowMs,
  });
  assert.equal(
    atBoundary.checks.find((c) => c.name === "replica_drain_ran_recently").ok,
    true,
  );

  const pastBoundary = health.evaluateReplicaHealth({
    lastRunAt: new Date(nowMs - DRAIN_STALE_MS - 1).toISOString(),
    oldestRetryablePendingAt: null,
    nowMs,
  });
  assert.equal(
    pastBoundary.checks.find((c) => c.name === "replica_drain_ran_recently").ok,
    false,
  );
});

test("the backlog-staleness check is a boundary at exactly six hours, not an approximation", () => {
  const nowMs = 2_000_000_000_000;
  const BACKLOG_STALE_MS = 6 * 60 * 60 * 1000;
  const atBoundary = health.evaluateReplicaHealth({
    lastRunAt: new Date(nowMs).toISOString(),
    oldestRetryablePendingAt: new Date(nowMs - BACKLOG_STALE_MS).toISOString(),
    nowMs,
  });
  assert.equal(
    atBoundary.checks.find((c) => c.name === "replica_backlog_within_bound").ok,
    true,
  );

  const pastBoundary = health.evaluateReplicaHealth({
    lastRunAt: new Date(nowMs).toISOString(),
    oldestRetryablePendingAt: new Date(nowMs - BACKLOG_STALE_MS - 1).toISOString(),
    nowMs,
  });
  assert.equal(
    pastBoundary.checks.find((c) => c.name === "replica_backlog_within_bound").ok,
    false,
  );
});

test("overall health requires every check to pass, not merely one of them", () => {
  const nowMs = 2_000_000_000_000;
  const mixed = health.evaluateReplicaHealth({
    lastRunAt: new Date(nowMs).toISOString(),
    oldestRetryablePendingAt: new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
    nowMs,
  });
  assert.equal(mixed.checks.find((c) => c.name === "replica_drain_ran_recently").ok, true);
  assert.equal(mixed.checks.find((c) => c.name === "replica_backlog_within_bound").ok, false);
  assert.equal(mixed.ok, false);
});

test("cloudflareReplicaHealth reports the mirror inactive, verbatim, whenever learner data mode is supabase", async () => {
  const previous = process.env.CLOUDFLARE_DATA_MODE;
  process.env.CLOUDFLARE_DATA_MODE = "supabase";
  try {
    assert.deepEqual(await health.cloudflareReplicaHealth(1_000), {
      ok: true,
      checks: [{ name: "replica_mirror_inactive", ok: true }],
    });
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = previous;
  }
});

test("cloudflareReplicaHealth reports bindings unavailable, verbatim, when the Worker has none to give", async () => {
  const previousMode = process.env.CLOUDFLARE_DATA_MODE;
  const previousContext = globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  process.env.CLOUDFLARE_DATA_MODE = "dual";
  delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  try {
    assert.deepEqual(await health.cloudflareReplicaHealth(1_000), {
      ok: false,
      checks: [{ name: "replica_bindings_available", ok: false }],
    });
  } finally {
    if (previousMode === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = previousMode;
    if (previousContext === undefined) delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    else globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = previousContext;
  }
});

test("cloudflareReplicaHealth reports the status query unreadable, verbatim, rather than throwing", async () => {
  const previousMode = process.env.CLOUDFLARE_DATA_MODE;
  const previousContext = globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  process.env.CLOUDFLARE_DATA_MODE = "dual";
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = {
    env: {
      BANDUP_DB: { prepare() { throw new Error("no D1 in this test"); } },
      BANDUP_FILES: { async get() { return null; } },
    },
  };
  try {
    assert.deepEqual(await health.cloudflareReplicaHealth(1_000), {
      ok: false,
      checks: [{ name: "replica_status_readable", ok: false }],
    });
  } finally {
    if (previousMode === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = previousMode;
    if (previousContext === undefined) delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    else globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = previousContext;
  }
});

/*
  ---------------------------------------------------------------------------
  scheduled-replica-drain.ts: the cleanup pass's own page size, the exact
  options the drain receipt is written with, and the marker reader's
  reaction to a receipt that parses as JSON but does not parse as a receipt.
  The first test above in this file proves the *outbox* phase is bounded by
  its own constant; nothing yet seeds the separate cleanup queue to prove the
  same of that phase, and nothing inspects what runScheduledReplicaDrain
  actually hands R2 rather than merely that it calls put().
*/

test("a scheduled run's cleanup pass is bounded by SCHEDULED_REPLICA_CLEANUP_BATCH, not the cleanup drain's own default", async () => {
  const context = fixture();
  /*
    runScheduledReplicaDrain's outbox phase makes its own small opportunistic
    cleanup pass first (drainCloudflareReplicaOutbox's own
    OUTBOX_DRAIN_CLEANUP_LIMIT, from replica-outbox.ts), before the explicit
    cleanup call this test targets ever runs. Both counts are real, so the
    total this run removes is their sum.
  */
  const perRunLimit = scheduled.SCHEDULED_REPLICA_CLEANUP_BATCH + outbox.OUTBOX_DRAIN_CLEANUP_LIMIT;
  const seeded = perRunLimit + 2;
  const stamp = "2020-01-01T00:00:00.000Z";
  for (let index = 0; index < seeded; index += 1) {
    context.database.prepare(`
      INSERT INTO cloudflare_replica_object_cleanup (
        object_key, attempts_made, status, available_at, created_at, updated_at
      ) VALUES (?, 0, 'pending', ?, ?, ?)
    `).run(`private/cleanup-mutation-test/${index}`, stamp, stamp, stamp);
  }
  await scheduled.runScheduledReplicaDrain(context.bindings, {
    nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
    execute: async () => true,
  });
  const left = context.database.prepare(
    "SELECT count(*) AS rows FROM cloudflare_replica_object_cleanup",
  ).get();
  // If the explicit call's options object were dropped to {}, its default
  // limit of 8 would clear this whole (comfortably-under-8) backlog instead
  // of leaving two rows behind.
  assert.equal(left.rows, seeded - perRunLimit);
});

test("the drain receipt is written with an explicit JSON content type, not R2's default", async () => {
  const context = fixture();
  const puts = [];
  const originalPut = context.bindings.files.put.bind(context.bindings.files);
  context.bindings.files.put = async (key, value, options) => {
    puts.push({ key, options });
    return originalPut(key, value, options);
  };
  await scheduled.runScheduledReplicaDrain(context.bindings, {
    nowMs: Date.parse("2026-08-16T16:00:00.000Z"),
    execute: async () => true,
  });
  const markerPut = puts.find((p) => p.key === scheduled.REPLICA_DRAIN_MARKER_KEY);
  assert.deepEqual(markerPut.options, { httpMetadata: { contentType: "application/json" } });
});

test("a receipt that parses as JSON but carries an unparseable ranAt is the same fact as no receipt", async () => {
  const context = fixture();
  await context.bindings.files.put(
    scheduled.REPLICA_DRAIN_MARKER_KEY,
    JSON.stringify({ ranAt: "not-a-real-timestamp" }),
  );
  assert.equal(await scheduled.lastScheduledReplicaDrain(context.bindings), null);

  const numeric = fixture();
  await numeric.bindings.files.put(
    scheduled.REPLICA_DRAIN_MARKER_KEY,
    JSON.stringify({ ranAt: 12345 }),
  );
  assert.equal(await scheduled.lastScheduledReplicaDrain(numeric.bindings), null);
});
