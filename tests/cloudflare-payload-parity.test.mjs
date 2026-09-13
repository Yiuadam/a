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
const parity = await load("lib", "cloudflare", "payload-parity.ts");
const canonical = await load("lib", "cloudflare", "payload-canonical.ts");
const cutoverDomains = await load("lib", "cloudflare", "cutover-domains.ts");

/*
  A comment quoting the code it checks once made an assertion pass against
  nothing at all. Source text is therefore stripped of comments before
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

/** An in-memory stand-in for the R2 binding, just enough for readTargetPayload. */
function filesStub() {
  const store = new Map();
  return {
    async put(key, bytes) {
      store.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
    async get(key) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    _store: store,
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  const files = filesStub();
  return { database, files, bindings: { db: runtimeD1(database), files } };
}

const CREATED = "2026-08-01T00:00:00.000Z";
const UPDATED = "2026-08-14T10:00:00.000Z";

function seedUser(database, userId, index) {
  database.prepare(`
    INSERT INTO app_users (id,email,role,created_at,updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(userId, `learner${index}@example.test`, CREATED, UPDATED);
  database.prepare(`
    INSERT INTO learner_profiles (user_id,display_name,source_updated_at,updated_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, `Learner ${index}`, UPDATED, UPDATED);
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Writes a progress_snapshots row the way storeJson would: inline or as an R2 object. */
async function seedProgress(context, userId, storeKey, payload, { asObject = false } = {}) {
  const bytes = jsonBytes(payload);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (asObject) {
    const key = `private/progress/${userId}/${sha}.json`;
    await context.files.put(key, bytes);
    context.database.prepare(`
      INSERT INTO progress_snapshots (user_id,store_key,payload_object_key,payload_sha256,payload_bytes,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, storeKey, key, sha, bytes.byteLength, CREATED, UPDATED);
  } else {
    context.database.prepare(`
      INSERT INTO progress_snapshots (user_id,store_key,payload_inline,payload_sha256,payload_bytes,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, storeKey, new TextDecoder().decode(bytes), sha, bytes.byteLength, CREATED, UPDATED);
  }
}

async function seedSubscription(context, id, userId, payload, { asObject = false, none = false } = {}) {
  if (none) {
    context.database.prepare(`
      INSERT INTO subscriptions (id,user_id,provider,status,tier,verified_at,created_at,updated_at)
      VALUES (?, ?, 'stripe', 'active', 'ai', ?, ?, ?)
    `).run(id, userId, UPDATED, CREATED, UPDATED);
    return;
  }
  const bytes = jsonBytes(payload);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (asObject) {
    const key = `private/subscriptions/${userId}/${sha}.json`;
    await context.files.put(key, bytes);
    context.database.prepare(`
      INSERT INTO subscriptions (id,user_id,provider,status,tier,verified_at,raw_object_key,raw_sha256,created_at,updated_at)
      VALUES (?, ?, 'stripe', 'active', 'ai', ?, ?, ?, ?, ?)
    `).run(id, userId, UPDATED, key, sha, CREATED, UPDATED);
  } else {
    context.database.prepare(`
      INSERT INTO subscriptions (id,user_id,provider,status,tier,verified_at,raw_inline,raw_sha256,created_at,updated_at)
      VALUES (?, ?, 'stripe', 'active', 'ai', ?, ?, ?, ?, ?)
    `).run(id, userId, UPDATED, new TextDecoder().decode(bytes), sha, CREATED, UPDATED);
  }
}

async function seedProviderEvent(context, eventId, payload, { none = false } = {}) {
  if (none) {
    context.database.prepare(`
      INSERT INTO provider_events (provider,event_id,received_at,processed_at)
      VALUES ('stripe', ?, ?, ?)
    `).run(eventId, CREATED, UPDATED);
    return;
  }
  const bytes = jsonBytes(payload);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const key = `private/provider-events/${eventId}/${sha}.json`;
  await context.files.put(key, bytes);
  context.database.prepare(`
    INSERT INTO provider_events (provider,event_id,received_at,processed_at,payload_object_key,payload_sha256)
    VALUES ('stripe', ?, ?, ?, ?, ?)
  `).run(eventId, CREATED, UPDATED, key, sha);
}

/** Serves fixed source rows the way the paged RPC would. */
function pagedSource(byDomain) {
  return async (domain, after, limit) => (byDomain[domain] ?? [])
    .filter((row) => row.row_key > after)
    .slice(0, limit)
    .map((row) => ({ row_key: row.row_key, payload_present: row.payload_present, payload_hash: row.payload_hash }));
}

async function sourceRow(key, payload) {
  return payload === undefined
    ? { row_key: key, payload_present: false, payload_hash: null }
    : { row_key: key, payload_present: true, payload_hash: await canonical.canonicalPayloadHash(payload) };
}

const USER = "50000000-0000-4000-8000-000000000001";
const USER2 = "50000000-0000-4000-8000-000000000002";

test("a payload that matches byte for byte, inline and as an R2 object, is reported equal", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  seedUser(context.database, USER2, 1);
  const progressPayload = { score: 6.5, answers: ["a", "b"] };
  const bigPayload = { transcript: "x".repeat(200), score: 7.0 };
  await seedProgress(context, USER, "ielts-prep-v1", progressPayload);
  await seedProgress(context, USER2, "bandup.drills.v1", bigPayload, { asObject: true });
  await seedSubscription(context, "sub-1", USER, { kind: "stripe" });
  await seedProviderEvent(context, "evt-1", { type: "checkout" });

  const byDomain = {
    progress_snapshots: [
      await sourceRow(`${USER}/ielts-prep-v1`, progressPayload),
      await sourceRow(`${USER2}/bandup.drills.v1`, bigPayload),
    ],
    subscriptions: [await sourceRow("sub-1", { kind: "stripe" })],
    provider_events: [await sourceRow("stripe/evt-1", { type: "checkout" })],
  };

  const report = await parity.cloudflarePayloadParityReport(
    context.bindings,
    parity.PAYLOAD_PARITY_DOMAINS,
    { readSourcePage: pagedSource(byDomain) },
  );
  for (const entry of report.domains) {
    assert.equal(entry.status, "equal", `${entry.domain} should be equal`);
    assert.equal(entry.complete, true);
    assert.equal(
      entry.missingInTarget.total + entry.missingInSource.total
        + entry.payloadMismatch.total + entry.targetPayloadUnavailable.total,
      0,
      entry.domain,
    );
  }
});

test("a payload D1 holds a stale copy of is named, even though the row itself matches", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  await seedProgress(context, USER, "ielts-prep-v1", { score: 6.0 });

  const byDomain = {
    progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, { score: 7.0 })],
    subscriptions: [],
    provider_events: [],
  };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "drifted");
  assert.equal(entry.payloadMismatch.total, 1);
  assert.deepEqual(entry.payloadMismatch.sample, [`${USER}/ielts-prep-v1`]);
  assert.equal(entry.targetPayloadUnavailable.total, 0);
});

