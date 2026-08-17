/*
  Proof that the cutover write barrier is a barrier, not a table nobody reads.

  Every test below does the same two things, in this order: call a real write
  helper with no barrier armed and show a Supabase request went out; arm a
  barrier for "learner" against a real (in-memory) D1 and call the exact same
  helper again, and show two things at once — the refusal value the function's
  own callers already know how to handle, and that the request count to the
  fake Supabase server did not move. A barrier that merely returns a different
  value while a request still goes out has not closed anything.

  ---------------------------------------------------------------------------
  How Supabase and Cloudflare are both faked here

  `globalThis.fetch` is replaced for the whole file, so every one of
  lib/auth/supabase.ts's HTTP calls lands on a counter instead of a network.
  That is the same technique tests/session-auth-outage.test.mjs already uses.

  D1 has no such seam in this codebase's own functions — every Cloudflare
  reader/writer takes a `BandUpCloudflareBindings` it is handed, except the one
  place that matters here: lib/auth/supabase.ts's write helpers have no
  Cloudflare binding parameter at all, by design (this file is deliberately
  Supabase-only), so the barrier check inside them resolves its own binding
  through `bandUpCloudflareBindings()`, which asks
  `@opennextjs/cloudflare`'s `getCloudflareContext()` — a real Workers API this
  process is not running inside. tests/cutover-write-barrier-resolve.mjs
  redirects that one import to tests/fake-cloudflare-worker.mjs, which answers
  from `globalThis.__CUTOVER_FAKE_CF_ENV__` — set below to the same in-memory
  D1 every other assertion in this file inspects directly.
*/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./cutover-write-barrier-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const writeBarrier = await load("lib", "cloudflare", "write-barrier.ts");
const supabase = await load("lib", "auth", "supabase.ts");
const guard = await load("lib", "usage", "guard.ts");
const costTracking = await load("lib", "ai", "cost-tracking.ts");
const subscriptions = await load("lib", "billing", "subscriptions.ts");
const adminSettings = await load("lib", "admin", "settings.ts");
const outbox = await load("lib", "cloudflare", "replica-outbox.ts");

/* The same D1-over-SQLite adapter tests/cloudflare-dual-replica-outbox.test.mjs
   uses, batch() included — armCutoverWriteBarrier needs it. */
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

/*
  scripts/hand-run-cutover-write-barrier.sql is deliberately not a numbered
  migration — see that file's header — so it is applied here explicitly,
  after the real ledger, exactly as the owner will run it by hand against a
  real D1.
*/
function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  database.exec(readFileSync(join(process.cwd(), "scripts", "hand-run-cutover-write-barrier.sql"), "utf8"));
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

/**
 * The state every real environment starts in and may stay in for however
 * long the owner takes to run scripts/hand-run-cutover-write-barrier.sql:
 * the numbered migration ledger applied, that file not yet run, so
 * `cutover_write_barriers` does not exist at all.
 */
function fixtureWithoutBarrierTable() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

const SUPABASE_CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

/** Counts requests and remembers their URLs; answers every one with `{}`/200. */
function fetchCounter() {
  const calls = [];
  const fn = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fn, calls };
}

async function armLearnerBarrier(bindings) {
  const result = await writeBarrier.armCutoverWriteBarrier(
    "learner",
    "dual",
    "owner@example.test",
    bindings,
  );
  assert.equal(result.ok, true, `arming failed: ${JSON.stringify(result)}`);
  return result.record;
}

const USER_ID = "50000000-0000-4000-8000-000000000090";

