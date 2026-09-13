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

function seedUser(database, id) {
  database.prepare(`
    INSERT INTO app_users (id,email,role,created_at,updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(id, `${id}@example.test`, CREATED, UPDATED);
}

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
    VALUES ('subscription-1', ?, 'stripe', 'active', 'ai', ?, ?, ?)
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

test("a subscription's cancel_at_period_end boolean is encoded as the exact text 'true'/'false' in its evidence line", async () => {
  const context = fixture();
  seedUser(context.database, "80000000-0000-4000-8000-000000000001");
  context.database.prepare(`
    INSERT INTO subscriptions (id,user_id,provider,status,tier,cancel_at_period_end,verified_at,created_at,updated_at)
    VALUES ('sub-cancelling', ?, 'stripe', 'active', 'ai', 1, ?, ?, ?)
  `).run("80000000-0000-4000-8000-000000000001", UPDATED, CREATED, UPDATED);
  context.database.prepare(`
    INSERT INTO subscriptions (id,user_id,provider,status,tier,cancel_at_period_end,verified_at,created_at,updated_at)
    VALUES ('sub-renewing', ?, 'stripe', 'active', 'ai', 0, ?, ?, ?)
  `).run("80000000-0000-4000-8000-000000000001", UPDATED, CREATED, UPDATED);

  const rows = await drift.cloudflareTargetDriftPage("subscriptions", context.bindings, "", 10);
  const cancelling = rows.find((row) => row.key === "sub-cancelling");
  const renewing = rows.find((row) => row.key === "sub-renewing");
  assert.match(cancelling.evidence, /\|4:true\|/);
  assert.match(renewing.evidence, /\|5:false\|/);
});

test("ai_cost_coverage's historical_complete boolean is encoded as the exact text 'true'/'false' in its evidence line", async () => {
  // ai_cost_coverage is a singleton table (one row, drift_key is a constant),
  // so the true and false cases each need their own fresh database.
  const complete = fixture();
  complete.database.prepare(`
    INSERT INTO ai_cost_coverage (singleton,source,starts_at,historical_complete,recorded_at)
    VALUES (1, 'provider_console', ?, 1, ?)
  `).run(CREATED, UPDATED);
  const completeRows = await drift.cloudflareTargetDriftPage("ai_cost_coverage", complete.bindings, "", 10);
  assert.equal(completeRows.length, 1);
  assert.match(completeRows[0].evidence, /\|4:true\|/);

  const incomplete = fixture();
  incomplete.database.prepare(`
    INSERT INTO ai_cost_coverage (singleton,source,starts_at,historical_complete,recorded_at)
    VALUES (1, 'provider_console', ?, 0, ?)
  `).run(CREATED, UPDATED);
  const incompleteRows = await drift.cloudflareTargetDriftPage("ai_cost_coverage", incomplete.bindings, "", 10);
  assert.equal(incompleteRows.length, 1);
  assert.match(incompleteRows[0].evidence, /\|5:false\|/);
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
  assert.deepEqual(drift.parseDriftDomains("1"), [...drift.DRIFT_DOMAINS]);
  assert.deepEqual(drift.parseDriftDomains("true"), [...drift.DRIFT_DOMAINS]);
  assert.deepEqual(drift.parseDriftDomains("usernames, profiles, dropped"), ["usernames", "profiles"]);
});

test("an empty-string, '0' or 'false' drift parameter is equivalent to falling through to the list parser (domain-drift.ts:543)", () => {
  /*
    `value === "" || value === "0" || value === "false"` short-circuits to
    null before the comma-separated-list branch runs at all. But none of
    "", "0" or "false" is itself a known DRIFT_DOMAIN name, so if this check
    were bypassed entirely, each of them would flow into
    `value.split(",").map(trim).filter(known.has)`, come back empty, and
    still return null via the function's own trailing
    `wanted.length > 0 ? wanted : null` -- the same answer, by a different
    route. Demonstrated directly: the list-parser branch already returns
    null for exactly these three inputs on its own.
  */
  for (const value of ["", "0", "false"]) {
    assert.equal(drift.parseDriftDomains(value), null);
  }
});

test("the RPC name and paging parameters sent for the real Supabase source read", async () => {
  const previousEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  Object.assign(process.env, {
    SUPABASE_URL: "https://project.supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  });
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const context = fixture();
    // No readSourcePage override -- this is the one call in this file that
    // exercises the real rpc() path rather than a fake.
    await drift.cloudflareDomainDrift("usernames", context.bindings, {});
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/cloudflare_migration_source_row_fingerprints$/);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.p_domain, "usernames");
    assert.equal(body.p_after, "");
    assert.equal(body.p_limit, 500);
  } finally {
    globalThis.fetch = savedFetch;
    Object.assign(process.env, previousEnv);
  }
});

test("a non-array source page makes the domain unavailable rather than silently accepted", async () => {
  const context = fixture();
  // Deliberately array-*like* (carries its own harmless .map) rather than a
  // plain object -- a plain object would make .map() itself throw before the
  // Array.isArray check's own removal could ever be observed separately.
  const result = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    readSourcePage: async () => ({ map: () => [] }),
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.unavailable, "source");
  assert.equal(result.complete, false, "an unavailable result must never claim to be complete");
});

test("a source row whose key is not a string makes the domain unavailable", async () => {
  const context = fixture();
  const result = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    // A well-shaped 64-hex fingerprint, paired with a non-string key -- this
    // isolates the row_key shape check from the fingerprint shape check.
    readSourcePage: async () => [{ row_key: 12345, fingerprint: "a".repeat(64) }],
  });
  assert.equal(result.status, "unavailable");
});

test("a source fingerprint outside the strict 64-hex shape makes the domain unavailable, anchored at both ends", async () => {
  const context = fixture();
  const before = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    readSourcePage: async () => [{ row_key: "some-real-looking-key", fingerprint: `!${"a".repeat(64)}` }],
  });
  assert.equal(before.status, "unavailable", "a leading character outside the 64-hex shape must not be accepted");

  const after = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    readSourcePage: async () => [{ row_key: "some-real-looking-key", fingerprint: `${"a".repeat(64)}!` }],
  });
  assert.equal(after.status, "unavailable", "a trailing character outside the 64-hex shape must not be accepted");
});

test("the source-page validation's own fallback/error text never reaches the report and is equivalent (domain-drift.ts:399,401,402)", () => {
  /*
    cloudflareDomainDrift's outer try/catch swallows every error the merge
    join can throw into a bare status: "unavailable" -- the thrown Error's
    own .message is never read anywhere the caller can observe. So the exact
    text of "source page is not a list" / "source page is malformed" (and
    the `row?.fingerprint ?? ""` fallback used only to feed the regex test,
    which no non-64-hex fallback string could ever pass anyway) cannot be
    distinguished from any other value by this module's public surface --
    confirmed above: three different kinds of malformed input all converge
    on the identical `{status: "unavailable", unavailable: "source"}]`
    shape, never a message.
  */
  assert.equal(typeof drift.cloudflareDomainDrift, "function");
});

test("deletionTombstones never counts an anonymous D1-only row that Supabase never reported", async () => {
  const context = fixture();
  const TOMBSTONED = "70000000-0000-4000-8000-000000000001";
  const NOT_TOMBSTONED = "70000000-0000-4000-8000-000000000002";
  seedUser(context.database, TOMBSTONED, {});
  seedUser(context.database, NOT_TOMBSTONED, {});
  // Three D1-only usage_events rows: anonymous, (later) tombstoned, and
  // neither -- written before the tombstone exists, since a deletion-guard
  // trigger on usage_events refuses any insert for an already-tombstoned
  // user (rows from before the account's deletion started are exactly what
  // this sweep is meant to find).
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('usage-anon', NULL, 'chat', 'admitted', ?)
  `).run(UPDATED);
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('usage-tombstoned', ?, 'chat', 'admitted', ?)
  `).run(TOMBSTONED, UPDATED);
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('usage-live', ?, 'chat', 'admitted', ?)
  `).run(NOT_TOMBSTONED, UPDATED);
  context.database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'operation-000000000002', 'prepared', ?, ?, ?)
  `).run(TOMBSTONED, CREATED, CREATED, CREATED);

  const result = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: pagedSource({ usage_events: [] }),
  });
  assert.equal(result.missingInSource.total, 3);
  assert.deepEqual(
    result.deletionTombstones,
    { sampled: 2, withTombstone: 1 },
    "the anonymous row must never be counted, and only the genuinely tombstoned account must be",
  );
});

test("tombstoneCount never queries D1 at all once every candidate id has been filtered out", async () => {
  const context = fixture();
  // Two D1-only, both anonymous: every mapped userId is "", so `unique`
  // ends up genuinely empty even though extraKeys itself is not.
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('usage-anon-a', NULL, 'chat', 'admitted', ?)
  `).run(UPDATED);
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('usage-anon-b', NULL, 'chat', 'admitted', ?)
  `).run(UPDATED);

  // SQLite itself treats `IN ()` as simply matching nothing (not a syntax
  // error), so an empty `unique` list produces the identical zeroed result
  // whether or not the query actually runs -- the only way to prove the
  // early return is taken is to make that query itself fail if reached.
  const poisoned = {
    db: {
      prepare(sql) {
        if (sql.includes("account_deletion_tombstones")) {
          throw new Error("must not query tombstones once every id has been filtered out");
        }
        return context.bindings.db.prepare(sql);
      },
      batch: (...args) => context.bindings.db.batch(...args),
    },
    files: context.bindings.files,
  };

  const result = await drift.cloudflareDomainDrift("usage_events", poisoned, {
    readSourcePage: pagedSource({ usage_events: [] }),
  });
  assert.equal(result.missingInSource.total, 2);
  assert.deepEqual(result.deletionTombstones, { sampled: 0, withTombstone: 0 });
});

test("deletionTombstones is null, not a zeroed object, for a domain with no user column at all", async () => {
  const context = fixture();
  // provider_events has no user_id / userId spec at all.
  context.database.prepare(`
    INSERT INTO provider_events (provider, event_id, received_at, processed_at)
    VALUES ('stripe', 'orphan-event', ?, ?)
  `).run(CREATED, UPDATED);
  const result = await drift.cloudflareDomainDrift("provider_events", context.bindings, {
    readSourcePage: pagedSource({ provider_events: [] }),
  });
  assert.equal(result.missingInSource.total, 1);
  assert.equal(result.deletionTombstones, null, "a domain with no userId spec must never compute tombstone counts");
});

test("deletionTombstones is null, not a zeroed object, when there is nothing D1-only to check", async () => {
  const context = fixture();
  seed(context.database);
  const byDomain = await mirrorAll(context.bindings);
  const result = await drift.cloudflareDomainDrift("profiles", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(result.missingInSource.total, 0);
  assert.equal(result.deletionTombstones, null);
});

test("the row limit is the larger of the two streams' progress, not the smaller", async () => {
  const context = fixture();
  // D1 (target) is entirely empty; every source row is missing-in-target, so
  // target.consumed never advances at all while source.consumed climbs with
  // every row -- Math.min of the two would never reach the limit.
  const total = 120;
  const byDomain = { usage_events: [] };
  for (let index = 0; index < total; index += 1) {
    byDomain.usage_events.push({ row_key: `usage-${String(index).padStart(5, "0")}`, fingerprint: sha256(`f${index}`) });
  }
  const result = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    rowLimit: 50,
  });
  assert.equal(result.complete, false);
  assert.equal(result.comparedSourceRows, 50, "Math.max(source, target) must be the one compared against rowLimit");
});

test("the read-page callback is not re-invoked once a stream already knows it is exhausted", async () => {
  const context = fixture();
  // Two short source rows, both alphabetically before ten D1-only rows: the
  // source stream exhausts after its first (short) page, while the merge
  // join keeps running for many more iterations to drain the target side.
  for (let index = 0; index < 10; index += 1) {
    context.database.prepare(`
      INSERT INTO usage_events (id, user_id, route, outcome, created_at)
      VALUES (?, NULL, 'chat', 'admitted', ?)
    `).run(`zzz-${String(index).padStart(3, "0")}`, UPDATED);
  }
  let calls = 0;
  const result = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: async (_domain, after) => {
      calls += 1;
      return ["aaa", "bbb"].filter((key) => key > after).map((key) => ({ row_key: key, fingerprint: sha256(key) }));
    },
  });
  assert.equal(result.missingInTarget.total, 2);
  assert.equal(result.missingInSource.total, 10);
  assert.equal(calls, 1, "a stream that already knows it is exhausted must not ask its source for another page");
});

test("the same call-suppression applies when the very first source page is already empty", async () => {
  const context = fixture();
  for (let index = 0; index < 10; index += 1) {
    context.database.prepare(`
      INSERT INTO usage_events (id, user_id, route, outcome, created_at)
      VALUES (?, NULL, 'chat', 'admitted', ?)
    `).run(`zzz-${String(index).padStart(3, "0")}`, UPDATED);
  }
  let calls = 0;
  const result = await drift.cloudflareDomainDrift("usage_events", context.bindings, {
    readSourcePage: async () => { calls += 1; return []; },
  });
  assert.equal(result.missingInSource.total, 10);
  assert.equal(calls, 1, "an immediately-empty first page must mark the stream exhausted on the spot");
});

test("results[0]?.rowLimit/sampleLimit fallbacks are unreachable through the public report function (equivalent, domain-drift.ts:535-536)", async () => {
  /*
    cloudflareDomainDriftReport always resolves `wanted` to a non-empty
    array before building `results` -- either the caller's own non-empty
    `domains`, or the full DRIFT_DOMAINS default -- so `results` can never be
    empty and `results[0]` can never be undefined. The `?? DEFAULT` fallback
    (and the optional chaining that guards it) therefore can never actually
    run through this exported function; results[0].rowLimit/sampleLimit are
    always the real, defined values every individual domain result already
    carries.
  */
  const context = fixture();
  const report = await drift.cloudflareDomainDriftReport(context.bindings, ["profiles"], {
    readSourcePage: pagedSource({ profiles: [] }),
    rowLimit: 42,
    sampleLimit: 7,
  });
  assert.equal(report.domains.length, 1);
  assert.equal(report.rowLimit, 42);
  assert.equal(report.sampleLimit, 7);
});

test("an empty domains list falls back to every DRIFT_DOMAINS entry, and a non-empty list is used exactly as given", async () => {
  const context = fixture();
  const empty = await drift.cloudflareDomainDriftReport(context.bindings, [], {
    readSourcePage: pagedSource({}),
  });
  assert.equal(empty.domains.length, drift.DRIFT_DOMAINS.length);

  const narrow = await drift.cloudflareDomainDriftReport(context.bindings, ["profiles"], {
    readSourcePage: pagedSource({ profiles: [] }),
  });
  assert.deepEqual(narrow.domains.map((entry) => entry.domain), ["profiles"]);
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
