/*
  organization-attempt-outbox.ts's own dispatch, arithmetic and D1 logic: the
  coalescing enqueue (watermark handling, the filter that drops attempts a
  history clear already covers, the batch write and its best-effort R2
  retirement) and the bounded drain (lease claim, payload validation, the
  sync call, the delete-then-retire sequence, and the retry backoff a failed
  attempt is rescheduled with). tests/cloudflare-organization-history-
  durability.test.mjs already proves organization-attempt-objects.ts's own
  retirement logic and touches this file only with a source-text regex —
  nothing here calls either exported function and asserts on what it does.

  This file's own SQL (the claim UPDATE, the delete, the retry UPDATE, the
  SELECT join) runs for real against an in-memory D1 built from the real
  migrations — that SQL is this file's own responsibility. Its four cross-
  module calls (ensureCloudflareUser, syncCloudflareOrganizationAttempts,
  reconcile/retireOrganizationAttemptObjects, readStoredJson/storeJson) are
  faked by tests/organization-attempt-outbox-fakes.mjs, the same recorder
  pattern tests/data-router-fakes.mjs uses, so a test can control exactly
  what each answers and inspect exactly what it was called with.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./organization-attempt-outbox-fakes.mjs", import.meta.url);

const outbox = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "organization-attempt-outbox.ts")).href
);

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

const USER_ID = "50000000-0000-4000-8000-000000000201";

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  // ensureCloudflareUser is faked as a no-op by default (its own upsert logic
  // is not this file's concern), so the row its real implementation would
  // have created is seeded directly here — every outbox row's own foreign key
  // needs it to already exist.
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(USER_ID, "learner@example.test", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  const objects = new Map();
  const files = {
    async put(key, value) {
      objects.set(key, typeof value === "string" ? value : "binary");
      return { key };
    },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { async arrayBuffer() { return new TextEncoder().encode(value).buffer; } };
    },
    async delete() {},
  };
  return { database, objects, bindings: { db: runtimeD1(database), files } };
}

function withFakes(fakes, run) {
  const previousFakes = globalThis.__OAO_FAKES__;
  const previousCalls = globalThis.__OAO_CALLS__;
  globalThis.__OAO_FAKES__ = fakes;
  globalThis.__OAO_CALLS__ = {};
  return Promise.resolve().then(run).finally(() => {
    globalThis.__OAO_FAKES__ = previousFakes;
    globalThis.__OAO_CALLS__ = previousCalls;
  });
}

/** Every enqueue/drain test needs these four; only the interesting one differs per test. */
function defaultFakes(overrides = {}) {
  return {
    ensureCloudflareUser: async () => undefined,
    storeJson: async (_bindings, _namespace, _owner, value) => ({
      inline: JSON.stringify(value), objectKey: null, sha256: "0".repeat(64), bytes: 2,
    }),
    readStoredJson: async (_bindings, stored) => JSON.parse(stored.inline),
    syncCloudflareOrganizationAttempts: async () => true,
    reconcileOrganizationAttemptObjects: async () => undefined,
    retireOrganizationAttemptObjects: async () => true,
    ...overrides,
  };
}

const USER = { id: USER_ID, email: "learner@example.test" };

function moduleResult(testId, date) {
  return { module: "reading", testId, testTitle: testId, band: 7, date };
}