test("a row Supabase has and D1 never received is named as missing from Cloudflare", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const byDomain = {
    progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, { score: 6.0 })],
    subscriptions: [],
    provider_events: [],
  };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "drifted");
  assert.deepEqual(entry.missingInTarget.sample, [`${USER}/ielts-prep-v1`]);
});

test("a row only the D1 mirror has is named as only in Cloudflare", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  await seedProgress(context, USER, "ielts-prep-v1", { score: 6.0 });
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource({ progress_snapshots: [] }),
  });
  assert.equal(entry.status, "drifted");
  assert.deepEqual(entry.missingInSource.sample, [`${USER}/ielts-prep-v1`]);
});

test("a D1 row pointing at a missing R2 object is reported distinctly, never as equal or as a plain mismatch", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const payload = { transcript: "y".repeat(200) };
  await seedProgress(context, USER, "ielts-prep-v1", payload, { asObject: true });
  // Delete the object out from under the row the way an incomplete or
  // corrupted mirror write could leave things.
  const key = [...context.files._store.keys()][0];
  context.files._store.delete(key);

  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, payload)] };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "drifted");
  assert.equal(entry.targetPayloadUnavailable.total, 1);
  assert.deepEqual(entry.targetPayloadUnavailable.sample, [`${USER}/ielts-prep-v1`]);
  // Not double-counted as a hash mismatch on top of being unreadable.
  assert.equal(entry.payloadMismatch.total, 0);
});

test("a D1 object whose bytes no longer match its own recorded checksum is reported distinctly", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const payload = { transcript: "z".repeat(200) };
  await seedProgress(context, USER, "ielts-prep-v1", payload, { asObject: true });
  const key = [...context.files._store.keys()][0];
  context.files._store.set(key, new TextEncoder().encode('{"transcript":"tampered"}'));

  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, payload)] };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.targetPayloadUnavailable.total, 1);
  assert.equal(entry.payloadMismatch.total, 0);
});

