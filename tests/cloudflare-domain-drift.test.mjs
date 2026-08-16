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
const drift = await load("lib", "cloudflare", "domain-drift.ts");
const readiness = await load("lib", "cloudflare", "migration-readiness.ts");

/*
  A comment quoting the code it checks once made one of these assertions pass
  against nothing at all. Source text is therefore stripped of comments before
  anything is asserted about it.
*/
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((row) => row.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

function sqlCode(text) {
  return text
    .split("\n")
    .map((row) => row.replace(/(^|\s)--.*$/, "$1"))
    .join("\n");
}

function runtimeD1(database) {
  const bound = (sql, values) => ({
    async run() {
      const result = database.prepare(sql).run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
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
      return { bind: (...values) => bound(sql, values), ...bound(sql, []) };
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
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

const CREATED = "2026-08-01T00:00:00.000Z";
const UPDATED = "2026-08-14T10:00:00.000Z";
const USERS = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
  "50000000-0000-4000-8000-000000000003",
];

function seed(database, { usageEvents = 3 } = {}) {
  for (const [index, user] of USERS.entries()) {
    database.prepare(`
      INSERT INTO app_users (id,email,role,created_at,updated_at)
      VALUES (?, ?, 'user', ?, ?)
    `).run(user, `learner${index}@example.test`, CREATED, UPDATED);
    database.prepare(`
      INSERT INTO learner_profiles (user_id,display_name,source_updated_at,updated_at)
      VALUES (?, ?, ?, ?)
    `).run(user, `Learner ${index}`, UPDATED, UPDATED);
    database.prepare(`
      INSERT INTO usernames (username,user_id,created_at,source_updated_at)
      VALUES (?, ?, ?, ?)
    `).run(`learner.${index}`, user, CREATED, UPDATED);
    database.prepare(`
      INSERT INTO progress_snapshots (
        user_id,store_key,payload_inline,payload_sha256,payload_bytes,
        source_updated_at,created_at,updated_at
      ) VALUES (?, 'ielts-prep-v1', '{}', ?, 2, ?, ?, ?)
    `).run(user, createHash("sha256").update("{}").digest("hex"), UPDATED, CREATED, UPDATED);
  }
  database.prepare(`
    INSERT INTO subscriptions (id,user_id,provider,status,tier,verified_at,created_at,updated_at)
    VALUES ('subscription-1', ?, 'stripe', 'active', 'pro', ?, ?, ?)
  `).run(USERS[0], UPDATED, CREATED, UPDATED);
  database.prepare(`
    INSERT INTO provider_events (provider,event_id,received_at,processed_at)
    VALUES ('stripe', 'event-1', ?, ?)
  `).run(CREATED, UPDATED);
  for (let index = 0; index < usageEvents; index += 1) {
    database.prepare(`
      INSERT INTO usage_events (id,user_id,route,outcome,created_at)
      VALUES (?, ?, 'define', 'admitted', ?)
    `).run(`usage-${String(index).padStart(5, "0")}`, USERS[index % USERS.length], UPDATED);
  }
  database.prepare(`
    INSERT INTO ai_cost_events (id,source,external_reference,cost_usd,occurred_at,recorded_at)
    VALUES ('cost-1', 'provider_backfill', 'parity-backfill', '0.123456789', ?, ?)
  `).run(CREATED, UPDATED);
  database.prepare(`
    INSERT INTO ai_cost_coverage (singleton,source,starts_at,historical_complete,recorded_at)
    VALUES (1, 'provider_console', ?, 1, ?)
  `).run(CREATED, UPDATED);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Every D1 row of a domain, as the source would report it if it agreed. */
async function mirrorOfTarget(bindings, domain) {
  const rows = [];
  let after = "";
  for (;;) {
    const page = await drift.cloudflareTargetDriftPage(domain, bindings, after, 500);
    if (page.length === 0) break;
    for (const row of page) rows.push({ row_key: row.key, fingerprint: sha256(row.evidence), evidence: row.evidence });
    after = page[page.length - 1].key;
    if (page.length < 500) break;
  }
  return rows.sort((left, right) => (left.row_key < right.row_key ? -1 : left.row_key > right.row_key ? 1 : 0));
}

/** Serves a fixed list of source rows the way the paged RPC would. */
function pagedSource(byDomain) {
  return async (domain, after, limit) => (byDomain[domain] ?? [])
    .filter((row) => row.row_key > after)
    .slice(0, limit)
    .map((row) => ({ row_key: row.row_key, fingerprint: row.fingerprint }));
}

async function mirrorAll(bindings) {
  const byDomain = {};
  for (const domain of drift.DRIFT_DOMAINS) byDomain[domain] = await mirrorOfTarget(bindings, domain);
  return byDomain;
}

test("a mirror that agrees row for row is reported equal in every domain", async () => {
  const context = fixture();
  seed(context.database);
  const byDomain = await mirrorAll(context.bindings);

  const report = await drift.cloudflareDomainDriftReport(
    context.bindings,
    drift.DRIFT_DOMAINS,
    { readSourcePage: pagedSource(byDomain) },
  );

  for (const entry of report.domains) {
    assert.equal(entry.status, "equal", `${entry.domain} should be equal`);
    assert.equal(entry.complete, true);
    assert.equal(entry.missingInTarget.total + entry.missingInSource.total + entry.fingerprintMismatch.total, 0);
  }
});

test("per-row evidence rebuilds the whole-domain fingerprint the readiness report compares", async () => {
  const context = fixture();
  seed(context.database);
  const whole = await readiness.cloudflareTargetFingerprints(context.bindings);

  for (const domain of drift.DRIFT_DOMAINS) {
    const rows = await mirrorOfTarget(context.bindings, domain);
    const rebuilt = sha256(rows.map((row) => row.evidence).sort().join("\n"));
    const expected = whole.find((row) => row.domain === domain);
    assert.equal(rows.length, expected.row_count, `${domain} row count`);
    assert.equal(rebuilt, expected.fingerprint, `${domain} fingerprint`);
  }
});

test("rows Supabase has and D1 does not are named", async () => {
  const context = fixture();
  seed(context.database);
  const byDomain = await mirrorAll(context.bindings);
  context.database.prepare("DELETE FROM usage_events WHERE id = 'usage-00001'").run();

  const entry = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "drifted");
  assert.equal(entry.missingInTarget.total, 1);
  assert.deepEqual(entry.missingInTarget.sample, ["usage-00001"]);
  assert.equal(entry.missingInSource.total, 0);
  assert.equal(entry.fingerprintMismatch.total, 0);
});

test("rows D1 kept after the account left Supabase are named, with the deletion tombstone counted", async () => {
  const context = fixture();
  seed(context.database);
  const byDomain = await mirrorAll(context.bindings);
  // The account is gone from Supabase but still live in the mirror.
  byDomain.profiles = byDomain.profiles.filter((row) => row.row_key !== USERS[2]);
  context.database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id,operation_id,state,prepared_at,lease_expires_at,auth_deleted_at,
      data_deleted_at,completed_at,updated_at
    ) VALUES (?, 'operation-000000000001', 'complete', ?, ?, ?, ?, ?, ?)
  `).run(USERS[2], CREATED, UPDATED, UPDATED, UPDATED, UPDATED, UPDATED);

  const entry = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "drifted");
  assert.deepEqual(entry.missingInSource.sample, [USERS[2]]);
  assert.deepEqual(entry.deletionTombstones, { sampled: 1, withTombstone: 1 });
});

test("a username pointing at a different account is named as a differing row", async () => {
  const context = fixture();
  seed(context.database);
  const byDomain = await mirrorAll(context.bindings);
  byDomain.usernames = byDomain.usernames.map((row) => row.row_key === "learner.1"
    ? { ...row, fingerprint: sha256("a different account owns this alias") }
    : row);

  const entry = await drift.cloudflareDomainDrift("usernames", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "drifted");
  assert.equal(entry.fingerprintMismatch.total, 1);
  assert.deepEqual(entry.fingerprintMismatch.sample, ["learner.1"]);
  assert.equal(entry.missingInTarget.total + entry.missingInSource.total, 0);
});

test("both sides are read in pages, so a domain larger than one page still compares exactly", async () => {
  const context = fixture();
  seed(context.database, { usageEvents: 1300 });
  const byDomain = await mirrorAll(context.bindings);
  context.database.prepare("DELETE FROM usage_events WHERE id = 'usage-01200'").run();

  const entry = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.comparedSourceRows, 1300);
  assert.equal(entry.comparedTargetRows, 1299);
  assert.equal(entry.complete, true);
  assert.deepEqual(entry.missingInTarget.sample, ["usage-01200"]);
});

test("a bounded comparison says how far it got instead of claiming the domain is clean", async () => {
  const context = fixture();
  seed(context.database, { usageEvents: 1300 });
  const byDomain = await mirrorAll(context.bindings);

  const entry = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    rowLimit: 600,
  });
  assert.equal(entry.complete, false);
  assert.equal(entry.status, "partial");
  assert.equal(entry.comparedSourceRows, 600);
  assert.equal(entry.comparedThroughKey, "usage-00599");
});

test("the sample is bounded while the total counts every offending row compared", async () => {
  const context = fixture();
  seed(context.database, { usageEvents: 200 });
  const byDomain = await mirrorAll(context.bindings);
  context.database.prepare("DELETE FROM usage_events WHERE id > 'usage-00049'").run();

  const entry = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    sampleLimit: 5,
  });
  assert.equal(entry.missingInTarget.total, 150);
  assert.equal(entry.missingInTarget.sample.length, 5);
  assert.deepEqual(entry.missingInTarget.sample, [
    "usage-00050", "usage-00051", "usage-00052", "usage-00053", "usage-00054",
  ]);
});

test("an unreadable source names the side that failed and never the database message", async () => {
  const context = fixture();
  seed(context.database);
  const entry = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    readSourcePage: async () => { throw new Error("source database detail must stay server-only"); },
  });
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.unavailable, "source");
  assert.doesNotMatch(JSON.stringify(entry), /source database detail must stay server-only/);
});

test("no stored value reaches the report — only keys and one-way hashes", async () => {
  const context = fixture();
  seed(context.database);
  const byDomain = await mirrorAll(context.bindings);
  byDomain.profiles = byDomain.profiles.filter((row) => row.row_key !== USERS[0]);
  byDomain.usernames = byDomain.usernames.map((row) => row.row_key === "learner.0"
    ? { ...row, fingerprint: sha256("elsewhere") }
    : row);

  const report = await drift.cloudflareDomainDriftReport(
    context.bindings,
    ["profiles", "usernames"],
    { readSourcePage: pagedSource(byDomain) },
  );
  const body = JSON.stringify(report);
  assert.doesNotMatch(body, /learner0@example\.test/);
  assert.doesNotMatch(body, /Learner 0/);
  assert.match(body, new RegExp(USERS[0]));
});

test("the drift parameter accepts only known domains", () => {
  assert.equal(drift.parseDriftDomains(null), null);
  assert.equal(drift.parseDriftDomains("0"), null);
  assert.equal(drift.parseDriftDomains("nonsense"), null);
  assert.deepEqual(drift.parseDriftDomains("all"), [...drift.DRIFT_DOMAINS]);
  assert.deepEqual(drift.parseDriftDomains("usernames, profiles, dropped"), ["usernames", "profiles"]);
});

test("the row listing is admin-only, off by default, and its SQL is service-role only and not a migration", () => {
  const route = code(readFileSync(
    join(process.cwd(), "app", "api", "admin", "cloudflare", "readiness", "route.ts"),
    "utf8",
  ));
  assert.match(route, /isAdminEmail\(actor\.email\)/);
  assert.match(route, /parseDriftDomains\(query\.get\("drift"\)\)/);
  assert.match(route, /if \(wanted\)/);
  assert.match(route, /private, no-store/);

  const sql = sqlCode(readFileSync(join(process.cwd(), "supabase", "row-drift-rpc.sql"), "utf8"));
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b/i);
  assert.doesNotMatch(sql, /auth\.users/);
  assert.equal(
    readdirSync(join(process.cwd(), "supabase", "migrations")).some((name) => name.includes("row_drift")),
    false,
  );

  const driftSource = code(readFileSync(join(process.cwd(), "lib", "cloudflare", "domain-drift.ts"), "utf8"));
  // Nothing here may write to either side.
  assert.doesNotMatch(driftSource, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/);
  assert.match(driftSource, /COLLATE BINARY/);
});