test("the barrier itself: not armed by default, armed once, one-way, drain-gated", async () => {
  const { bindings } = fixture();

  assert.equal(await writeBarrier.cutoverWriteBarrierArmed("learner", bindings), false);
  assert.equal(
    (await writeBarrier.cutoverWriteBarrierReadiness(bindings, "learner")).status,
    "not_armed",
  );

  const record = await armLearnerBarrier(bindings);
  assert.equal(record.domain, "learner");
  assert.equal(record.toAuthority, "cloudflare");
  assert.equal(record.fromAuthority, "dual");
  assert.equal(record.recordedBy, "owner@example.test");
  assert.equal(await writeBarrier.cutoverWriteBarrierArmed("learner", bindings), true);
  assert.equal(
    (await writeBarrier.cutoverWriteBarrierReadiness(bindings, "learner")).status,
    "armed",
  );
  // "organization" is a separate domain and stays unarmed.
  assert.equal(await writeBarrier.cutoverWriteBarrierArmed("organization", bindings), false);

  // The audit trail requirement 1 asks for: one 'cutover'-mode run recorded
  // alongside the barrier, fulfilling data_migration_runs.mode's anticipated
  // value from 0001 for the first time.
  const runs = await bindings.db.prepare(
    "SELECT mode, status FROM data_migration_runs WHERE mode = 'cutover'",
  ).all();
  assert.equal(runs.results.length, 1);
  assert.equal(runs.results[0].status, "complete");

  // Re-arming the same domain refuses rather than silently succeeding again.
  const second = await writeBarrier.armCutoverWriteBarrier("learner", "dual", "owner@example.test", bindings);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_armed");
});

test("the barrier degrades to \"not armed\" when its own table does not exist yet, everywhere that reads it", async () => {
  /*
    scripts/hand-run-cutover-write-barrier.sql is deliberately not a numbered
    migration, so shipping this code and running that SQL are two separate
    events, in that order, with a gap between them of unknown length in every
    real environment. This is the state on the near side of that gap: the
    numbered ledger applied, cutover_write_barriers not created at all.

    Nothing here may throw "no such table" — not a direct read, not the
    readiness report, and not drainCloudflareReplicaOutbox(), which used to
    embed the same table in its own SELECT and would otherwise fail closed on
    every single call until the owner ran the SQL, breaking the very drain
    this whole barrier exists to keep safe.
  */
  const { database, bindings } = fixtureWithoutBarrierTable();
  const hasTable = () => database.prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE name = 'cutover_write_barriers'",
  ).get().n;
  assert.equal(hasTable(), 0);

  assert.equal(await writeBarrier.cutoverWriteBarrierArmed("learner", bindings), false);
  assert.equal(await writeBarrier.cutoverWriteBarrierArmed("organization", bindings), false);
  const readiness = await writeBarrier.cutoverWriteBarrierReadiness(bindings, "learner");
  assert.equal(readiness.status, "not_armed");
  assert.equal(readiness.barrierAt, null);

  const stamp = "2026-08-15T00:00:00.000Z";
  database.prepare(`
    INSERT INTO cloudflare_replica_outbox (
      task_id, operation, subject_user_id, source_updated_at, payload_inline,
      payload_sha256, payload_bytes, generation, attempts_made, status,
      available_at, created_at, updated_at
    ) VALUES ('task-no-barrier-table', 'learner_profile', ?, ?, '{}', ?, 2, 1, 0, 'pending', ?, ?, ?)
  `).run(USER_ID, stamp, createHash("sha256").update("{}").digest("hex"), stamp, stamp, stamp);

  let executed = 0;
  const result = await outbox.drainCloudflareReplicaOutbox(
    async () => { executed += 1; return true; },
    bindings,
  );
  assert.equal(result.selected, 1, "the drain must still find and process the row, table or no table");
  assert.equal(executed, 1);
  assert.equal(result.succeeded, 1);
  const remaining = await database.prepare(
    "SELECT count(*) AS n FROM cloudflare_replica_outbox WHERE task_id = 'task-no-barrier-table'",
  ).get();
  assert.equal(remaining.n, 0);
});

test("a barrier row is one-way at the database layer, not only through this module's API", () => {
  const { database } = fixture();
  const stamp = "2026-08-15T00:00:00.000Z";
  database.prepare(`
    INSERT INTO cutover_write_barriers (domain, from_authority, to_authority, barrier_at, recorded_by, status)
    VALUES ('learner', 'dual', 'cloudflare', ?, 'owner@example.test', 'armed')
  `).run(stamp);
  assert.throws(
    () => database.prepare("UPDATE cutover_write_barriers SET recorded_by = 'someone-else' WHERE domain = 'learner'").run(),
    /cannot be edited once armed/,
  );
  assert.throws(
    () => database.prepare("DELETE FROM cutover_write_barriers WHERE domain = 'learner'").run(),
    /cannot be removed once armed/,
  );
});