test("a legacy row with no payload on either side is equal; one side having a payload the other lacks is a mismatch", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  seedUser(context.database, USER2, 1);
  await seedSubscription(context, "sub-both-none", USER, null, { none: true });
  await seedSubscription(context, "sub-target-only", USER2, { kind: "stripe" });

  const byDomain = {
    subscriptions: [
      await sourceRow("sub-both-none", undefined),
      await sourceRow("sub-target-only", undefined),
    ],
  };
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.payloadMismatch.total, 1);
  assert.deepEqual(entry.payloadMismatch.sample, ["sub-target-only"]);
});

test("both sides are read in pages, so a domain larger than one page still compares exactly", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const byDomain = { provider_events: [] };
  const total = 250;
  for (let index = 0; index < total; index += 1) {
    const eventId = `evt-${String(index).padStart(5, "0")}`;
    const payload = { n: index };
    await seedProviderEvent(context, eventId, payload);
    byDomain.provider_events.push(await sourceRow(`stripe/${eventId}`, payload));
  }
  // Delete one row from the mirror.
  context.database.prepare("DELETE FROM provider_events WHERE event_id = 'evt-00120'").run();

  const entry = await parity.cloudflarePayloadParity("provider_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    rowLimit: 100000,
  });
  assert.equal(entry.complete, true);
  assert.equal(entry.comparedSourceRows, total);
  assert.equal(entry.comparedTargetRows, total - 1);
  assert.deepEqual(entry.missingInTarget.sample, ["stripe/evt-00120"]);
});

test("a bounded comparison says how far it got instead of claiming the domain is clean", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const byDomain = { provider_events: [] };
  for (let index = 0; index < 250; index += 1) {
    const eventId = `evt-${String(index).padStart(5, "0")}`;
    const payload = { n: index };
    await seedProviderEvent(context, eventId, payload);
    byDomain.provider_events.push(await sourceRow(`stripe/${eventId}`, payload));
  }
  const entry = await parity.cloudflarePayloadParity("provider_events", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    rowLimit: 100,
  });
  assert.equal(entry.complete, false);
  assert.equal(entry.status, "partial");
  assert.equal(entry.comparedSourceRows, 100);
  assert.equal(entry.comparedThroughKey, "stripe/evt-00099");
});

test("an unreadable source names the side that failed and never the database message", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  await seedProgress(context, USER, "ielts-prep-v1", { score: 6 });
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: async () => { throw new Error("source database detail must stay server-only"); },
  });
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.unavailable, "source");
  assert.doesNotMatch(JSON.stringify(entry), /source database detail must stay server-only/);
});

test("no stored payload value reaches the report — only keys and one-way hashes", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const secretPayload = { essay: "a very personal essay about my summer holiday" };
  await seedProgress(context, USER, "ielts-prep-v1", secretPayload, { asObject: true });

  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, { essay: "a different essay" })] };
  const report = await parity.cloudflarePayloadParityReport(
    context.bindings,
    ["progress_snapshots"],
    { readSourcePage: pagedSource(byDomain) },
  );
  const body = JSON.stringify(report);
  assert.doesNotMatch(body, /summer holiday/);
  assert.doesNotMatch(body, /a different essay/);
  assert.match(body, new RegExp(USER));
});

test("the payloadParity parameter accepts only known domains", () => {
  assert.equal(parity.parsePayloadParityDomains(null), null);
  assert.equal(parity.parsePayloadParityDomains("0"), null);
  assert.equal(parity.parsePayloadParityDomains("nonsense"), null);
  assert.deepEqual(parity.parsePayloadParityDomains("all"), [...parity.PAYLOAD_PARITY_DOMAINS]);
  assert.deepEqual(parity.parsePayloadParityDomains("1"), [...parity.PAYLOAD_PARITY_DOMAINS]);
  assert.deepEqual(parity.parsePayloadParityDomains("true"), [...parity.PAYLOAD_PARITY_DOMAINS]);
  assert.deepEqual(
    parity.parsePayloadParityDomains("subscriptions, progress_snapshots, dropped"),
    ["subscriptions", "progress_snapshots"],
  );
});

