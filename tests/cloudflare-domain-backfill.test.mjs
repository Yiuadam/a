import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const backfill = await load("lib", "cloudflare", "domain-backfill.ts");
const drift = await load("lib", "cloudflare", "domain-drift.ts");
const supabaseAuth = await load("lib", "auth", "supabase.ts");

/*
  Comments quoting the code they check must not make an assertion pass
  against nothing at all — source text is stripped of comments first.
*/
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((row) => row.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

function runtimeD1(database) {
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
        const results = [];
        for (const statement of statements) results.push(await statement.run());
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
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      objects.set(key, bytes);
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
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
  return { database, bindings: { db: runtimeD1(database), files }, objects };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const CREATED = "2026-08-01T00:00:00.000Z";

const U1 = "60000000-0000-4000-8000-000000000001"; // ordinary, already-mirrored account
const U2 = "60000000-0000-4000-8000-000000000002"; // D1 app_users.deleted_at is set
const U3 = "60000000-0000-4000-8000-000000000003"; // carries an account_deletion_tombstones row
const U4 = "60000000-0000-4000-8000-000000000004"; // not yet bootstrapped into D1 at all

function seedUser(database, id, { deletedAt = null } = {}) {
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at, deleted_at)
    VALUES (?, ?, 'user', ?, ?, ?)
  `).run(id, `${id}@example.test`, CREATED, CREATED, deletedAt);
}

function seedTombstone(database, id) {
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'operation-000000000001', 'prepared', ?, ?, ?)
  `).run(id, CREATED, CREATED, CREATED);
}

/** The real fingerprint D1 would report for one key of a domain right now. */
async function realFingerprint(bindings, domain, key) {
  let after = "";
  for (;;) {
    const page = await drift.cloudflareTargetDriftPage(domain, bindings, after, 500);
    if (page.length === 0) return null;
    const found = page.find((row) => row.key === key);
    if (found) return sha256(found.evidence);
    after = page[page.length - 1].key;
  }
}

/** Serves a fixed set of (key, fingerprint) rows the way the paged RPC would. */
function sourceOf(rows) {
  const sorted = [...rows].sort((a, b) => (a.row_key < b.row_key ? -1 : a.row_key > b.row_key ? 1 : 0));
  return async (domain, after, limit) => sorted
    .filter((row) => row.row_key > after)
    .slice(0, limit)
    .map((row) => ({ row_key: row.row_key, fingerprint: row.fingerprint }));
}

// ---------------------------------------------------------------------------

test("a dry run reports what it would write and writes nothing", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);
  database.prepare(`
    INSERT INTO progress_snapshots (
      user_id, store_key, payload_inline, payload_sha256, payload_bytes,
      source_updated_at, created_at, updated_at
    ) VALUES (?, 'ielts-prep-v1', '{"v":1}', ?, 8, '2026-08-10T00:00:00.000Z', ?, '2026-08-10T00:00:00.000Z')
  `).run(U1, sha256('{"v":1}'), CREATED);

  const key = `${U1}/ielts-prep-v1`;
  const report = await backfill.backfillCloudflareDomain("progress_snapshots", bindings, {
    apply: false,
    readSourcePage: sourceOf([{ row_key: key, fingerprint: sha256("supabase-has-a-newer-payload") }]),
    fetchers: {
      progressSnapshot: async (userId, storeKey) => (userId === U1 && storeKey === "ielts-prep-v1"
        ? { userId, storeKey, payload: { v: 2 }, updatedAt: "2026-08-15T00:00:00.000Z" }
        : null),
    },
  });

  assert.equal(report.apply, false);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].key, key);
  assert.equal(report.rows[0].bucket, "fingerprint_mismatch");
  assert.equal(report.rows[0].status, "would_update");

  const row = database.prepare("SELECT payload_inline FROM progress_snapshots WHERE user_id = ?").get(U1);
  assert.equal(row.payload_inline, '{"v":1}', "a dry run must not touch D1");
});