test("arming refuses while the replica outbox has undrained rows, and the trigger — not just the pre-check — enforces it", async () => {
  const { database, bindings } = fixture();
  const stamp = "2026-08-15T00:00:00.000Z";
  database.prepare(`
    INSERT INTO cloudflare_replica_outbox (
      task_id, operation, subject_user_id, source_updated_at,
      payload_inline, payload_sha256, payload_bytes, generation, attempts_made,
      status, available_at, created_at, updated_at
    ) VALUES ('task-1', 'learner_profile', ?, ?, '{}', ?, 2, 1, 0, 'pending', ?, ?, ?)
  `).run(
    USER_ID, stamp,
    "0".repeat(64),
    stamp, stamp, stamp,
  );

  const result = await writeBarrier.armCutoverWriteBarrier("learner", "dual", "owner@example.test", bindings);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outbox_not_drained");
  assert.match(result.detail, /1 pending/);
  assert.equal(await writeBarrier.cutoverWriteBarrierArmed("learner", bindings), false);

  // Bypassing the module's own pre-check — inserting straight through D1, the
  // way a bug in a future caller might — still gets refused. This is what
  // proves the drain rule lives in the migration's trigger, not only in
  // TypeScript that a future edit could accidentally skip.
  assert.throws(() => database.prepare(`
    INSERT INTO cutover_write_barriers (domain, from_authority, to_authority, barrier_at, recorded_by, status)
    VALUES ('learner', 'dual', 'cloudflare', ?, 'owner@example.test', 'armed')
  `).run(stamp), /drained/);

  database.prepare("DELETE FROM cloudflare_replica_outbox WHERE task_id = 'task-1'").run();
  const retried = await writeBarrier.armCutoverWriteBarrier("learner", "dual", "owner@example.test", bindings);
  assert.equal(retried.ok, true);
});

test("drainCloudflareReplicaOutbox refuses a barred domain's rows rather than replaying a pre-barrier clock", async () => {
  const { database, bindings } = fixture();
  const stamp = "2026-08-15T00:00:00.000Z";

  // Armed while the outbox was empty, as the drain rule requires.
  database.prepare(`
    INSERT INTO cutover_write_barriers (domain, from_authority, to_authority, barrier_at, recorded_by, status)
    VALUES ('learner', 'dual', 'cloudflare', ?, 'owner@example.test', 'armed')
  `).run(stamp);

  /*
    A row appears afterwards anyway — not through the guarded writers this
    file already proved refuse (they never enqueue once they refuse before
    reaching Supabase), but the one path that still can: the owner explicitly
    requeuing a dead letter through the admin route. Inserted directly here
    because that is exactly what requeueDeadCloudflareReplicaTasks does — an
    UPDATE back to 'pending' on an existing row, not a fresh enqueue subject
    to the drain-rule trigger.
  */
  database.prepare(`
    INSERT INTO cloudflare_replica_outbox (
      task_id, operation, subject_user_id, source_updated_at,
      payload_inline, payload_sha256, payload_bytes, generation, attempts_made,
      status, available_at, created_at, updated_at
    ) VALUES ('task-2', 'learner_profile', ?, ?, '{}', ?, 2, 1, 0, 'pending', ?, ?, ?)
  `).run(USER_ID, stamp, "0".repeat(64), stamp, stamp, stamp);

  let executed = 0;
  const result = await outbox.drainCloudflareReplicaOutbox(async () => { executed += 1; return true; }, bindings);
  assert.equal(result.selected, 0);
  assert.equal(executed, 0);
  const stillPending = await database.prepare(
    "SELECT status FROM cloudflare_replica_outbox WHERE task_id = 'task-2'",
  ).get();
  assert.equal(stillPending.status, "pending");
});