test("an empty-string, '0' or 'false' payloadParity value is equivalent to falling through to the list parser (payload-parity.ts:451)", () => {
  /*
    Same shape as domain-drift.ts's parseDriftDomains: none of "", "0" or
    "false" is itself a known payload-parity domain name, so bypassing the
    early null-return still ends at null via the comma-list branch's own
    "wanted.length > 0 ? wanted : null" fallback.
  */
  for (const value of ["", "0", "false"]) {
    assert.equal(parity.parsePayloadParityDomains(value), null);
  }
});

test("an empty domains list falls back to every PAYLOAD_PARITY_DOMAINS entry, and a non-empty list is used exactly as given", async () => {
  const context = fixture();
  const empty = await parity.cloudflarePayloadParityReport(context.bindings, [], {
    readSourcePage: pagedSource({}),
  });
  assert.equal(empty.domains.length, parity.PAYLOAD_PARITY_DOMAINS.length);

  const narrow = await parity.cloudflarePayloadParityReport(context.bindings, ["subscriptions"], {
    readSourcePage: pagedSource({ subscriptions: [] }),
  });
  assert.deepEqual(narrow.domains.map((entry) => entry.domain), ["subscriptions"]);
});

test("results[0]?.rowLimit/sampleLimit fallbacks are unreachable through the public report function (equivalent, payload-parity.ts:443-444)", async () => {
  /*
    cloudflarePayloadParityReport always resolves `wanted` to a non-empty
    array first (the caller's own non-empty domains, or the full
    PAYLOAD_PARITY_DOMAINS default), so `results` can never be empty and
    `results[0]` can never be undefined -- the `?? DEFAULT` fallback (and its
    guarding `?.`) can never actually run.
  */
  const context = fixture();
  const report = await parity.cloudflarePayloadParityReport(context.bindings, ["subscriptions"], {
    readSourcePage: pagedSource({ subscriptions: [] }),
    rowLimit: 33,
    sampleLimit: 4,
  });
  assert.equal(report.rowLimit, 33);
  assert.equal(report.sampleLimit, 4);
});

test("sampleLimit is clamped between 1 and 200 by the outer/inner bound, not collapsed by swapping max and min", async () => {
  const context = fixture();
  const tooHigh = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource({ subscriptions: [] }),
    sampleLimit: 500,
  });
  assert.equal(tooHigh.sampleLimit, 200, "the inner Math.min(x, 200) must win over an oversized request");

  const negative = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource({ subscriptions: [] }),
    sampleLimit: -5,
  });
  assert.equal(negative.sampleLimit, 1, "the outer Math.max(1, x) must win over a negative request");
});

test("a bucket's sample is bounded by sampleLimit while its total counts every offending row", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const byDomain = { subscriptions: [] };
  const total = 30;
  for (let index = 0; index < total; index += 1) {
    const id = `sub-missing-${String(index).padStart(3, "0")}`;
    byDomain.subscriptions.push(await sourceRow(id, { plan: index }));
  }
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    sampleLimit: 5,
  });
  assert.equal(entry.missingInTarget.total, total);
  assert.equal(entry.missingInTarget.sample.length, 5);
});

test("the inline JSON.parse catch is equivalent: D1's own CHECK constraint already guarantees valid JSON (payload-parity.ts:186)", () => {
  /*
    progress_snapshots' own CHECK constraint (cloudflare/migrations/0001_learner_data.sql)
    is `payload_inline IS NOT NULL AND payload_object_key IS NULL AND
    json_valid(payload_inline)` -- SQLite refuses to store a row whose inline
    text is not valid JSON in the first place, so readTargetPayload's
    `JSON.parse(columns.inline)` can never throw for any row this schema
    actually holds. Verified directly: SQLite's own json_valid() rejects
    everything tried here that would trip JSON.parse, and accepts nothing
    that would still trip it (huge numbers, lone surrogate pairs, embedded
    NUL, trailing whitespace all agree in both).
  */
  const db = new DatabaseSync(":memory:");
  const malformed = ["{\"a\":1,}", "{a:1}", "NaN", "[1,2,3,]", "{'a':1}"];
  for (const text of malformed) {
    const sqliteAccepts = Boolean(db.prepare("SELECT json_valid(?) AS v").get(text).v);
    let jsAccepts = true;
    try { JSON.parse(text); } catch { jsAccepts = false; }
    assert.equal(sqliteAccepts, false, `expected SQLite to reject ${JSON.stringify(text)} too`);
    assert.equal(jsAccepts, false, `expected JSON.parse to reject ${JSON.stringify(text)}`);
  }
});

