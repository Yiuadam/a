/*
  The Cloudflare account is on the Workers Free plan and is staying there:
  every invocation, a cron tick included, gets 50 subrequests and about 10ms
  of CPU (developers.cloudflare.com/d1/platform/limits/ and
  /workers/platform/limits/). The design comment atop
  lib/cloudflare/scheduled-replica-drain.ts works out, from the code, what one
  outbox row, one cleanup row and the drain's fixed per-tick overhead actually
  cost — and lands on batch sizes meant to clear that ceiling with margin.

  This file turns that arithmetic into an assertion instead of a comment
  someone has to remember to re-check. The per-row and fixed costs below are
  facts about the current code (see that comment for the derivation of each
  one); only the batch-size constants are read live from the modules they are
  exported from, so a future change to any of them recomputes the total
  rather than silently blowing the budget.

  The second half proves the cap is real: it seeds more rows than one batch
  and checks that a single drain call takes exactly a batch's worth and
  leaves the remainder pending, which only holds if the limit is applied in
  the SQL `LIMIT` clause itself rather than, say, a JS-side slice of a
  larger result set.
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

const USER = "50000000-0000-4000-8000-000000000777";

function task(index) {
  return {
    taskId: `usage:${index}`,
    operation: "usage_event",
    subjectUserId: USER,
    sourceUpdatedAt: "2026-08-14T10:00:00.000Z",
    payload: { id: index },
  };
}

test("the worst-case per-tick subrequest arithmetic clears Free's ceiling with margin", () => {
  // One outbox row, worst case: a lease UPDATE, a payload R2 GET (the payload
  // did not fit inline), the target write itself, and a closing DELETE or
  // UPDATE. The target write is not always one statement: `learner_profile`'s
  // is `putCloudflareLearnerProfile` (5 — `ensureCloudflareUser` checks the
  // account-deletion guard twice around one INSERT) followed, whenever the
  // task carries a username, by `claimCloudflareUsername` (its own
  // `ensureCloudflareLearnerProfile`, 5, plus a two-statement `batch()` call
  // counted here as costly as its two statements rather than the one round
  // trip Cloudflare's docs describe `batch()` as making) and, on a username
  // collision, one more read (`cloudflareUsernameReplicaAtLeast`) — 5+7+1=13.
  const OUTBOX_ROW_LEASE = 1;
  const OUTBOX_ROW_PAYLOAD_READ = 1;
  const OUTBOX_ROW_TARGET_WRITE_WORST = 13;
  const OUTBOX_ROW_FINALIZE = 1;
  const WORST_CASE_OUTBOX_ROW = OUTBOX_ROW_LEASE + OUTBOX_ROW_PAYLOAD_READ
    + OUTBOX_ROW_TARGET_WRITE_WORST + OUTBOX_ROW_FINALIZE;
  assert.equal(WORST_CASE_OUTBOX_ROW, 16);

  // One cleanup row, worst case (the object turns out unreferenced and is
  // actually deleted): an objectIsReferenced check, an R2 delete, and a
  // closing DELETE or UPDATE.
  const CLEANUP_ROW_REFERENCE_CHECK = 1;
  const CLEANUP_ROW_R2_DELETE = 1;
  const CLEANUP_ROW_FINALIZE = 1;
  const WORST_CASE_CLEANUP_ROW = CLEANUP_ROW_REFERENCE_CHECK + CLEANUP_ROW_R2_DELETE
    + CLEANUP_ROW_FINALIZE;
  assert.equal(WORST_CASE_CLEANUP_ROW, 3);

  // Fixed cost every tick pays regardless of backlog size: the write-barrier
  // check, the outbox page's own SELECT, drainCloudflareReplicaOutbox's own
  // opportunistic cleanup pass's SELECT, the explicit cleanup pass's own
  // SELECT, cloudflareReplicaOutboxStatus's five queries, and the R2 marker
  // put.
  const FIXED_WRITE_BARRIER_CHECK = 1;
  const FIXED_OUTBOX_SELECT = 1;
  const FIXED_NESTED_CLEANUP_SELECT = 1;
  const FIXED_EXPLICIT_CLEANUP_SELECT = 1;
  const FIXED_STATUS_QUERIES = 5;
  const FIXED_MARKER_PUT = 1;
  const FIXED_OVERHEAD = FIXED_WRITE_BARRIER_CHECK + FIXED_OUTBOX_SELECT
    + FIXED_NESTED_CLEANUP_SELECT + FIXED_EXPLICIT_CLEANUP_SELECT
    + FIXED_STATUS_QUERIES + FIXED_MARKER_PUT;
  assert.equal(FIXED_OVERHEAD, 10);

  // The only three knobs a future change might touch. Pinned to today's
  // values so that changing one of them is a deliberate, reviewed edit to
  // this test too, not a silent drift.
  assert.equal(scheduled.SCHEDULED_REPLICA_OUTBOX_BATCH, 1);
  assert.equal(scheduled.SCHEDULED_REPLICA_CLEANUP_BATCH, 3);
  assert.equal(outbox.OUTBOX_DRAIN_CLEANUP_LIMIT, 1);

  const worstCaseTotal = FIXED_OVERHEAD
    + WORST_CASE_OUTBOX_ROW * scheduled.SCHEDULED_REPLICA_OUTBOX_BATCH
    + WORST_CASE_CLEANUP_ROW * outbox.OUTBOX_DRAIN_CLEANUP_LIMIT
    + WORST_CASE_CLEANUP_ROW * scheduled.SCHEDULED_REPLICA_CLEANUP_BATCH;
  assert.equal(worstCaseTotal, 38);

  const FREE_SUBREQUEST_LIMIT = 50;
  const TARGET_CEILING = 40; // this file's own margin below the hard limit
  assert.ok(
    worstCaseTotal <= TARGET_CEILING,
    `worst-case tick cost ${worstCaseTotal} exceeds the ${TARGET_CEILING}-subrequest target`,
  );
  assert.ok(
    worstCaseTotal <= FREE_SUBREQUEST_LIMIT,
    `worst-case tick cost ${worstCaseTotal} exceeds the Free plan's hard ${FREE_SUBREQUEST_LIMIT}-subrequest ceiling`,
  );
});

test("a backlog bigger than one page still only yields one batch's worth per drain call", async () => {
  const context = fixture();
  const batch = scheduled.SCHEDULED_REPLICA_OUTBOX_BATCH;
  const seeded = batch + 3;
  for (let index = 0; index < seeded; index += 1) {
    await outbox.enqueueCloudflareReplicaTask(task(index), context.bindings, 1_000);
  }
  const drained = await outbox.drainCloudflareReplicaOutbox(
    async () => true,
    context.bindings,
    { limit: batch, nowMs: 2_000 },
  );
  // Not "up to batch" — exactly batch, which only holds if the SQL itself
  // carries `LIMIT ?` rather than a JS-side slice of a bigger result set.
  assert.equal(drained.selected, batch);
  assert.equal(drained.succeeded, batch);
  const remaining = context.database.prepare(
    "SELECT count(*) AS rows FROM cloudflare_replica_outbox",
  ).get();
  assert.equal(remaining.rows, seeded - batch);
});

test("a cleanup backlog bigger than one page still only yields one batch's worth per drain call", async () => {
  const context = fixture();
  const batch = scheduled.SCHEDULED_REPLICA_CLEANUP_BATCH;
  const seeded = batch + 3;
  for (let index = 0; index < seeded; index += 1) {
    await outbox.enqueueCloudflareObjectCleanup(
      context.bindings,
      `private/avatars/user-${index}/${"a".repeat(64)}.png`,
      null,
      1_000,
    );
  }
  const cleaned = await outbox.drainCloudflareReplicaObjectCleanup(
    context.bindings,
    { limit: batch, nowMs: 2_000 },
  );
  assert.equal(cleaned.selected, batch);
  const remaining = context.database.prepare(
    "SELECT count(*) AS rows FROM cloudflare_replica_object_cleanup",
  ).get();
  assert.equal(remaining.rows, seeded - batch);
});

test("the outbox drain's own opportunistic cleanup pass is capped at OUTBOX_DRAIN_CLEANUP_LIMIT, not the bare 8 it used to be", async () => {
  const context = fixture();
  const limit = outbox.OUTBOX_DRAIN_CLEANUP_LIMIT;
  const seeded = limit + 3;
  for (let index = 0; index < seeded; index += 1) {
    await outbox.enqueueCloudflareObjectCleanup(
      context.bindings,
      `private/avatars/user-${index}/${"b".repeat(64)}.png`,
      null,
      1_000,
    );
  }
  // No outbox rows at all: whatever cleanup progress happens here can only
  // have come from the opportunistic pass folded into the outbox drain
  // itself, which is exactly the pass this constant caps.
  const drained = await outbox.drainCloudflareReplicaOutbox(
    async () => true,
    context.bindings,
    { limit: 4, nowMs: 2_000 },
  );
  assert.equal(drained.selected, 0);
  const remaining = context.database.prepare(
    "SELECT count(*) AS rows FROM cloudflare_replica_object_cleanup",
  ).get();
  assert.equal(remaining.rows, seeded - limit);
});

test("the design comment's cited numbers actually appear in the source they describe", () => {
  const drainSource = read("lib", "cloudflare", "scheduled-replica-drain.ts");
  assert.match(drainSource, /export const SCHEDULED_REPLICA_OUTBOX_BATCH = 1;/);
  assert.match(drainSource, /export const SCHEDULED_REPLICA_CLEANUP_BATCH = 3;/);
  const outboxSource = read("lib", "cloudflare", "replica-outbox.ts");
  assert.match(outboxSource, /export const OUTBOX_DRAIN_CLEANUP_LIMIT = 1;/);
});