test("lib/auth/supabase.ts: every guarded writer refuses once armed, and none of them reach Supabase", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fetchCounter();
    globalThis.fetch = fn;
    const savedFetch = fn;
    try {
      const { bindings } = fixture();
      globalThis.__CUTOVER_FAKE_CF_ENV__ = { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files };

      // Not armed: each call reaches the fake Supabase.
      calls.length = 0;
      await supabase.updateProfile(USER_ID, { displayName: "Ada" });
      assert.ok(calls.some((c) => c.url.includes("/rest/v1/profiles")), "updateProfile should have called Supabase");

      calls.length = 0;
      await supabase.setAccountIdentity(USER_ID, "Ada", "ada", "individual", null).catch(() => {});
      assert.ok(calls.some((c) => c.url.includes("/rpc/set_account_identity")));

      calls.length = 0;
      await supabase.claimUsername(USER_ID, "ada").catch(() => {});
      assert.ok(calls.some((c) => c.url.includes("/rpc/claim_username")));

      calls.length = 0;
      await supabase.insertPromoSubscription(USER_ID);
      assert.ok(calls.some((c) => c.url.includes("/rest/v1/subscriptions")));

      calls.length = 0;
      await supabase.uploadAvatar(`${USER_ID}/a.webp`, new ArrayBuffer(4), "image/webp");
      assert.ok(calls.some((c) => c.url.includes("/storage/v1/object/avatars/")));

      calls.length = 0;
      await supabase.deleteAvatar(`${USER_ID}/a.webp`);
      assert.ok(calls.some((c) => c.url.includes("/storage/v1/object/avatars/")));

      calls.length = 0;
      await supabase.compareAndSwapProgressSnapshots(USER_ID, [], []);
      assert.ok(calls.some((c) => c.url.includes("/rpc/compare_and_swap_progress_snapshots")));

      calls.length = 0;
      await supabase.deleteProgressSnapshots(USER_ID, ["ielts-prep-v1"]);
      assert.ok(calls.some((c) => c.url.includes("/rest/v1/progress_snapshots")));

      // Arm it. Every one of the same calls must now refuse without a request.
      await armLearnerBarrier(bindings);

      calls.length = 0;
      assert.equal(await supabase.updateProfile(USER_ID, { displayName: "Ada" }), false);
      assert.equal(calls.length, 0);

      calls.length = 0;
      await assert.rejects(() => supabase.setAccountIdentity(USER_ID, "Ada", "ada", "individual", null));
      assert.equal(calls.length, 0);

      calls.length = 0;
      await assert.rejects(() => supabase.claimUsername(USER_ID, "ada"));
      assert.equal(calls.length, 0);

      calls.length = 0;
      assert.equal(await supabase.insertPromoSubscription(USER_ID), "barred");
      assert.equal(calls.length, 0);

      calls.length = 0;
      assert.equal(await supabase.uploadAvatar(`${USER_ID}/a.webp`, new ArrayBuffer(4), "image/webp"), false);
      assert.equal(calls.length, 0);

      calls.length = 0;
      assert.equal(await supabase.deleteAvatar(`${USER_ID}/a.webp`), false);
      assert.equal(calls.length, 0);

      calls.length = 0;
      assert.deepEqual(await supabase.compareAndSwapProgressSnapshots(USER_ID, [], []), { status: "unavailable" });
      assert.equal(calls.length, 0);

      calls.length = 0;
      assert.equal(await supabase.deleteProgressSnapshots(USER_ID, ["ielts-prep-v1"]), false);
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = savedFetch;
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
      void savedFetch;
    }
  });
});

test("Supabase Auth is exempt: userFromAccessToken and sendMagicLink still call Supabase with the barrier armed", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fetchCounter();
    globalThis.fetch = fn;
    try {
      const { bindings } = fixture();
      globalThis.__CUTOVER_FAKE_CF_ENV__ = { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files };
      await armLearnerBarrier(bindings);

      calls.length = 0;
      await supabase.userFromAccessToken("a-token").catch(() => {});
      assert.ok(calls.some((c) => c.url.includes("/auth/v1/user")), "sign-in identity lookup must not be barred");

      calls.length = 0;
      await supabase.sendMagicLink("learner@example.test", "https://bandup.life/auth/callback");
      assert.ok(calls.some((c) => c.url.includes("/auth/v1/otp")), "account recovery must not be barred");
    } finally {
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
    }
  });
});