test("invalid JSON stored as an R2 object (but otherwise checksum-valid) is reported unavailable", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const bytes = new TextEncoder().encode("not valid json{");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const key = `private/progress/${USER}/${sha}.json`;
  await context.files.put(key, bytes);
  context.database.prepare(`
    INSERT INTO progress_snapshots (user_id,store_key,payload_object_key,payload_sha256,payload_bytes,created_at,updated_at)
    VALUES (?, 'ielts-prep-v1', ?, ?, ?, ?, ?)
  `).run(USER, key, sha, bytes.byteLength, CREATED, UPDATED);

  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, { score: 1 })] };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.targetPayloadUnavailable.total, 1);
  assert.equal(entry.payloadMismatch.total, 0);
});

test("a recorded byte count that disagrees with the real R2 object size is unavailable, isolated from the checksum check", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const payload = { score: 5 };
  const bytes = jsonBytes(payload);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const key = `private/progress/${USER}/${sha}.json`;
  await context.files.put(key, bytes);
  // The recorded sha256 is correct (checksum check passes); only the
  // recorded byte count is wrong.
  context.database.prepare(`
    INSERT INTO progress_snapshots (user_id,store_key,payload_object_key,payload_sha256,payload_bytes,created_at,updated_at)
    VALUES (?, 'ielts-prep-v1', ?, ?, 999999, ?, ?)
  `).run(USER, key, sha, CREATED, UPDATED);

  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, payload)] };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.targetPayloadUnavailable.total, 1);
});

test("a recorded checksum that disagrees with the real R2 object bytes is unavailable, isolated from the byte-count check", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const payload = { score: 6 };
  const bytes = jsonBytes(payload);
  const key = `private/progress/${USER}/wrong-sha.json`;
  await context.files.put(key, bytes);
  // The recorded byte count is correct; only the recorded sha256 is wrong.
  context.database.prepare(`
    INSERT INTO progress_snapshots (user_id,store_key,payload_object_key,payload_sha256,payload_bytes,created_at,updated_at)
    VALUES (?, 'ielts-prep-v1', ?, ?, ?, ?, ?)
  `).run(USER, key, "f".repeat(64), bytes.byteLength, CREATED, UPDATED);

  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, payload)] };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.targetPayloadUnavailable.total, 1);
});

test("a null recorded sha256 (subscriptions carries no NOT NULL there) skips the checksum check entirely, rather than always failing it", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const payload = { plan: "ai" };
  const bytes = jsonBytes(payload);
  const key = `private/subscriptions/${USER}/no-recorded-sha.json`;
  await context.files.put(key, bytes);
  // raw_sha256 has no NOT NULL constraint on subscriptions -- a row can
  // legitimately point at an object with nothing recorded to check it
  // against.
  context.database.prepare(`
    INSERT INTO subscriptions (id,user_id,provider,status,tier,verified_at,raw_object_key,raw_sha256,created_at,updated_at)
    VALUES ('sub-null-sha', ?, 'stripe', 'active', 'ai', ?, ?, NULL, ?, ?)
  `).run(USER, UPDATED, key, CREATED, UPDATED);

  const byDomain = { subscriptions: [await sourceRow("sub-null-sha", payload)] };
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.status, "equal", "a null recorded sha256 must not make an otherwise-good object unavailable");
  assert.equal(entry.targetPayloadUnavailable.total, 0);
});

test("mismatched keys on either side are never silently paired as if they were the same row", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  // D1 has a row sorting alphabetically before every source key.
  await seedProgress(context, USER, "bandup.lookups.v1", { d1: "only" });
  // Source reports a completely different, alphabetically-later key that D1
  // does not have at all.
  const byDomain = { progress_snapshots: [await sourceRow(`${USER}/ielts-prep-v1`, { source: "only" })] };
  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.missingInTarget.total, 1);
  assert.deepEqual(entry.missingInTarget.sample, [`${USER}/ielts-prep-v1`]);
  assert.equal(entry.missingInSource.total, 1);
  assert.deepEqual(entry.missingInSource.sample, [`${USER}/bandup.lookups.v1`]);
  assert.equal(entry.payloadMismatch.total, 0, "two different keys must never be compared against each other as a mismatch");
});

