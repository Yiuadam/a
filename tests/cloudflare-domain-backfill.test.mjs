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
          id, userId: U1, provider: "apple", status: "active", tier: "pro",
          customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
          cancelAtPeriodEnd: false, providerEventAt: null, verifiedAt: CREATED,
          raw: { original_transaction_id: "apple-txn-1" }, createdAt: CREATED, updatedAt: CREATED,
        }
        : null),
    },
  });

  assert.equal(report.rows[0].status, "inserted");
  const row = database.prepare("SELECT provider, status, tier FROM subscriptions WHERE id = 'sub-400'").get();
  assert.deepEqual({ ...row }, { provider: "apple", status: "active", tier: "pro" });
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