function seedUser(database, userId, email) {
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
  `).run(userId, email);
}

/** Seeds one claimable outbox row directly, bypassing enqueue entirely. */
function seedRow(database, {
  userId, idempotencyKey = "idem-key-seeded", attemptCount = 1,
  payloadInline = '[{"module":"reading","testId":"a","testTitle":"a","band":7,"date":"2026-08-01T00:00:00.000Z"}]',
  payloadObjectKey = null,
  attemptsMade = 0, availableAt = "2020-01-01T00:00:00.000Z", leaseExpiresAt = null,
  updatedAt = "2020-01-01T00:00:00.000Z",
}) {
  database.prepare(`
    INSERT INTO organization_attempt_sync_outbox (
      user_id, idempotency_key, attempt_count, history_cleared_at,
      payload_inline, payload_object_key, payload_sha256, payload_bytes,
      attempts_made, available_at, lease_token, lease_expires_at,
      last_attempt_at, last_error_code, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 2, ?, ?, ?, ?, NULL, NULL, ?, ?)
  `).run(
    userId, idempotencyKey, attemptCount, payloadInline, payloadObjectKey, "0".repeat(64), attemptsMade,
    availableAt, leaseExpiresAt ? "lease-token-seed" : null, leaseExpiresAt,
    updatedAt, updatedAt,
  );
}

test("enqueueCloudflareOrganizationAttemptSync is a true no-op for an empty batch with nothing to clear", async () => {
  const context = fixture();
  await withFakes(defaultFakes(), async () => {
    assert.equal(
      await outbox.enqueueCloudflareOrganizationAttemptSync(USER, [], "idem-key-0000", null, context.bindings, 1000),
      true,
    );
    assert.deepEqual(globalThis.__OAO_CALLS__, {});
  });
});

test("enqueueCloudflareOrganizationAttemptSync still writes when a history clear alone is being recorded", async () => {
  const context = fixture();
  await withFakes(defaultFakes(), async () => {
    assert.equal(
      await outbox.enqueueCloudflareOrganizationAttemptSync(
        USER, [], "idem-key-0001", "2026-08-01T00:00:00.000Z", context.bindings, 1000,
      ),
      true,
    );
    assert.ok(globalThis.__OAO_CALLS__.ensureCloudflareUser, "an empty batch with a clear must still enqueue");
    assert.deepEqual(globalThis.__OAO_CALLS__.reconcileOrganizationAttemptObjects[0][1], { limit: 8, nowMs: 1000 });
  });
});

test("enqueueCloudflareOrganizationAttemptSync's size limit is a boundary at exactly 100 attempts, not an approximation", async () => {
  const context = fixture();
  const exactly100 = Array.from({ length: 100 }, (_, i) => moduleResult(`p${i}`, "2026-08-01T00:00:00.000Z"));
  await withFakes(defaultFakes(), async () => {
    assert.equal(
      await outbox.enqueueCloudflareOrganizationAttemptSync(USER, exactly100, "idem-key-0100", null, context.bindings, 1000),
      true,
      "exactly 100 attempts must be accepted, not refused",
    );
  });
});

test("enqueueCloudflareOrganizationAttemptSync refuses an outsized batch before touching any dependency", async () => {
  const context = fixture();
  const attempts = Array.from({ length: 101 }, (_, i) => moduleResult(`p${i}`, "2026-08-01T00:00:00.000Z"));
  await withFakes(defaultFakes(), async () => {
    await assert.rejects(
      outbox.enqueueCloudflareOrganizationAttemptSync(USER, attempts, "idem-key-0002", null, context.bindings, 1000),
      /Organization attempt outbox is too large/,
    );
    assert.deepEqual(globalThis.__OAO_CALLS__, {});
  });
});

test("enqueueCloudflareOrganizationAttemptSync passes the exact historyClearedAt through to the watermark, not a lost field", async () => {
  const context = fixture();
  const clearedAt = "2026-08-01T12:00:00+08:00";
  await withFakes(defaultFakes(), async () => {
    await outbox.enqueueCloudflareOrganizationAttemptSync(
      USER, [], "idem-key-0003", clearedAt, context.bindings, 1000,
    );
  });
  const row = context.database.prepare(
    "SELECT history_cleared_at FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  // organizationHistoryClearWatermark normalizes to UTC; a lost historyClearedAt
  // (the object literal emptied out) would leave this null instead.
  assert.equal(row.history_cleared_at, "2026-08-01T04:00:00.000Z");
});

test("enqueueCloudflareOrganizationAttemptSync's filter drops attempts at or before the watermark, keeps everything strictly after it", async () => {
  const context = fixture();
  const watermark = "2026-08-01T00:00:00.000Z";
  const attempts = [
    moduleResult("before", "2026-07-31T23:59:59.000Z"),
    moduleResult("equal", watermark),
    moduleResult("after", "2026-08-01T00:00:00.001Z"),
  ];
  let stored;
  await withFakes(defaultFakes({
    storeJson: async (_b, _ns, _owner, value) => {
      stored = value;
      return { inline: JSON.stringify(value), objectKey: null, sha256: "0".repeat(64), bytes: 2 };
    },
  }), async () => {
    await outbox.enqueueCloudflareOrganizationAttemptSync(
      USER, attempts, "idem-key-0004", watermark, context.bindings, 1000,
    );
  });
  assert.deepEqual(stored.map((a) => a.testId), ["after"]);
  const row = context.database.prepare(
    "SELECT attempt_count FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  assert.equal(row.attempt_count, 1);
});

test("enqueueCloudflareOrganizationAttemptSync keeps every attempt when there is no watermark to filter against", async () => {
  const context = fixture();
  const attempts = [moduleResult("a", "2026-08-01T00:00:00.000Z"), moduleResult("b", "2026-08-02T00:00:00.000Z")];
  let stored;
  await withFakes(defaultFakes({
    storeJson: async (_b, namespace, _owner, value) => {
      stored = { namespace, value };
      return { inline: JSON.stringify(value), objectKey: null, sha256: "0".repeat(64), bytes: 2 };
    },
  }), async () => {
    await outbox.enqueueCloudflareOrganizationAttemptSync(USER, attempts, "idem-key-0005", null, context.bindings, 1000);
  });
  assert.equal(stored.value.length, 2);
  assert.equal(stored.namespace, "attempts");
});

test("enqueueCloudflareOrganizationAttemptSync's watermark statements land only when a watermark is actually set", async () => {
  const withWatermark = fixture();
  await withFakes(defaultFakes(), async () => {
    await outbox.enqueueCloudflareOrganizationAttemptSync(
      USER, [], "idem-key-0006", "2026-08-01T00:00:00.000Z", withWatermark.bindings, 1000,
    );
  });
  assert.equal(
    withWatermark.database.prepare(
      "SELECT count(*) AS n FROM organization_history_clear_watermarks WHERE user_id = ?",
    ).get(USER_ID).n,
    1,
  );

  const withoutWatermark = fixture();
  await withFakes(defaultFakes(), async () => {
    await outbox.enqueueCloudflareOrganizationAttemptSync(
      USER, [moduleResult("a", "2026-08-01T00:00:00.000Z")], "idem-key-0007", null, withoutWatermark.bindings, 1000,
    );
  });
  assert.equal(
    withoutWatermark.database.prepare(
      "SELECT count(*) AS n FROM organization_history_clear_watermarks WHERE user_id = ?",
    ).get(USER_ID).n,
    0,
  );
});

test("enqueueCloudflareOrganizationAttemptSync actually persists a row a later drain can find", async () => {
  const context = fixture();
  await withFakes(defaultFakes(), async () => {
    await outbox.enqueueCloudflareOrganizationAttemptSync(
      USER, [moduleResult("a", "2026-08-01T00:00:00.000Z")], "idem-key-0008", null, context.bindings, 1000,
    );
  });
  const row = context.database.prepare(
    "SELECT idempotency_key FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  assert.equal(row.idempotency_key, "idem-key-0008");
});

test("enqueueCloudflareOrganizationAttemptSync retires the just-stored R2 object and re-throws when the D1 batch reports failure", async () => {
  const context = fixture();
  await withFakes(defaultFakes({
    storeJson: async () => ({ inline: null, objectKey: "private/attempts/owner/deadbeef.json", sha256: "1".repeat(64), bytes: 900_000 }),
  }), async () => {
    // Force the batch to see a failed statement without a real constraint
    // violation, by handing it a db whose batch() answers success:false.
    const bindings = { ...context.bindings, db: { ...context.bindings.db, async batch() { return [{ success: false, results: [], meta: {} }]; } } };
    await assert.rejects(
      outbox.enqueueCloudflareOrganizationAttemptSync(USER, [], "idem-key-0009", "2026-08-01T00:00:00.000Z", bindings, 1000),
      /Organization attempt outbox write failed/,
    );
    assert.deepEqual(
      globalThis.__OAO_CALLS__.retireOrganizationAttemptObjects[0][2],
      ["private/attempts/owner/deadbeef.json"],
    );
  });
});

test("the batch is rejected if even one statement in it failed, not merely if all of them did", async () => {
  const context = fixture();
  await withFakes(defaultFakes(), async () => {
    // Two statements, only the second reporting failure: .every() must catch
    // this; .some() would see the first succeed and wrongly call it a win.
    const bindings = {
      ...context.bindings,
      db: { ...context.bindings.db, async batch() { return [{ success: true, results: [], meta: {} }, { success: false, results: [], meta: {} }]; } },
    };
    await assert.rejects(
      outbox.enqueueCloudflareOrganizationAttemptSync(USER, [], "idem-key-mixed01", "2026-08-01T00:00:00.000Z", bindings, 1000),
      /Organization attempt outbox write failed/,
    );
  });
});

/*
  ---------------------------------------------------------------------------
  drainCloudflareOrganizationAttemptOutbox
*/

test("a claimable row is claimed, synced, deleted and counted succeeded — the whole cycle actually runs, silently", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID, payloadInline: JSON.stringify([moduleResult("a", "2026-08-01T00:00:00.000Z")]) });
  const errors = [];
  const savedError = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    await withFakes(defaultFakes(), async () => {
      const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
        bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
      });
      assert.deepEqual(result, { selected: 1, succeeded: 1, failed: 0 });
      assert.equal(globalThis.__OAO_CALLS__.syncCloudflareOrganizationAttempts.length, 1);
      assert.equal(globalThis.__OAO_CALLS__.retireOrganizationAttemptObjects.length, 1);
    });
  } finally {
    console.error = savedError;
  }
  // A cleanup that succeeded (the default fake) must log nothing — only a
  // deferred cleanup (a separate test below) does.
  assert.deepEqual(errors, []);
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM organization_attempt_sync_outbox WHERE user_id = ?").get(USER_ID).n,
    0,
    "a succeeded row must actually be removed",
  );
});

test("the drain honours its limit: a bigger backlog leaves the rest pending, not all of it processed", async () => {
  const context = fixture();
  for (let i = 0; i < 3; i += 1) {
    const userId = `50000000-0000-4000-8000-00000000030${i}`;
    seedUser(context.database, userId, `learner${i}@example.test`);
    seedRow(context.database, { userId, idempotencyKey: `idem-key-limit-${i}` });
  }
  await withFakes(defaultFakes(), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"), limit: 2,
    });
    assert.equal(result.selected, 2, "the limit must actually bound the SELECT, not just the loop");
  });
});

test("the drain's limit is clamped between 1 and MAX_DRAIN (8), never the cleanup drain's own default", async () => {
  const context = fixture();
  // Ten rows due — one more than MAX_DRAIN needs to actually cap anything;
  // with only eight due rows a limit of 1000 would look identical to a
  // correctly-capped 8 purely because there is nothing more to select.
  for (let i = 0; i < 10; i += 1) {
    const userId = `50000000-0000-4000-8000-0000000032${String(i).padStart(2, "0")}`;
    seedUser(context.database, userId, `over${i}@example.test`);
    seedRow(context.database, { userId, idempotencyKey: `idem-key-cap0-${i}` });
  }
  await withFakes(defaultFakes(), async () => {
    // Requesting far more than MAX_DRAIN must still cap at 8.
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"), limit: 1000,
    });
    assert.equal(result.selected, 8);
  });
});

test("a userId filter selects only that user's row, leaving another user's due row untouched", async () => {
  const context = fixture();
  const otherId = "50000000-0000-4000-8000-000000000399";
  seedUser(context.database, otherId, "other@example.test");
  seedRow(context.database, { userId: USER_ID, idempotencyKey: "idem-key-mine0001" });
  seedRow(context.database, { userId: otherId, idempotencyKey: "idem-key-other001" });
  await withFakes(defaultFakes(), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"), userId: USER_ID,
    });
    assert.equal(result.selected, 1);
    assert.equal(globalThis.__OAO_CALLS__.syncCloudflareOrganizationAttempts[0][0].id, USER_ID);
  });
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM organization_attempt_sync_outbox WHERE user_id = ?").get(otherId).n,
    1,
    "the other user's row must still be there, untouched",
  );
});

test("a claim race — another process already touched this row's updated_at — is skipped cleanly, not treated as claimed", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID });
  const originalPrepare = context.bindings.db.prepare.bind(context.bindings.db);
  context.bindings.db.prepare = (sql) => {
    const real = originalPrepare(sql);
    if (!sql.includes("JOIN app_users u")) return real;
    return {
      bind: (...args) => {
        const bound = real.bind(...args);
        return {
          ...bound,
          async all() {
            const res = await bound.all();
            return { ...res, results: res.results.map((r) => ({ ...r, updated_at: "1999-01-01T00:00:00.000Z" })) };
          },
        };
      },
    };
  };
  await withFakes(defaultFakes(), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.deepEqual(result, { selected: 1, succeeded: 0, failed: 0 });
    assert.equal(globalThis.__OAO_CALLS__.syncCloudflareOrganizationAttempts, undefined, "a lost claim must never reach the sync call");
  });
  const row = context.database.prepare(
    "SELECT attempts_made, lease_token FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  assert.equal(row.attempts_made, 0, "a row whose claim was lost must be left completely untouched");
  assert.equal(row.lease_token, null);
});

test("a claim that throws is treated the same as a claim that was lost, not as claimed", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID });
  const originalPrepare = context.bindings.db.prepare.bind(context.bindings.db);
  context.bindings.db.prepare = (sql) => {
    if (sql.includes("SET lease_token = ?")) {
      return { bind() { throw new Error("D1 write conflict"); } };
    }
    return originalPrepare(sql);
  };
  await withFakes(defaultFakes(), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.deepEqual(result, { selected: 1, succeeded: 0, failed: 0 });
    assert.equal(globalThis.__OAO_CALLS__.syncCloudflareOrganizationAttempts, undefined);
  });
});

test("the lease window is exactly LEASE_MS: the claim UPDATE binds nowMs + 2 minutes, not some other duration", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID });
  const captured = [];
  const originalPrepare = context.bindings.db.prepare.bind(context.bindings.db);
  context.bindings.db.prepare = (sql) => {
    const real = originalPrepare(sql);
    if (!sql.includes("SET lease_token = ?")) return real;
    return { bind: (...args) => { captured.push(args[1]); return real.bind(...args); } };
  };
  const nowMs = Date.parse("2026-08-02T00:00:00.000Z");
  await withFakes(defaultFakes(), async () => {
    await outbox.drainCloudflareOrganizationAttemptOutbox({ bindings: context.bindings, nowMs });
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0], new Date(nowMs + 2 * 60 * 1000).toISOString());
});

test("a payload whose decoded length disagrees with the stored attempt_count is rejected and retried, never synced", async () => {
  const context = fixture();
  seedRow(context.database, {
    userId: USER_ID, attemptCount: 2,
    payloadInline: JSON.stringify([moduleResult("a", "2026-08-01T00:00:00.000Z")]), // only 1, not 2
  });
  await withFakes(defaultFakes(), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.deepEqual(result, { selected: 1, succeeded: 0, failed: 1 });
    assert.equal(globalThis.__OAO_CALLS__.syncCloudflareOrganizationAttempts, undefined, "an invalid payload must never reach the sync call");
  });
  const row = context.database.prepare(
    "SELECT attempts_made, last_error_code FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  assert.equal(row.attempts_made, 1);
  assert.equal(row.last_error_code, "attempt_sync_failed");
});

test("a payload that decodes to something other than an array is rejected the same way, even at the right length", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID, attemptCount: 1, payloadInline: '{"not":"an array"}' });
  await withFakes(defaultFakes({ readStoredJson: async () => ({ not: "an array" }) }), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.equal(result.failed, 1);
    assert.equal(globalThis.__OAO_CALLS__.syncCloudflareOrganizationAttempts, undefined);
  });
});

test("syncCloudflareOrganizationAttempts reporting false is a failure, not a silent success", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID });
  await withFakes(defaultFakes({ syncCloudflareOrganizationAttempts: async () => false }), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.deepEqual(result, { selected: 1, succeeded: 0, failed: 1 });
  });
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM organization_attempt_sync_outbox WHERE user_id = ?").get(USER_ID).n,
    1,
    "a reconciliation failure must leave the row in place to retry",
  );
});

test("a delete race — a newer coalesced row replaced this lease while sync was running — is not counted succeeded or retired", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID });
  await withFakes(defaultFakes({
    syncCloudflareOrganizationAttempts: async (user) => {
      // Simulates enqueueCloudflareOrganizationAttemptSync coalescing a new
      // row for this same user while this drain's sync call was in flight.
      context.database.prepare(
        "UPDATE organization_attempt_sync_outbox SET lease_token = 'a-newer-lease' WHERE user_id = ?",
      ).run(user.id);
      return true;
    },
  }), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.deepEqual(result, { selected: 1, succeeded: 0, failed: 0 });
    assert.equal(
      globalThis.__OAO_CALLS__.retireOrganizationAttemptObjects,
      undefined,
      "a lost delete race must never retire the object the newer row still points at",
    );
  });
  assert.equal(
    context.database.prepare("SELECT lease_token FROM organization_attempt_sync_outbox WHERE user_id = ?").get(USER_ID).lease_token,
    "a-newer-lease",
    "the newer row must be left completely alone",
  );
});

test("the R2 cleanup is asked to retire exactly the row's own object key", async () => {
  const context = fixture();
  seedRow(context.database, {
    userId: USER_ID, payloadInline: null,
    payloadObjectKey: `private/attempts/${USER_ID}/deadbeefcafe.json`,
  });
  await withFakes(defaultFakes({ readStoredJson: async () => [moduleResult("a", "2026-08-01T00:00:00.000Z")] }), async () => {
    await outbox.drainCloudflareOrganizationAttemptOutbox({
      bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    assert.deepEqual(
      globalThis.__OAO_CALLS__.retireOrganizationAttemptObjects[0][2],
      [`private/attempts/${USER_ID}/deadbeefcafe.json`],
    );
  });
});

test("a deferred R2 cleanup is logged with the exact sentence and the user id, but still counts the row succeeded", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID });
  const errors = [];
  const savedError = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    await withFakes(defaultFakes({ retireOrganizationAttemptObjects: async () => false }), async () => {
      const result = await outbox.drainCloudflareOrganizationAttemptOutbox({
        bindings: context.bindings, nowMs: Date.parse("2026-08-02T00:00:00.000Z"),
      });
      assert.deepEqual(result, { selected: 1, succeeded: 1, failed: 0 });
    });
  } finally {
    console.error = savedError;
  }
  assert.deepEqual(
    errors,
    [JSON.stringify({ message: "organization attempt outbox object cleanup deferred", userId: USER_ID })],
  );
});

test("a failed attempt's retry delay follows the exact backoff formula, and attempts_made increments from its stored value", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID, attemptsMade: 0, attemptCount: 1, payloadInline: "[]" });
  const nowMs = Date.parse("2026-08-02T00:00:00.000Z");
  await withFakes(defaultFakes(), async () => {
    const result = await outbox.drainCloudflareOrganizationAttemptOutbox({ bindings: context.bindings, nowMs });
    assert.deepEqual(result, { selected: 1, succeeded: 0, failed: 1 });
  });
  const row = context.database.prepare(
    "SELECT attempts_made, available_at, last_error_code FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  assert.equal(row.attempts_made, 1);
  // attemptsMade becomes 1: seconds = min(3600, 15*(2**min(1,8))) = min(3600, 30) = 30.
  assert.equal(row.available_at, new Date(nowMs + 30_000).toISOString());
  assert.equal(row.last_error_code, "attempt_sync_failed");
});

test("the retry backoff caps at one hour once the exponent saturates at MAX_BACKOFF_EXPONENT", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID, attemptsMade: 7, attemptCount: 1, payloadInline: "[]" });
  const nowMs = Date.parse("2026-08-02T00:00:00.000Z");
  await withFakes(defaultFakes(), async () => {
    await outbox.drainCloudflareOrganizationAttemptOutbox({ bindings: context.bindings, nowMs });
  });
  const row = context.database.prepare(
    "SELECT attempts_made, available_at FROM organization_attempt_sync_outbox WHERE user_id = ?",
  ).get(USER_ID);
  // attemptsMade becomes 8 (the exponent cap): seconds = min(3600, 15*256) = 3600.
  assert.equal(row.attempts_made, 8);
  assert.equal(row.available_at, new Date(nowMs + 3_600_000).toISOString());
});

test("attempts_made caps at 20 and never climbs past it", async () => {
  const context = fixture();
  seedRow(context.database, { userId: USER_ID, attemptsMade: 20, attemptCount: 1, payloadInline: "[]" });
  const nowMs = Date.parse("2026-08-02T00:00:00.000Z");
  await withFakes(defaultFakes(), async () => {
    await outbox.drainCloudflareOrganizationAttemptOutbox({ bindings: context.bindings, nowMs });
  });
  const row = context.database.prepare("SELECT attempts_made FROM organization_attempt_sync_outbox WHERE user_id = ?").get(USER_ID);
  assert.equal(row.attempts_made, 20);
});