test("apply writes a missing usage event, and a second apply changes nothing further", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);

  const fetchers = {
    usageEvent: async (id) => (id === "usage-101"
      ? { id, userId: U1, route: "define", ipHash: null, outcome: "admitted", createdAt: "2026-08-15T00:00:00.000Z" }
      : null),
  };
  const source = [{ row_key: "usage-101", fingerprint: sha256("supabase-has-this-row") }];

  const first = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: true,
    readSourcePage: sourceOf(source),
    fetchers,
  });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].status, "inserted");

  const row = database.prepare("SELECT user_id, route, outcome FROM usage_events WHERE id = 'usage-101'").get();
  assert.deepEqual({ ...row }, { user_id: U1, route: "define", outcome: "admitted" });

  // Once written, the row's real D1 fingerprint is what a live scan sees.
  const settled = sourceOf([{ row_key: "usage-101", fingerprint: await realFingerprint(bindings, "usage_events", "usage-101") }]);
  const second = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: true,
    readSourcePage: settled,
    fetchers,
  });
  assert.equal(second.status, "equal");
  assert.equal(second.rows.length, 0, "nothing left to repair once the mirror agrees");
});

test("a deleted account's drifted row is skipped, never written", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U2, { deletedAt: "2026-08-16T00:00:00.000Z" });

  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: "usage-200", fingerprint: sha256("x") }]),
    fetchers: {
      usageEvent: async (id) => (id === "usage-200"
        ? { id, userId: U2, route: "define", ipHash: null, outcome: "admitted", createdAt: CREATED }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "skipped_deleted_account");
  const row = database.prepare("SELECT 1 AS present FROM usage_events WHERE id = 'usage-200'").get();
  assert.equal(row, undefined, "a deleted account must never be resurrected by a backfill");
});

test("a tombstoned account's drifted row is skipped, never written", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U3);
  seedTombstone(database, U3);

  const report = await backfill.backfillCloudflareDomain("progress_snapshots", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: `${U3}/ielts-prep-v1`, fingerprint: sha256("x") }]),
    fetchers: {
      progressSnapshot: async (userId, storeKey) => (userId === U3 && storeKey === "ielts-prep-v1"
        ? { userId, storeKey, payload: { v: 1 }, updatedAt: CREATED }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "skipped_deleted_account");
  const row = database.prepare("SELECT 1 AS present FROM progress_snapshots WHERE user_id = ?").get(U3);
  assert.equal(row, undefined);
});

test("a D1 row newer than Supabase's read is left alone, never rolled back", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);
  // Canonical nine-digit form, matching exactly what every real writer stores
  // (see canonicalCloudflareSourceClock) — not just a format the day-of-month
  // digit happens to sort correctly against.
  const NEWER = "2026-08-20T00:00:00.000000000Z";
  database.prepare(`
    INSERT INTO progress_snapshots (
      user_id, store_key, payload_inline, payload_sha256, payload_bytes,
      source_updated_at, created_at, updated_at
    ) VALUES (?, 'bandup.drills.v1', '{"fresh":true}', ?, 15, ?, ?, ?)
  `).run(U1, sha256('{"fresh":true}'), NEWER, CREATED, NEWER);

  const key = `${U1}/bandup.drills.v1`;
  const report = await backfill.backfillCloudflareDomain("progress_snapshots", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: key, fingerprint: sha256("an-older-supabase-read") }]),
    fetchers: {
      progressSnapshot: async (userId, storeKey) => (userId === U1 && storeKey === "bandup.drills.v1"
        // Older than the row already mirrored in D1.
        ? { userId, storeKey, payload: { stale: true }, updatedAt: "2026-08-16T00:00:00.000Z" }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "skipped_target_current");
  const row = database.prepare("SELECT payload_inline, source_updated_at FROM progress_snapshots WHERE user_id = ? AND store_key = 'bandup.drills.v1'").get(U1);
  assert.equal(row.payload_inline, '{"fresh":true}');
  assert.equal(row.source_updated_at, NEWER);
});

test("a missing usage event for a brand new account bootstraps app_users without a clobber", async () => {
  const { database, bindings } = fixture();
  // U4 does not exist in D1 app_users at all yet.
  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: "usage-300", fingerprint: sha256("x") }]),
    fetchers: {
      usageEvent: async (id) => (id === "usage-300"
        ? { id, userId: U4, route: "grade_writing", ipHash: "abc", outcome: "admitted", createdAt: CREATED }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "inserted");
  const user = database.prepare("SELECT email, deleted_at FROM app_users WHERE id = ?").get(U4);
  assert.equal(user.email, null, "a bootstrap stub must never invent an email");
  assert.equal(user.deleted_at, null);
  const usage = database.prepare("SELECT user_id FROM usage_events WHERE id = 'usage-300'").get();
  assert.equal(usage.user_id, U4);
});

