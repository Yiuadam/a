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
      VALUES (?, ?, 'stripe', 'active', 'pro', ?, ?, ?)
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
      VALUES (?, ?, 'stripe', 'active', 'pro', ?, ?, ?, ?, ?)
    `).run(id, userId, UPDATED, key, sha, CREATED, UPDATED);
  } else {
    context.database.prepare(`
      INSERT INTO subscriptions (id,user_id,provider,status,tier,verified_at,raw_inline,raw_sha256,created_at,updated_at)
      VALUES (?, ?, 'stripe', 'active', 'pro', ?, ?, ?, ?, ?)
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
  assert.deepEqual(
    parity.parsePayloadParityDomains("subscriptions, progress_snapshots, dropped"),
    ["subscriptions", "progress_snapshots"],
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
      "admin_statistics",
      "admin_user_directory",
      "avatar_object_parity",
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