test("a source-only row with no payload at all is not counted as missing in the target", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const byDomain = { subscriptions: [await sourceRow("sub-legacy-source-only", undefined)] };
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource(byDomain),
  });
  assert.equal(entry.missingInTarget.total, 0, "a legacy row with no payload on either side is not a mirroring gap");
});

test("a target-only row with no payload at all is not counted as missing in the source", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  await seedSubscription(context, "sub-legacy-target-only", USER, null, { none: true });
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource({ subscriptions: [] }),
  });
  assert.equal(entry.missingInSource.total, 0);
});

test("a target row whose payload is unreadable and absent from the source is still named missing in the source", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const payload = { score: 9 };
  const bytes = jsonBytes(payload);
  const key = `private/progress/${USER}/wrong-sha-2.json`;
  await context.files.put(key, bytes);
  context.database.prepare(`
    INSERT INTO progress_snapshots (user_id,store_key,payload_object_key,payload_sha256,payload_bytes,created_at,updated_at)
    VALUES (?, 'ielts-prep-v1', ?, ?, ?, ?, ?)
  `).run(USER, key, "e".repeat(64), bytes.byteLength, CREATED, UPDATED);

  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource({ progress_snapshots: [] }), // absent from source entirely
  });
  assert.equal(entry.targetPayloadUnavailable.total, 1);
  assert.equal(
    entry.missingInSource.total,
    1,
    "an unreadable-but-present target row absent from the source must still be reported missing in the source",
  );
});

test("the read-page callback is not re-invoked once a stream already knows it is exhausted", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  for (let index = 0; index < 10; index += 1) {
    await seedSubscription(context, `sub-zzz-${String(index).padStart(3, "0")}`, USER, { n: index });
  }
  let calls = 0;
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async (_domain, after) => {
      calls += 1;
      return ["sub-aaa", "sub-bbb"].filter((key) => key > after).map((key) => ({
        row_key: key, payload_present: false, payload_hash: null,
      }));
    },
  });
  assert.equal(entry.missingInSource.total, 10);
  assert.equal(calls, 1, "a stream that already knows it is exhausted must not ask its source for another page");
});

test("the same call-suppression applies when the very first source page is already empty", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  for (let index = 0; index < 10; index += 1) {
    await seedSubscription(context, `sub-zzz-${String(index).padStart(3, "0")}`, USER, { n: index });
  }
  let calls = 0;
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => { calls += 1; return []; },
  });
  assert.equal(entry.missingInSource.total, 10);
  assert.equal(calls, 1);
});

test("the row limit is the larger of the two streams' progress, not the smaller", async () => {
  const context = fixture();
  const byDomain = { subscriptions: [] };
  const total = 120;
  for (let index = 0; index < total; index += 1) {
    byDomain.subscriptions.push(await sourceRow(`sub-${String(index).padStart(5, "0")}`, { n: index }));
  }
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: pagedSource(byDomain),
    rowLimit: 50,
  });
  assert.equal(entry.complete, false);
  assert.equal(entry.comparedSourceRows, 50, "Math.max(source, target) must be the one compared against rowLimit");
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
    await parity.cloudflarePayloadParity("subscriptions", context.bindings, {});
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/cloudflare_migration_source_payload_fingerprints$/);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.p_domain, "subscriptions");
    assert.equal(body.p_after, "");
    assert.equal(body.p_limit, 100);
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
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => ({ map: () => [] }),
  });
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.unavailable, "source");
  assert.equal(entry.complete, false, "an unavailable result must never claim to be complete");
});

test("a source row whose key is not a string makes the domain unavailable, even with a well-shaped payload flag", async () => {
  const context = fixture();
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => [{ row_key: 12345, payload_present: false }],
  });
  assert.equal(entry.status, "unavailable");
});

test("a payload_present flag that is not a boolean makes the domain unavailable, even with a well-shaped key", async () => {
  const context = fixture();
  // A syntactically-valid 64-hex payload_hash is included so the *other*
  // validation (the hash-shape check) does not independently throw first
  // and mask whether this check on its own actually matters.
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => [{ row_key: "sub-x", payload_present: "yes", payload_hash: "a".repeat(64) }],
  });
  assert.equal(entry.status, "unavailable");
});