test("a missing subscription is backfilled with its real provider, and invents no provider_events row", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);

  const report = await backfill.backfillCloudflareDomain("subscriptions", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: "sub-400", fingerprint: sha256("x") }]),
    fetchers: {
      subscription: async (id) => (id === "sub-400"
        ? {
          id, userId: U1, provider: "apple", status: "active", tier: "ai",
          customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
          cancelAtPeriodEnd: false, providerEventAt: null, verifiedAt: CREATED,
          raw: { original_transaction_id: "apple-txn-1" }, createdAt: CREATED, updatedAt: CREATED,
        }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "inserted");
  const row = database.prepare("SELECT provider, status, tier FROM subscriptions WHERE id = 'sub-400'").get();
  assert.deepEqual({ ...row }, { provider: "apple", status: "active", tier: "ai" });
  const events = database.prepare("SELECT count(*) AS n FROM provider_events").get();
  assert.equal(events.n, 0, "a backfill must never fabricate a webhook delivery Supabase never recorded");
});

test("a missing AI cost event keeps its real source and external_reference, not the live meter's assumptions", async () => {
  const { database, bindings } = fixture();

  const report = await backfill.backfillCloudflareDomain("ai_cost_events", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: "cost-500", fingerprint: sha256("x") }]),
    fetchers: {
      aiCostEvent: async (id) => (id === "cost-500"
        ? {
          id, source: "provider_backfill", providerRequestId: null, externalReference: "parity-9",
          route: null, model: null, inputTokens: null, outputTokens: null,
          cacheCreationInputTokens: null, cacheCreation5mInputTokens: null,
          cacheCreation1hInputTokens: null, cacheReadInputTokens: null,
          costUsd: "1.230000000", occurredAt: CREATED, recordedAt: CREATED,
        }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "inserted");
  const row = database.prepare(`
    SELECT source, external_reference, provider_request_id, cost_usd
      FROM ai_cost_events WHERE id = 'cost-500'
  `).get();
  assert.deepEqual({ ...row }, {
    source: "provider_backfill",
    external_reference: "parity-9",
    provider_request_id: null,
    cost_usd: "1.230000000",
  });
});