test("lib/usage/guard.ts: checkAiUsage refuses with a fixed sentence once armed, and never calls Supabase", async () => {
  await withEnv({ ...SUPABASE_CONFIG, ACCOUNTS_ENABLED: "1" }, async () => {
    const { fn, calls } = fetchCounter();
    globalThis.fetch = fn;
    try {
      const { bindings } = fixture();
      globalThis.__CUTOVER_FAKE_CF_ENV__ = { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files };
      const req = new Request("https://bandup.life/api/chat");

      calls.length = 0;
      await guard.checkAiUsage(req, "chat");
      assert.ok(calls.some((c) => c.url.includes("/rpc/check_and_record_usage")), "unbarred usage check should reach Supabase");

      await armLearnerBarrier(bindings);
      calls.length = 0;
      const response = await guard.checkAiUsage(req, "chat");
      assert.equal(calls.length, 0);
      assert.ok(response instanceof Response);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.match(body.error, /AI tutor is briefly unavailable/);
    } finally {
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
    }
  });
});

test("lib/ai/cost-tracking.ts: recordAnthropicMessageCost and setAiCostCoverage refuse once armed", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fetchCounter();
    globalThis.fetch = fn;
    try {
      const { bindings } = fixture();
      globalThis.__CUTOVER_FAKE_CF_ENV__ = { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files };

      calls.length = 0;
      await costTracking.recordAnthropicMessageCost({
        providerRequestId: "req-1",
        route: "chat",
        model: "claude-haiku-4-5-20250101",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      assert.ok(calls.some((c) => c.url.includes("/rpc/record_ai_cost_event")));

      await armLearnerBarrier(bindings);

      calls.length = 0;
      assert.equal(await costTracking.recordAnthropicMessageCost({
        providerRequestId: "req-2",
        route: "chat",
        model: "claude-haiku-4-5-20250101",
        usage: { input_tokens: 10, output_tokens: 5 },
      }), false);
      assert.equal(calls.length, 0);

      calls.length = 0;
      assert.equal(await costTracking.setAiCostCoverage({
        source: "provider_console",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        historicalComplete: true,
      }), false);
      assert.equal(calls.length, 0);
    } finally {
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
    }
  });
});

test("lib/billing/subscriptions.ts: every Stripe applier throws (caught by the webhook route as a fixed 503) once armed", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fetchCounter();
    globalThis.fetch = fn;
    try {
      const { bindings } = fixture();
      globalThis.__CUTOVER_FAKE_CF_ENV__ = { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files };
      await armLearnerBarrier(bindings);

      calls.length = 0;
      await assert.rejects(() => subscriptions.applyStripeSubscription({
        eventId: "evt-1", eventAt: "2026-08-15T00:00:00.000Z", userId: USER_ID,
        status: "active", tier: "plus", customerId: "cus_1", subscriptionId: "sub_1",
        priceId: "price_1", currentPeriodEnd: "2027-08-15T00:00:00.000Z", cancelAtPeriodEnd: false,
      }, {}));
      assert.equal(calls.length, 0);

      calls.length = 0;
      await assert.rejects(() => subscriptions.applyStripePrepaidPurchase({
        eventId: "evt-2", eventAt: "2026-08-15T00:00:00.000Z", userId: USER_ID,
        tier: "plus", planId: "plan_1", customerId: "cus_1", paymentIntentId: "pi_1", interval: "month",
      }, {}));
      assert.equal(calls.length, 0);

      calls.length = 0;
      await assert.rejects(() => subscriptions.applyStripePrepaidRefund({
        eventId: "evt-3", eventAt: "2026-08-15T00:00:00.000Z",
        paymentIntentId: "pi_1", amountMinor: 100, fullRefundConfirmed: true,
      }, {}));
      assert.equal(calls.length, 0);
    } finally {
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
    }
  });
});

test("lib/admin/settings.ts: setMaintenance throws (caught by the admin route as a fixed 503) once armed", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fetchCounter();
    globalThis.fetch = fn;
    try {
      const { bindings } = fixture();
      globalThis.__CUTOVER_FAKE_CF_ENV__ = { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files };

      calls.length = 0;
      await adminSettings.setMaintenance(true, null).catch(() => {});
      assert.ok(calls.some((c) => c.url.includes("/rpc/set_app_setting")));

      await armLearnerBarrier(bindings);
      calls.length = 0;
      await assert.rejects(() => adminSettings.setMaintenance(true, null));
      assert.equal(calls.length, 0);
    } finally {
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
    }
  });
});