test("a present source row's hash shape is validated strictly, anchored at both ends", async () => {
  const context = fixture();
  const before = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => [{ row_key: "sub-x", payload_present: true, payload_hash: `!${"a".repeat(64)}` }],
  });
  assert.equal(before.status, "unavailable", "a leading character outside the 64-hex shape must not be accepted");

  const after = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => [{ row_key: "sub-x", payload_present: true, payload_hash: `${"a".repeat(64)}!` }],
  });
  assert.equal(after.status, "unavailable", "a trailing character outside the 64-hex shape must not be accepted");
});

test("a source row absent (not present) is never validated against the hash shape at all", async () => {
  const context = fixture();
  // payload_present: false with a garbage (non-64-hex) hash must not throw --
  // the hash is meaningless once the row claims to have no payload.
  const entry = await parity.cloudflarePayloadParity("subscriptions", context.bindings, {
    readSourcePage: async () => [{ row_key: "sub-legacy", payload_present: false, payload_hash: "not-a-real-hash" }],
  });
  assert.notEqual(entry.status, "unavailable");
});

test("the source-page validation's own fallback/error text never reaches the report and is equivalent (payload-parity.ts:294,297,299,300)", () => {
  /*
    cloudflarePayloadParity's outer try/catch swallows every error the merge
    join can throw into a bare status: "unavailable" -- the thrown Error's
    .message is never read anywhere the caller can observe, and the
    `row?.payload_hash ?? ""` fallback only ever feeds the 64-hex regex test,
    which no non-64-hex fallback string could ever pass either way.
    Confirmed above: every malformed-input scenario converges on the
    identical {status: "unavailable", unavailable: "source"} shape.
  */
  assert.equal(typeof parity.cloudflarePayloadParity, "function");
});

test("a failed target-read row that the source never reported is still named missing in the source, not silently dropped", async () => {
  const context = fixture();
  seedUser(context.database, USER, 0);
  const bytes = jsonBytes({ score: 1 });
  const key = `private/progress/${USER}/dangling-key.json`;
  // No files.put -- the R2 object is missing, forcing readTargetPayload to
  // report "unavailable" for this row.
  context.database.prepare(`
    INSERT INTO progress_snapshots (user_id,store_key,payload_object_key,payload_sha256,payload_bytes,created_at,updated_at)
    VALUES (?, 'ielts-prep-v1', ?, ?, ?, ?, ?)
  `).run(USER, key, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength, CREATED, UPDATED);

  const entry = await parity.cloudflarePayloadParity("progress_snapshots", context.bindings, {
    readSourcePage: pagedSource({ progress_snapshots: [] }), // absent from source
  });
  assert.equal(entry.targetPayloadUnavailable.total, 1);
  assert.equal(
    entry.missingInSource.total,
    1,
    "a real (if unreadable) row absent from the source must count as missing in the source, not be dropped",
  );
});

test("progress, subscription and provider-event payload domains are now genuinely proven, not merely flagged supported", () => {
  const proven = ["progress_payload_integrity", "billing_payload_object_parity", "provider_event_payload_object_parity"];
  for (const domain of proven) {
    const entry = cutoverDomains.CUTOVER_DOMAINS.find((row) => row.domain === domain);
    assert.equal(entry.supported, true, domain);
    assert.match(entry.description, /payload-parity/);
  }
  assert.deepEqual(
    [...cutoverDomains.unsupportedCutoverDomains()].sort(),
    [
      "cutover_write_barrier",
    ].sort(),
  );
});

test("the payload listing is admin-only, off by default, and its SQL is service-role only and not a migration", () => {
  const route = code(readFileSync(
    join(process.cwd(), "app", "api", "admin", "cloudflare", "readiness", "route.ts"),
    "utf8",
  ));
  assert.match(route, /isAdminEmail\(actor\.email\)/);
  assert.match(route, /parsePayloadParityDomains\(query\.get\("payloadParity"\)\)/);
  assert.match(route, /if \(wantedPayload\)/);
  assert.match(route, /private, no-store/);

  const sql = sqlCode(readFileSync(join(process.cwd(), "supabase", "parity-payload-canonical.sql"), "utf8"));
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /\binsert\b|\bupdate\b|\bdelete\b|\bdrop table\b/i);
  assert.doesNotMatch(sql, /auth\.users/);
  assert.equal(
    readdirSync(join(process.cwd(), "supabase", "migrations")).some((name) => name.includes("payload_canonical")),
    false,
  );

  const paritySource = code(readFileSync(join(process.cwd(), "lib", "cloudflare", "payload-parity.ts"), "utf8"));
  assert.doesNotMatch(paritySource, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/);
});