test("a row D1 has that Supabase does not is reported and never touched", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);
  database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('usage-only-in-d1', ?, 'define', 'admitted', ?)
  `).run(U1, CREATED);

  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: true,
    readSourcePage: sourceOf([]), // Supabase reports nothing at all for this domain.
  });

  assert.equal(report.missingInSourceTotal, 1);
  assert.equal(report.rows.length, 0, "a D1-only row is never in the write list");
  const row = database.prepare("SELECT 1 AS present FROM usage_events WHERE id = 'usage-only-in-d1'").get();
  assert.ok(row, "one-direction-only: Supabase never deletes anything out of D1 here");
});

test("applyLimit bounds how many rows one call attempts, and says so", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);

  const ids = ["usage-a", "usage-b", "usage-c"];
  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: true,
    applyLimit: 1,
    readSourcePage: sourceOf(ids.map((id) => ({ row_key: id, fingerprint: sha256(id) }))),
    fetchers: {
      usageEvent: async (id) => (ids.includes(id)
        ? { id, userId: U1, route: "define", ipHash: null, outcome: "admitted", createdAt: CREATED }
        : null),
    },
  });

  assert.equal(report.missingInTargetTotal, 3);
  assert.equal(report.rows.length, 1);
  assert.equal(report.truncated, true);
  const count = database.prepare("SELECT count(*) AS n FROM usage_events").get();
  assert.equal(count.n, 1, "only the bounded slice was ever written");
});

test("a dry run against a missing_in_target row reports would_insert, not would_update", async () => {
  const { bindings } = fixture();
  const key = "usage-dry-insert";
  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: false,
    readSourcePage: sourceOf([{ row_key: key, fingerprint: sha256("supabase-only-row") }]),
    fetchers: {
      usageEvent: async (id) => (id === key
        ? { id, userId: U1, route: "define", ipHash: null, outcome: "admitted", createdAt: CREATED }
        : null),
    },
  });
  assert.equal(report.rows[0].bucket, "missing_in_target");
  assert.equal(report.rows[0].status, "would_insert");
});

test("applying a genuine fingerprint_mismatch repair (not missing_in_target) reports updated", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);
  const OLDER = "2026-08-10T00:00:00.000000000Z";
  database.prepare(`
    INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
    VALUES ('sub-update-me', ?, 'stripe', 'active', 'ai', ?, ?, ?)
  `).run(U1, OLDER, CREATED, OLDER);

  const report = await backfill.backfillCloudflareDomain("subscriptions", bindings, {
    apply: true,
    // A deliberately wrong fingerprint -- any value other than the row's own
    // real one -- so the drift scan calls this a fingerprint mismatch rather
    // than reporting it equal.
    readSourcePage: sourceOf([{ row_key: "sub-update-me", fingerprint: sha256("not-the-real-fingerprint") }]),
    fetchers: {
      subscription: async (id) => (id === "sub-update-me"
        ? {
          id, userId: U1, provider: "stripe", status: "active", tier: "ai",
          customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
          cancelAtPeriodEnd: false, providerEventAt: null, verifiedAt: OLDER,
          raw: {}, createdAt: CREATED,
          // Newer than the existing row, so the guarded upsert actually changes it.
          updatedAt: "2026-08-16T00:00:00.000Z",
        }
        : null),
    },
  });
  assert.equal(report.rows[0].bucket, "fingerprint_mismatch");
  assert.equal(report.rows[0].status, "updated");
});

test("a subscription repair that the ordering guard leaves untouched reports changed:false via skipped_target_current", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);
  const NEWER = "2026-08-20T00:00:00.000000000Z";
  database.prepare(`
    INSERT INTO subscriptions (id, user_id, provider, status, tier, provider_event_at, verified_at, created_at, updated_at)
    VALUES ('sub-guarded', ?, 'stripe', 'active', 'ai', ?, ?, ?, ?)
  `).run(U1, NEWER, NEWER, CREATED, NEWER);

  const report = await backfill.backfillCloudflareDomain("subscriptions", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: "sub-guarded", fingerprint: sha256("an-older-supabase-read") }]),
    fetchers: {
      subscription: async (id) => (id === "sub-guarded"
        ? {
          id, userId: U1, provider: "stripe", status: "active", tier: "ai",
          customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
          cancelAtPeriodEnd: false, providerEventAt: "2026-08-15T00:00:00.000Z", verifiedAt: CREATED,
          raw: {}, createdAt: CREATED, updatedAt: "2026-08-16T00:00:00.000Z",
        }
        : null),
    },
  });
  assert.equal(report.rows[0].status, "skipped_target_current", "success without an actual change must not report 'updated'");
});

test("a malformed progress-snapshot key (no user/store-key separator) is never handed to the fetcher", async () => {
  const { bindings } = fixture();
  const report = await backfill.backfillCloudflareDomain("progress_snapshots", bindings, {
    apply: true,
    readSourcePage: sourceOf([{ row_key: "malformed-key-with-no-slash", fingerprint: sha256("x") }]),
    fetchers: {
      progressSnapshot: async () => { throw new Error("must not be called for a key with no user/store-key separator"); },
    },
  });
  assert.equal(report.rows[0].status, "skipped_source_row_gone");
});

test("applyLimit above the maximum is clamped to 200, not collapsed to 1", async () => {
  const { bindings } = fixture();
  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: false,
    applyLimit: 500,
    readSourcePage: sourceOf([]),
  });
  assert.equal(report.applyLimit, 200);
});

test("truncated is computed by addition of attempted/drifted counts, not subtraction", async () => {
  const { database, bindings } = fixture();
  seedUser(database, U1);

  function seedMismatchedUsageEvent(id, index) {
    database.prepare(`
      INSERT INTO usage_events (id, user_id, route, outcome, created_at)
      VALUES (?, ?, 'define', 'admitted', ?)
    `).run(id, U1, CREATED);
    return { row_key: id, fingerprint: sha256(`wrong-fingerprint-${index}`) };
  }

  // Scenario A: applyLimit covers every drifted row exactly (2 missing + 2
  // mismatched, limit 10) -- nothing is left over, so truncated must be
  // false. An "attempted" computed by subtraction (2 - 2 = 0) would instead
  // read as 0 < 4, flipping truncated to true.
  {
    const missing = [
      { row_key: "usage-missing-a", fingerprint: sha256("a") },
      { row_key: "usage-missing-b", fingerprint: sha256("b") },
    ];
    const mismatched = [seedMismatchedUsageEvent("usage-mismatch-a", 0), seedMismatchedUsageEvent("usage-mismatch-b", 1)];
    const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
      apply: false,
      applyLimit: 10,
      readSourcePage: sourceOf([...missing, ...mismatched]),
    });
    assert.equal(report.missingInTargetTotal, 2);
    assert.equal(report.fingerprintMismatchTotal, 2);
    assert.equal(report.truncated, false, "every drifted row was attempted; nothing was left out");
  }

  // Scenario B: applyLimit (2) is smaller than the true drifted total (1
  // missing + 5 mismatched = 6), so some rows are left over and truncated
  // must be true. A "drifted" computed by subtraction (1 - 5 = -4) would
  // instead read as 2 < -4, flipping truncated to false.
  {
    const missing = [{ row_key: "usage-missing-c", fingerprint: sha256("c") }];
    const mismatched = Array.from({ length: 5 }, (_, i) => seedMismatchedUsageEvent(`usage-mismatch-c${i}`, i + 10));
    const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
      apply: false,
      applyLimit: 2,
      readSourcePage: sourceOf([...missing, ...mismatched]),
    });
    assert.equal(report.missingInTargetTotal, 1);
    assert.equal(report.fingerprintMismatchTotal, 5);
    assert.equal(report.truncated, true, "only 2 of 6 drifted rows were attempted");
  }

  // Scenario C: applyLimit (3) is smaller than the true drifted total (2
  // missing + 4 mismatched = 6). driftKeys's own remaining-budget arithmetic
  // for fingerprintMismatch is applyLimit - missingInTarget.length = 1, so
  // only 1 of the 4 mismatched rows should actually be attempted (3 rows
  // total). A "+" in place of "-" would instead compute a remaining budget
  // of 3 + 2 = 5, big enough to take all 4 mismatched rows (6 rows total).
  {
    const missing = [
      { row_key: "usage-missing-d0", fingerprint: sha256("d0") },
      { row_key: "usage-missing-d1", fingerprint: sha256("d1") },
    ];
    const mismatched = Array.from({ length: 4 }, (_, i) => seedMismatchedUsageEvent(`usage-mismatch-d${i}`, i + 20));
    const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
      apply: false,
      applyLimit: 3,
      readSourcePage: sourceOf([...missing, ...mismatched]),
    });
    assert.equal(report.missingInTargetTotal, 2);
    assert.equal(report.fingerprintMismatchTotal, 4);
    assert.equal(report.rows.length, 3, "only 1 of the 4 mismatched rows fits the remaining budget after 2 missing rows");
  }
});

test("the short-circuit for 'unavailable'/'equal' status is equivalent to falling through (domain-backfill.ts:405-406)", async () => {
  /*
    All four ConditionalExpression survivors on this line, plus the
    BlockStatement and the `truncated: false` BooleanLiteral right after it,
    turn out to be unobservable together -- not because the check never
    matters, but because of a structural fact in domain-drift.ts:
    cloudflareDomainDrift's `base` object (which its `unavailable` return and
    its "equal" caller both flow through) snapshots
    `missingInTarget.value`/`fingerprintMismatch.value` once, BEFORE the
    merge-join loop runs at all -- so a drift result is only ever "equal" or
    "unavailable" together with every one of those buckets already at
    {total: 0, sample: []}. Demonstrated directly: even after a source read
    fails partway through a full 500-row first page (every one of which is
    missing from an empty D1 table), the reported buckets are still zero.
  */
  let calls = 0;
  const readSourcePage = async () => {
    calls += 1;
    if (calls === 1) {
      return Array.from({ length: 500 }, (_, i) => ({
        row_key: `usage-${String(i).padStart(5, "0")}`,
        fingerprint: sha256(`fp-${i}`),
      }));
    }
    throw new Error("source failed reading the second page");
  };
  const { bindings } = fixture(); // fresh D1, no usage_events rows at all
  const result = await drift.cloudflareDomainDrift("usage_events", bindings, { sampleLimit: 50, readSourcePage });
  assert.equal(result.status, "unavailable");
  assert.equal(result.missingInTarget.total, 0, "the reported bucket is frozen from before the loop ran, despite 500 real misses");

  // Given that structural fact, driftKeys(drift, applyLimit) is empty for
  // both "unavailable" and "equal" drift results on every reachable call, so
  // backfillCloudflareDomain's fallthrough (if the if-check were skipped)
  // computes rows=[] and truncated=(0 < 0)=false itself -- byte for byte the
  // same as the hardcoded short-circuit return. Confirmed end to end via the
  // exported function, whose rows/truncated match regardless:
  const report = await backfill.backfillCloudflareDomain("usage_events", bindings, {
    apply: false, applyLimit: 50, readSourcePage,
  });
  assert.equal(report.status, "unavailable");
  assert.deepEqual(report.rows, []);
  assert.equal(report.truncated, false);
});

test("backfillCloudflareDomains uses the bindings it was given, without falling back to a live Cloudflare context", async () => {
  const { bindings } = fixture();
  const reports = await backfill.backfillCloudflareDomains(["usage_events", "subscriptions"], bindings, {
    readSourcePage: sourceOf([]),
  });
  assert.equal(reports.length, 2, "one report per requested domain");
  assert.deepEqual(reports.map((report) => report.domain), ["usage_events", "subscriptions"]);
  for (const report of reports) assert.equal(report.status, "equal");
});

test("driftKeys's own .slice(0, applyLimit) on missingInTarget is unreachable in this call path (equivalent survivor, domain-backfill.ts:221)", () => {
  /*
    backfillCloudflareDomain always calls cloudflareDomainDrift with
    `sampleLimit: applyLimit` (see backfillCloudflareDomain below), and
    domain-drift.ts's own bucket() never lets a sample grow past sampleLimit.
    So by the time driftKeys() runs, drift.missingInTarget.sample.length is
    already <= applyLimit on every reachable call -- .slice(0, applyLimit) on
    an array already that short is always a no-op. Demonstrated: the
    "applyLimit bounds how many rows one call attempts" test above already
    proves the bound is enforced (3 candidates, applyLimit 1, exactly 1 row
    attempted) -- via the upstream sampleLimit, not this slice, which this
    file's own source confirms by construction.
  */
  const source = readFileSync(join(process.cwd(), "lib", "cloudflare", "domain-backfill.ts"), "utf8");
  assert.match(source, /sampleLimit: applyLimit/);
});

test("the narrow Supabase reads reject a malformed key before ever building a request", async () => {
  assert.equal(await supabaseAuth.cloudflareBackfillUsageEventRow("not-a-number"), null);
  assert.equal(await supabaseAuth.cloudflareBackfillAiCostEventRow("not-a-number"), null);
  assert.equal(await supabaseAuth.cloudflareBackfillSubscriptionRow("not-a-uuid"), null);
  assert.equal(await supabaseAuth.cloudflareBackfillProgressSnapshotRow("not-a-uuid", "ielts-prep-v1"), null);
  assert.equal(await supabaseAuth.cloudflareBackfillProgressSnapshotRow(U1, "not-a-real-store-key"), null);
});

test("the backfill route is admin-gated, applies only on an explicit flag, and never leaks a database message", () => {
  const route = code(readFileSync(
    join(process.cwd(), "app", "api", "admin", "cloudflare", "backfill", "route.ts"),
    "utf8",
  ));
  assert.match(route, /isAdminEmail\(actor\.email\)/);
  assert.match(route, /export const dynamic = "force-dynamic"/);

  // GET must be structurally incapable of applying: it always passes false.
  const getBody = route.slice(route.indexOf("async function handleGET"), route.indexOf("async function handlePOST"));
  assert.doesNotMatch(getBody, /apply:\s*true/);
  assert.match(getBody, /apply:\s*false/);

  // POST applies only when the caller's own body says so explicitly.
  const postBody = route.slice(route.indexOf("async function handlePOST"));
  assert.match(postBody, /body\.apply === true/);
  assert.doesNotMatch(postBody, /\bcatch\s*\([^)]*\)\s*\{\s*return NextResponse\.json\(\{[^}]*error/);

  assert.doesNotMatch(route, /logInternal[^;]*\)\s*;\s*return NextResponse\.json\(\{\s*error:\s*error/);
});
