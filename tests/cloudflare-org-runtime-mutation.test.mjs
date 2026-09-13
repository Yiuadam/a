/*
  Mutation-kill tests for lib/cloudflare's org-portal runtime, the account-
  deletion cascade, and the org attempt-object/discovery helpers -- see
  scripts/mutation/survivors.mjs for the mutants this targets.

  Real in-memory D1 (freshD1/runtimeD1 from lib-auth-mutation-helpers.mjs) is
  used wherever a function runs real SQL against the real schema: an emptied
  SQL template throws the moment it is actually prepared/run, and boundary or
  guard conditions are pinned down by seeding rows on both sides of the line.
  Hand-rolled fake bindings are used only where a specific call sequence, or a
  side effect injected mid-call, needs to be controlled directly.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { freshD1, runtimeD1, fakeR2, withBrowserWindow } from "./lib-auth-mutation-helpers.mjs";

register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const adminOrgAccess = await load("lib", "cloudflare", "admin-organization-access.ts");
const discovery = await load("lib", "cloudflare", "organization-discovery.ts");
const attemptObjects = await load("lib", "cloudflare", "organization-attempt-objects.ts");
const accountDeletion = await load("lib", "cloudflare", "account-deletion.ts");
const organizations = await load("lib", "cloudflare", "organizations.ts");

/** cloudflareOrganizationDiscovery has no providedBindings seam -- it always
    calls requireBandUpCloudflareBindings() itself, so reaching it needs the
    same getCloudflareContext() stub tests/organizations-server-dispatch.test.mjs
    uses, not a plain argument. */
async function withCloudflareContext(env, fn) {
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env };
  try {
    return await fn();
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
}

/** A 36-char, hex-and-hyphen, UUID-shaped string -- distinct per n. */
function validUuid(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/* ============================================================ admin-organization-access.ts */

test("cloudflareAdminOrganizationSeats keeps only well-shaped ids (both anchors), dedupes, keeps order", async () => {
  const bindings = {
    db: { prepare: () => ({ bind: () => ({ async all() { return { results: [] }; } }) }) },
  };
  const a = validUuid(1);
  const b = validUuid(2);
  // Neither anchor alone would reject these: a bare '$' anchor lets a valid
  // 36-char run *ending* the string through even with junk before it, and a
  // bare '^' anchor lets one *starting* the string through with junk after.
  const prefixGarbage = "Z".repeat(4) + "a".repeat(36);
  const suffixGarbage = "a".repeat(36) + "Z".repeat(4);
  const result = await adminOrgAccess.cloudflareAdminOrganizationSeats(
    [b, "abc", a, b, prefixGarbage, suffixGarbage, a],
    bindings,
  );
  assert.deepEqual([...result.keys()], [b, a]);
});

test("cloudflareAdminOrganizationSeats caps distinct ids at MAX_USERS (100), keeping the first ones", async () => {
  const bindings = {
    db: { prepare: () => ({ bind: () => ({ async all() { return { results: [] }; } }) }) },
  };
  const ids = Array.from({ length: 105 }, (_, i) => validUuid(i));
  const result = await adminOrgAccess.cloudflareAdminOrganizationSeats(ids, bindings);
  assert.equal(result.size, 100);
  assert.deepEqual([...result.keys()], ids.slice(0, 100));
});

test("cloudflareAdminOrganizationSeats really calls assertServerOnly with its own module name", async () => {
  await withBrowserWindow(async () => {
    await assert.rejects(
      () => adminOrgAccess.cloudflareAdminOrganizationSeats([], {}),
      (error) => {
        assert.equal(
          error.message,
          "lib/cloudflare/admin-organization-access.ts is server-only and must not be imported from a client component.",
        );
        return true;
      },
    );
  });
});

test("an empty (or fully invalid) user id list never touches the database", async () => {
  let called = false;
  const bindings = {
    db: {
      prepare() {
        called = true;
        return { bind: () => ({ async all() { return { results: [] }; } }) };
      },
    },
  };
  const result = await adminOrgAccess.cloudflareAdminOrganizationSeats(["not-a-uuid"], bindings);
  assert.equal(result.size, 0);
  assert.equal(called, false);
});

/* ============================================================ organization-discovery.ts */

function freshDiscoveryDb() {
  const database = freshD1();
  const now = "2026-01-01T00:00:00.000Z";
  const owner = validUuid(9000);
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)
  `).run(owner, "discovery-owner@example.com", now, now);
  return { database, owner, now };
}

function seedOrg(database, owner, now, { id, name, status = "active" }) {
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, ?, NULL, ?, ?, ?, ?)
  `).run(id, name, status, owner, now, now);
}

function discoveryEnv(database) {
  return { BANDUP_DB: runtimeD1(database), BANDUP_FILES: fakeR2(), EMAIL: undefined };
}

test("organization search trims, collapses internal whitespace runs, and escapes LIKE wildcards", async () => {
  const { database, owner, now } = freshDiscoveryDb();
  seedOrg(database, owner, now, { id: validUuid(1), name: "Alpha Beta" });
  // Two consecutive tabs is one whitespace *run*: /\s+/g collapses it to one
  // space, unlike /\s/g (each char alone) or /\S+/g (the non-space runs).
  // Leading/trailing spaces additionally probe .trim() being dropped.
  await withCloudflareContext(discoveryEnv(database), async () => {
    const response = await discovery.cloudflareOrganizationDiscovery(
      { id: validUuid(2), email: "actor@example.com" },
      false,
      "organization",
      "  Alpha\t\tBeta  ",
    );
    assert.deepEqual(response.results.map((r) => r.name), ["Alpha Beta"]);
  });

  // A literal underscore in the query must not act as a SQL "any one char"
  // wildcard: only the organisation whose name really contains "A_B" (not
  // "AXB", which an unescaped "_" would also match) may come back.
  const database2 = freshDiscoveryDb();
  seedOrg(database2.database, database2.owner, database2.now, { id: validUuid(3), name: "AXB" });
  seedOrg(database2.database, database2.owner, database2.now, { id: validUuid(4), name: "AB" });
  seedOrg(database2.database, database2.owner, database2.now, { id: validUuid(5), name: "A_B" });
  await withCloudflareContext(discoveryEnv(database2.database), async () => {
    const response = await discovery.cloudflareOrganizationDiscovery(
      { id: validUuid(6), email: "actor2@example.com" },
      false,
      "organization",
      "A_B",
    );
    assert.deepEqual(response.results.map((r) => r.name), ["A_B"]);
  });

  // SQLite's LIKE is case-insensitive for ASCII by default but NOT for
  // non-ASCII characters, and its lower() leaves them untouched too -- so
  // lowercasing the query (not uppercasing it) is what makes an accented
  // match work at all. A café/CAFÉ pair only matches through the correct
  // direction of that case fold.
  const database3 = freshDiscoveryDb();
  seedOrg(database3.database, database3.owner, database3.now, { id: validUuid(8), name: "Café Org" });
  await withCloudflareContext(discoveryEnv(database3.database), async () => {
    const response = await discovery.cloudflareOrganizationDiscovery(
      { id: validUuid(9), email: "actor4@example.com" },
      false,
      "organization",
      "café",
    );
    assert.deepEqual(response.results.map((r) => r.name), ["Café Org"]);
  });
});

test("organization search query length must be within [2, 80] after trim/collapse", async () => {
  // An org name under 2 chars can't even be stored (its own CHECK constraint
  // requires 2-120), so "did a matching row come back" can't observe a
  // length-1 query being wrongly accepted. Instead watch whether the name
  // search SQL runs at all -- that is exactly what the length gate decides.
  const lengths = [1, 2, 80, 81];
  for (const length of lengths) {
    let searched = false;
    const db = {
      prepare(sql) {
        return {
          bind: () => ({
            async first() { return null; },
            async all() {
              if (sql.includes("FROM organizations o")) searched = true;
              return { results: [] };
            },
          }),
        };
      },
    };
    await withCloudflareContext({ BANDUP_DB: db, BANDUP_FILES: fakeR2(), EMAIL: undefined }, async () => {
      await discovery.cloudflareOrganizationDiscovery(
        { id: validUuid(7), email: "actor3@example.com" },
        false,
        "organization",
        "Q".repeat(length),
      );
    });
    const shouldSearch = length >= 2 && length <= 80;
    assert.equal(searched, shouldSearch, `length ${length} should ${shouldSearch ? "" : "not "}reach the DB search`);
  }
});

test("user search is gated by requester role, and only a real hit is returned", async () => {
  const { database, owner, now } = freshDiscoveryDb();
  const org = validUuid(20);
  seedOrg(database, owner, now, { id: org, name: "Gate Test Org" });

  const targetUser = validUuid(21);
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)
  `).run(targetUser, "target@example.com", now, now);
  database.prepare(`INSERT INTO usernames (user_id, username, created_at) VALUES (?, ?, ?)`)
    .run(targetUser, "targetuser", now);

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status, share_future_history,
      share_pre_join_history, joined_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?)
  `);

  const cases = [
    { role: null, platformAdmin: false, allowed: false, label: "no membership" },
    { role: "student", platformAdmin: false, allowed: false, label: "student" },
    { role: "teacher", platformAdmin: false, allowed: true, label: "teacher" },
    { role: "manager", platformAdmin: false, allowed: true, label: "manager" },
    { role: "owner", platformAdmin: false, allowed: true, label: "owner" },
    { role: null, platformAdmin: true, allowed: true, label: "platform admin, no membership" },
  ];

  await withCloudflareContext(discoveryEnv(database), async () => {
    for (const [index, testCase] of cases.entries()) {
      const actor = validUuid(30 + index);
      database.prepare(`
        INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)
      `).run(actor, `actor-${index}@example.com`, now, now);
      if (testCase.role) {
        insertMembership.run(
          validUuid(200 + index), org, actor, testCase.role, now, now, now,
        );
      }
      const response = await discovery.cloudflareOrganizationDiscovery(
        { id: actor, email: `actor-${index}@example.com` },
        testCase.platformAdmin,
        "user",
        "targetuser",
        org,
      );
      assert.equal(
        response.results.length,
        testCase.allowed ? 1 : 0,
        `${testCase.label}: expected ${testCase.allowed ? "a hit" : "no hit"}`,
      );
      if (testCase.allowed) {
        assert.equal(response.results[0].userId, targetUser);
      }
    }
  });
});

test("an invalid username query is rejected before any role or DB lookup runs", async () => {
  const { database, owner, now } = freshDiscoveryDb();
  const org = validUuid(40);
  seedOrg(database, owner, now, { id: org, name: "Invalid Query Org" });
  await withCloudflareContext(discoveryEnv(database), async () => {
    // "@" makes normaliseUsername return null regardless of role/admin.
    const response = await discovery.cloudflareOrganizationDiscovery(
      { id: validUuid(41), email: "actor@example.com" },
      true,
      "user",
      "not@a-username",
      org,
    );
    assert.deepEqual(response.results, []);
  });
});

/* ============================================================ organization-attempt-objects.ts */

const ATTEMPT_USER = validUuid(500);

function objectKey(userId, marker) {
  return `private/attempts/${userId}/${marker}${"a".repeat(Math.max(0, 64 - marker.length))}.json`;
}

test("safeAttemptObjectKey rejects a wrong owner prefix and anything past 1024 chars", async () => {
  const seen = { referencedQueries: [] };
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) seen.referencedQueries.push(values);
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: { async delete(keys) { seen.deleted = keys; } },
  };

  const good = objectKey(ATTEMPT_USER, "good-");
  const wrongOwner = objectKey(validUuid(501), "wrong-owner-");
  const tooLong = `private/attempts/${ATTEMPT_USER}/${"x".repeat(1100)}.json`;
  assert.ok(good.length <= 1024 && tooLong.length > 1024);

  await attemptObjects.retireOrganizationAttemptObjects(
    bindings, ATTEMPT_USER, [good, wrongOwner, tooLong, null, undefined],
  );
  assert.equal(seen.referencedQueries.length, 1);
  // Only the owner-prefixed, <=1024-char key may reach the reference check.
  const boundKeys = seen.referencedQueries[0].slice(0, seen.referencedQueries[0].length / 2);
  assert.deepEqual(boundKeys, [good]);
});

test("safeAttemptObjectKey's 1024-char length cap is inclusive", async () => {
  const prefix = `private/attempts/${ATTEMPT_USER}/`;
  const exactly1024 = prefix + "y".repeat(1024 - prefix.length);
  const exactly1025 = prefix + "y".repeat(1025 - prefix.length);
  assert.equal(exactly1024.length, 1024);
  assert.equal(exactly1025.length, 1025);

  let queried1024 = false;
  const bindings1024 = {
    db: {
      prepare(sql) {
        return { bind: () => ({ async all() { if (sql.includes("SELECT result_object_key")) queried1024 = true; return { results: [] }; } }) };
      },
      async batch() { return []; },
    },
    files: { async delete() {} },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings1024, ATTEMPT_USER, [exactly1024]);
  assert.equal(queried1024, true, "exactly 1024 chars must be accepted (<=, not <)");

  let queried1025 = false;
  const bindings1025 = {
    db: {
      prepare(sql) {
        return { bind: () => ({ async all() { if (sql.includes("SELECT result_object_key")) queried1025 = true; return { results: [] }; } }) };
      },
      async batch() { return []; },
    },
    files: { async delete() {} },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings1025, ATTEMPT_USER, [exactly1025]);
  assert.equal(queried1025, false, "1025 chars must be rejected");
});

test("retireOrganizationAttemptObjects checks every candidate across REFERENCE_CHUNK pages, not only the first", async () => {
  const total = 85; // > 2 * REFERENCE_CHUNK(40), forces three pages of [40, 40, 5]
  const keys = Array.from({ length: total }, (_, i) => objectKey(ATTEMPT_USER, `k${i}-`));
  const referenced = new Set([keys[0], keys[40], keys[84]]); // one per page
  const queriedKeys = new Set();
  const pageSizes = [];
  const deleted = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) {
                const page = values.slice(0, values.length / 2);
                pageSizes.push(page.length);
                for (const key of page) queriedKeys.add(key);
                return { results: page.filter((k) => referenced.has(k)).map((object_key) => ({ object_key })) };
              }
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: { async delete(keys) { deleted.push(...keys); } },
  };

  const result = await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.equal(result, true);
  // Exact per-call page sizes -- not just the union -- so a removed slice()
  // (which would re-send all 85 candidates on every call instead of a 40-page)
  // or a flipped offset +/- REFERENCE_CHUNK cannot hide behind the total count.
  assert.deepEqual(pageSizes, [40, 40, 5]);
  assert.equal(queriedKeys.size, total);
  assert.equal(deleted.length, total - referenced.size);
  for (const key of referenced) assert.ok(!deleted.includes(key));
});

test("referencedKeys' loop boundary is an exact '<', not '<=': no trailing empty-page call", async () => {
  const total = 80; // an exact multiple of REFERENCE_CHUNK(40)
  const keys = Array.from({ length: total }, (_, i) => objectKey(ATTEMPT_USER, `e${i}-`));
  let queryCalls = 0;
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: () => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) queryCalls += 1;
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: { async delete() {} },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.equal(queryCalls, 2); // exactly [40, 40] -- a third, empty-page call would mean '<=' crept in
});

test("referencedKeys' IN(...) placeholder list has one '?' per key in the page, comma-joined", async () => {
  const keys = [objectKey(ATTEMPT_USER, "m0-"), objectKey(ATTEMPT_USER, "m1-"), objectKey(ATTEMPT_USER, "m2-")];
  let capturedSql = null;
  const bindings = {
    db: {
      prepare(sql) {
        if (sql.includes("SELECT result_object_key")) capturedSql = sql;
        return { bind: () => ({ async all() { return { results: [] }; } }) };
      },
    },
    files: { async delete() {} },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.ok(capturedSql, "the reference-check query must have run");
  assert.match(capturedSql, /IN \(\?,\?,\?\)/);
});

test("forgetCleanupRows chunks its DELETE across REFERENCE_CHUNK, and its own IN(...) list matches the page", async () => {
  // 41 *referenced* keys forces forgetCleanupRows into two chunks (40 + 1),
  // and keeps R2 delete out of the picture entirely (nothing is orphaned).
  const total = 41;
  const keys = Array.from({ length: total }, (_, i) => objectKey(ATTEMPT_USER, `l${i}-`));
  const forgotten = new Set();
  const deletePageSizes = [];
  let capturedInClause = null;
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) {
                const page = values.slice(0, values.length / 2);
                return { results: page.map((object_key) => ({ object_key })) }; // everything is referenced
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("DELETE FROM organization_attempt_object_cleanup")) {
                deletePageSizes.push(values.length);
                for (const key of values) forgotten.add(key);
                if (values.length === 3) capturedInClause = sql; // probe call, see below
              }
              return { success: true, meta: { changes: 1 } };
            },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: { async delete() { throw new Error("must not be called: nothing is orphaned"); } },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.deepEqual(deletePageSizes, [40, 1]);
  assert.equal(forgotten.size, total);

  // A separate, small probe to read the exact IN(...) shape forgetCleanupRows
  // builds for a page of 3 -- independent of the 41-key chunking above.
  const probeKeys = [objectKey(ATTEMPT_USER, "p0-"), objectKey(ATTEMPT_USER, "p1-"), objectKey(ATTEMPT_USER, "p2-")];
  const probeBindings = {
    db: {
      prepare(sql) {
        return {
          bind: () => ({
            async all() { return { results: probeKeys.map((object_key) => ({ object_key })) }; },
            async run() {
              if (sql.includes("DELETE FROM organization_attempt_object_cleanup")) capturedInClause = sql;
              return { success: true, meta: { changes: 1 } };
            },
          }),
        };
      },
    },
    files: { async delete() { throw new Error("must not be called"); } },
  };
  await attemptObjects.retireOrganizationAttemptObjects(probeBindings, ATTEMPT_USER, probeKeys);
  assert.match(capturedInClause, /IN \(\?,\?,\?\)/);
});

test("forgetCleanupRows' loop boundary is an exact '<': no trailing empty-page DELETE at a chunk-exact count", async () => {
  const total = 80; // an exact multiple of REFERENCE_CHUNK(40) -- 41 above never hits offset===length
  const keys = Array.from({ length: total }, (_, i) => objectKey(ATTEMPT_USER, `b${i}-`));
  let deleteCalls = 0;
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) {
                const page = values.slice(0, values.length / 2);
                return { results: page.map((object_key) => ({ object_key })) }; // everything referenced
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("DELETE FROM organization_attempt_object_cleanup")) deleteCalls += 1;
              return { success: true, meta: { changes: 1 } };
            },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: { async delete() { throw new Error("must not be called"); } },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.equal(deleteCalls, 2); // exactly [40, 40] -- a third, empty-page DELETE would mean '<=' crept in
});

test("a candidate list that is empty after validation short-circuits to true, untouched by the database", async () => {
  let dbTouched = false;
  const bindings = {
    db: {
      prepare() { dbTouched = true; return { bind: () => ({ async all() { return { results: [] }; } }) }; },
      async batch() { dbTouched = true; return []; },
    },
    files: { async delete() { throw new Error("must not be called"); } },
  };
  // Every one of these fails safeAttemptObjectKey (wrong type, wrong owner, or
  // too long), so the candidate set is empty before any I/O.
  const wrongOwner = objectKey(validUuid(9999), "other-owner-");
  const result = await attemptObjects.retireOrganizationAttemptObjects(
    bindings, ATTEMPT_USER, [null, undefined, 42, wrongOwner],
  );
  assert.equal(result, true);
  assert.equal(dbTouched, false);
});

test("an all-live candidate set never calls R2 delete at all", async () => {
  const keys = [objectKey(ATTEMPT_USER, "alllive-")];
  let deleteCalled = false;
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: () => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) {
                return { results: [{ object_key: keys[0] }] }; // referenced -> live, none orphaned
              }
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: { async delete() { deleteCalled = true; } },
  };
  const result = await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.equal(result, true);
  assert.equal(deleteCalled, false);
});

test("safeAttemptObjectKey's owner segment is sanitised and capped at 180 characters", async () => {
  // A userId with characters outside [A-Za-z0-9._-] must be replaced with "_"
  // (not dropped), and the sanitised owner segment is capped at 180 chars --
  // both only observable through the exact prefix a real key must match.
  const weirdUserId = "weird user/id:with*punct" + "Z".repeat(200); // 24-char prefix + 200 "Z"s
  const safeOwner = "weird_user_id_with_punct" + "Z".repeat(156); // 24 + 156 = 180, "Z" is untouched
  assert.equal(safeOwner.length, 180);
  const key = `private/attempts/${safeOwner}/result.json`;

  let queried = false;
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: () => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) queried = true;
              return { results: [] };
            },
          }),
        };
      },
      async batch() { return []; },
    },
    files: { async delete() {} },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindings, weirdUserId, [key]);
  assert.equal(queried, true, "a key under the sanitised+truncated owner prefix must be accepted");

  // The untruncated prefix (181+ chars) must be rejected as a different owner.
  const untruncatedOwner = "weird_user_id_with_punct" + "Z".repeat(200);
  const wrongKey = `private/attempts/${untruncatedOwner}/result.json`;
  let queriedWrong = false;
  const bindingsWrong = {
    db: {
      prepare(sql) {
        return {
          bind: () => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) queriedWrong = true;
              return { results: [] };
            },
          }),
        };
      },
      async batch() { return []; },
    },
    files: { async delete() {} },
  };
  await attemptObjects.retireOrganizationAttemptObjects(bindingsWrong, weirdUserId, [wrongKey]);
  assert.equal(queriedWrong, false, "an owner segment past 180 chars must not itself be treated as the prefix");
});

test("a failed reference lookup queues durable cleanup for every candidate, across pages", async () => {
  const total = 45; // > REFERENCE_CHUNK(40), forces two pages
  const keys = Array.from({ length: total }, (_, i) => objectKey(ATTEMPT_USER, `f${i}-`));
  const queuedKeys = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: () => ({
            async all() {
              if (sql.includes("SELECT result_object_key")) throw new Error("D1 unavailable");
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) {
        queuedKeys.push(statements.length);
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
    files: { async delete() { throw new Error("must not be called"); } },
  };
  const result = await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, keys);
  assert.equal(result, false);
  assert.equal(queuedKeys.reduce((a, b) => a + b, 0), total);
});

test("retryAt's exponential backoff and its one-hour cap both bind the exact expected timestamp", async () => {
  const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
  const inserted = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            sql,
            values,
            async all() { return { results: [] }; }, // nothing referenced -> orphaned
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) {
        for (const statement of statements) inserted.push(statement);
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
    files: { async delete() { throw new Error("R2 down"); } },
  };
  const key = objectKey(ATTEMPT_USER, "retry-");
  await attemptObjects.retireOrganizationAttemptObjects(bindings, ATTEMPT_USER, [key], nowMs);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].sql, /INSERT INTO organization_attempt_object_cleanup/);
  const bound = inserted[0].values;
  // INSERT ... VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT ... SET available_at = ?, updated_at = ?
  // -> [object_key, user_id, retryAt(nowMs,1), createdAt, createdAt, retryAt(nowMs,2), createdAt]
  const firstAvailableAt = bound[2];
  const conflictAvailableAt = bound[5];
  assert.equal(firstAvailableAt, new Date(nowMs + 30 * 1000).toISOString()); // 15 * 2**1 = 30s
  assert.equal(conflictAvailableAt, new Date(nowMs + 60 * 1000).toISOString()); // 15 * 2**2 = 60s
});

test("reconcileOrganizationAttemptObjects clamps its limit and counts failures per due row", async () => {
  const dueRows = [
    { object_key: objectKey(ATTEMPT_USER, "due0-"), user_id: ATTEMPT_USER },
    { object_key: objectKey(ATTEMPT_USER, "due1-"), user_id: ATTEMPT_USER },
  ];
  const boundLimits = [];
  const deleteAttempts = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            async all() {
              if (sql.includes("FROM organization_attempt_object_cleanup")) {
                boundLimits.push(values[values.length - 1]);
                return { results: dueRows };
              }
              if (sql.includes("SELECT result_object_key")) return { results: [] }; // orphaned
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          }),
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    },
    files: {
      async delete(keys) {
        deleteAttempts.push(keys);
        if (keys[0] === dueRows[1].object_key) throw new Error("R2 failure for due1");
      },
    },
  };

  const result = await attemptObjects.reconcileOrganizationAttemptObjects(bindings, { limit: 999, nowMs: Date.now() });
  assert.equal(boundLimits[0], 100); // Math.min(CLEANUP_LIMIT=100, Math.trunc(999))
  assert.equal(result.selected, 2);
  assert.equal(result.remainingFailures, 1);
  // Each due row is retired with *only its own* key, one R2 call per row.
  assert.deepEqual(deleteAttempts, [[dueRows[0].object_key], [dueRows[1].object_key]]);

  boundLimits.length = 0;
  await attemptObjects.reconcileOrganizationAttemptObjects(bindings, { limit: 0, nowMs: Date.now() });
  assert.equal(boundLimits[0], 1); // Math.max(1, Math.trunc(0))
});

/* ============================================================ account-deletion.ts */

function adUser(n) {
  return validUuid(20000 + n);
}

function freshAccountDeletionDb() {
  const database = freshD1();
  return { database, bindings: { db: runtimeD1(database), files: fakeR2Listable() } };
}

function seedAppUser(database, userId, nowIso, email) {
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)
  `).run(userId, email ?? `${userId}@example.com`, nowIso, nowIso);
}

/** A controllable R2 fake: list() answers per-prefix pages, delete() records every call. */
function fakeR2Listable(pagesByPrefix = {}) {
  const deleteCalls = [];
  return {
    deleteCalls,
    async put() {},
    async get() { return null; },
    async delete(keys) { deleteCalls.push(Array.isArray(keys) ? [...keys] : [keys]); },
    async list({ prefix, cursor }) {
      const pages = pagesByPrefix[prefix] ?? [];
      const index = cursor ? Number(cursor) : 0;
      const page = pages[index] ?? { keys: [] };
      const hasNext = index + 1 < pages.length;
      return {
        objects: page.keys.map((key) => ({ key })),
        truncated: hasNext,
        cursor: hasNext ? String(index + 1) : undefined,
      };
    },
  };
}

test("CloudflareAccountDeletionInProgressError names itself, and the prepare lease is exactly ten minutes", async () => {
  assert.equal(new accountDeletion.CloudflareAccountDeletionInProgressError().name, "CloudflareAccountDeletionInProgressError");

  const { database, bindings } = freshAccountDeletionDb();
  const nowIso = "2026-01-01T00:00:00.000Z";
  const userId = adUser(1);
  seedAppUser(database, userId, nowIso);

  const before = Date.now();
  const prepared = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
  const after = Date.now();
  const row = database.prepare("SELECT lease_expires_at FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
  const leaseMs = Date.parse(row.lease_expires_at);
  // Exactly PREPARE_LEASE_MS (10 * 60 * 1000 = 600000ms) after the moment
  // leaseExpiry() ran -- not 1 minute (10*60 mutated), not near-zero
  // (10*60*1000 mutated to /1000), and not in the past (+ mutated to -).
  assert.ok(leaseMs >= before + 600000 && leaseMs <= after + 600000, `lease should be ~10min ahead, got ${row.lease_expires_at}`);
  assert.equal(prepared.state, "prepared");
});

test("safeObjectKey requires a private/ *prefix* (not suffix) with a length capped at 1024", async () => {
  const { database, bindings } = freshAccountDeletionDb();
  const nowIso = "2026-01-01T00:00:00.000Z";
  const userId = adUser(2);
  seedAppUser(database, userId, nowIso);

  const good = "private/attempts/keep-me.json";
  const suffixOnly = "something/private/"; // ends with, but does not start with, "private/"
  const exactly1024 = "private/attempts/" + "z".repeat(1024 - "private/attempts/".length);
  const exactly1025 = "private/attempts/" + "z".repeat(1025 - "private/attempts/".length);
  assert.equal(exactly1024.length, 1024);
  assert.equal(exactly1025.length, 1025);

  bindings.files = fakeR2Listable({
    [`private/avatars/${userId}/`]: [{ keys: [good, suffixOnly, exactly1024, exactly1025] }],
  });
  await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
  const kept = database.prepare("SELECT object_key FROM account_deletion_objects WHERE user_id = ? ORDER BY object_key")
    .all(userId).map((r) => r.object_key);
  assert.deepEqual(kept, [exactly1024, good].sort());
});

test("cloudflareAccountDeletionJob resolves every DELETION_JOB_COLUMNS field, and null for no row", async () => {
  const { database, bindings } = freshAccountDeletionDb();
  const nowIso = "2026-02-01T00:00:00.000Z";
  const userId = adUser(3);
  seedAppUser(database, userId, nowIso);
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, prepared_at, lease_expires_at,
      auth_delete_started_at, auth_deleted_at, objects_discovered, objects_deleted, updated_at
    ) VALUES (?, 'op-job-0000000001', 'auth_delete_started', 'cloudflare', ?, ?, ?, NULL, 3, 1, ?)
  `).run(userId, nowIso, nowIso, nowIso, nowIso);

  const job = await accountDeletion.cloudflareAccountDeletionJob(userId, bindings);
  assert.deepEqual(job, {
    userId,
    operationId: "op-job-0000000001",
    state: "auth_delete_started",
    authAuthority: "cloudflare",
    preparedAt: nowIso,
    authDeleteStartedAt: nowIso,
    authDeletedAt: null,
    dataDeletedAt: null,
    completedAt: null,
    lastErrorCode: null,
    objectsDiscovered: 3,
    objectsDeleted: 1,
    updatedAt: nowIso,
  });
  assert.equal(await accountDeletion.cloudflareAccountDeletionJob(adUser(999), bindings), null);
});

test("pendingCloudflareAccountDeletionJobs clamps its limit, excludes completed jobs, oldest-updated first", async () => {
  const { database, bindings } = freshAccountDeletionDb();
  const rows = [
    { n: 10, state: "prepared", updated: "2026-01-01T00:00:03.000Z" },
    { n: 11, state: "auth_delete_started", updated: "2026-01-01T00:00:01.000Z" },
    { n: 12, state: "complete", updated: "2026-01-01T00:00:02.000Z" }, // excluded
  ];
  for (const row of rows) {
    const userId = adUser(row.n);
    seedAppUser(database, userId, row.updated);
    const completedAt = row.state === "complete" ? row.updated : null;
    const pastPrepared = row.state === "prepared" ? null : row.updated;
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, prepared_at, lease_expires_at,
        auth_delete_started_at, auth_deleted_at, data_deleted_at, completed_at, updated_at
      ) VALUES (?, ?, ?, 'supabase', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, `op-pending-test-${row.n}`, row.state, row.updated, row.updated,
      pastPrepared, pastPrepared,
      row.state === "complete" ? row.updated : pastPrepared,
      completedAt, row.updated,
    );
  }
  const pending = await accountDeletion.pendingCloudflareAccountDeletionJobs(100, bindings);
  assert.deepEqual(
    pending.map((job) => job.operationId),
    ["op-pending-test-11", "op-pending-test-10"], // oldest updated_at first, complete excluded
  );

  // Math.min(500, Math.max(1, Math.trunc(limit))) -- both directions of the clamp.
  const limited = await accountDeletion.pendingCloudflareAccountDeletionJobs(1, bindings);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].operationId, "op-pending-test-11");

  const clampedLow = await accountDeletion.pendingCloudflareAccountDeletionJobs(-5, bindings);
  assert.equal(clampedLow.length, 1); // Math.max(1, ...) floors a non-positive limit to 1
});

test("cloudflareNativeAccountState distinguishes exists, deleted, and unknown", async () => {
  const { database, bindings } = freshAccountDeletionDb();
  const nowIso = "2026-01-01T00:00:00.000Z";
  const alive = adUser(30);
  const deleted = adUser(31);
  seedAppUser(database, alive, nowIso);
  seedAppUser(database, deleted, nowIso);
  database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?").run(nowIso, deleted);

  assert.equal(await accountDeletion.cloudflareNativeAccountState(alive, bindings), "exists");
  assert.equal(await accountDeletion.cloudflareNativeAccountState(deleted, bindings), "deleted");
  assert.equal(await accountDeletion.cloudflareNativeAccountState(adUser(999), bindings), "deleted"); // no row -> treated as deleted, not unknown

  // A DB that cannot even be asked (app_users missing) -> caught -> "unknown".
  const brokenDb = new (Object.getPrototypeOf(database).constructor)(":memory:");
  const unknownBindings = { db: runtimeD1(brokenDb), files: fakeR2() };
  assert.equal(await accountDeletion.cloudflareNativeAccountState(alive, unknownBindings), "unknown");
});

test("prepareCloudflareAccountDeletion: conflict paths (different state, expired-lease takeover, live-lease refusal) and failure rollback", async () => {
  const nowIso = "2026-04-01T00:00:00.000Z";

  // 1) A conflicting row in a *different* state returns that state directly,
  //    without ever running captureReferencedObjects (no manifest is built).
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(40);
    seedAppUser(database, userId, nowIso);
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, auth_delete_started_at,
        auth_deleted_at, prepared_at, lease_expires_at, updated_at
      ) VALUES (?, 'op-already-started-1', 'auth_delete_started', 'cloudflare', ?, ?, ?, ?, ?)
    `).run(userId, nowIso, nowIso, nowIso, nowIso, nowIso);
    const result = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
    assert.deepEqual(result, { operationId: "op-already-started-1", state: "auth_delete_started", authAuthority: "cloudflare" });
    const total = database.prepare("SELECT count(*) AS c FROM account_deletion_objects WHERE user_id = ?").get(userId).c;
    assert.equal(total, 0, "an existing non-prepared job must not trigger a fresh manifest capture");
  }

  // 2) A "prepared" row whose lease already expired is taken over: the new
  //    operation id wins, and preparation proceeds (with a real manifest).
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(41);
    seedAppUser(database, userId, nowIso);
    const expiredLease = "2020-01-01T00:00:00.000Z"; // long past
    // One real referenced object, so objects_discovered must reflect it and
    // not silently become 0 (manifest?.total ?? 0, not manifest?.total && 0).
    // Seeded *before* the tombstone row: the deletion-in-progress triggers
    // block writing learner_profiles once a tombstone already exists.
    database.prepare(`
      INSERT INTO learner_profiles (user_id, avatar_object_key, updated_at) VALUES (?, ?, ?)
    `).run(userId, `private/avatars/${userId}/pic.jpg`, nowIso);
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, prepared_at, lease_expires_at, updated_at
      ) VALUES (?, 'op-stale-prepare-1', 'prepared', 'supabase', ?, ?, ?)
    `).run(userId, nowIso, expiredLease, nowIso);

    const result = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u2@example.com" }, bindings);
    assert.equal(result.state, "prepared");
    assert.notEqual(result.operationId, "op-stale-prepare-1");
    const row = database.prepare("SELECT operation_id, objects_discovered FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
    assert.equal(row.operation_id, result.operationId);
    assert.equal(row.objects_discovered, 1);
  }

  // 3) A "prepared" row whose lease has NOT expired refuses the takeover.
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(42);
    seedAppUser(database, userId, nowIso);
    const futureLease = "2099-01-01T00:00:00.000Z";
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, prepared_at, lease_expires_at, updated_at
      ) VALUES (?, 'op-live-lease-00001', 'prepared', 'supabase', ?, ?, ?)
    `).run(userId, nowIso, futureLease, nowIso);
    await assert.rejects(
      () => accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u3@example.com" }, bindings),
      accountDeletion.CloudflareAccountDeletionInProgressError,
    );
  }

  // 4) A failure while building the manifest cancels the freshly-prepared row.
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(43);
    seedAppUser(database, userId, nowIso);
    bindings.files = { ...fakeR2Listable(), async list() { throw new Error("R2 listing is down"); } };
    await assert.rejects(
      () => accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u4@example.com" }, bindings),
      /R2 listing is down/,
    );
    const row = database.prepare("SELECT * FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
    assert.equal(row, undefined, "a failed preparation must cancel (delete) its own tombstone row");
  }

  // 5) The insert reports a conflict, but the row is gone by the time it is
  //    re-read (a genuine race the real schema can't reproduce sequentially,
  //    so this uses a hand-scripted fake db instead of real D1).
  {
    const userId = adUser(44);
    const db = {
      async batch() { return []; },
      prepare(sql) {
        return {
          bind: () => ({
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO account_deletion_tombstones")) {
                return { success: true, meta: { changes: 0 } }; // conflict
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              if (sql.includes("FROM account_deletion_tombstones")) return null; // vanished
              return null;
            },
            async all() { return { results: [] }; },
          }),
        };
      },
    };
    await assert.rejects(
      () => accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u5@example.com" }, { db, files: fakeR2Listable() }),
      /Cloudflare account deletion state is unavailable/,
    );
  }

  // 6) The manifest capture itself succeeds, but something else advanced the
  //    tombstone away from "prepared" before the final lease-refresh update
  //    runs -- simulated by a side effect inside the R2 listing call, which
  //    executes strictly before that update in the real function's order.
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(45);
    seedAppUser(database, userId, nowIso);
    let sideEffectApplied = false;
    bindings.files = {
      ...fakeR2Listable(),
      async list() {
        if (!sideEffectApplied) {
          sideEffectApplied = true;
          database.prepare(`
            UPDATE account_deletion_tombstones SET state = 'auth_delete_started', auth_delete_started_at = ?
             WHERE user_id = ?
          `).run(nowIso, userId);
        }
        return { objects: [], truncated: false, cursor: undefined };
      },
    };
    await assert.rejects(
      () => accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u6@example.com" }, bindings),
      /lost its lease/,
    );
  }
});

test("reopenCloudflareNativeAccountDeletion only reopens a Cloudflare-authority job stuck in auth_delete_started", async () => {
  const nowIso = "2026-05-01T00:00:00.000Z";

  const { database, bindings } = freshAccountDeletionDb();
  const cfUser = adUser(50);
  const supabaseUser = adUser(51);
  seedAppUser(database, cfUser, nowIso);
  seedAppUser(database, supabaseUser, nowIso);
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, auth_delete_started_at, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'op-reopen-cf-000001', 'auth_delete_started', 'cloudflare', ?, ?, ?, ?)
  `).run(cfUser, nowIso, nowIso, nowIso, nowIso);
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, auth_delete_started_at, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'op-reopen-sb-000001', 'auth_delete_started', 'supabase', ?, ?, ?, ?)
  `).run(supabaseUser, nowIso, nowIso, nowIso, nowIso);

  // A legacy Supabase-authority job can never be reopened this way.
  assert.equal(await accountDeletion.reopenCloudflareNativeAccountDeletion(supabaseUser, "op-reopen-sb-000001", bindings), false);
  // The wrong operation id must not reopen someone else's job.
  assert.equal(await accountDeletion.reopenCloudflareNativeAccountDeletion(cfUser, "op-wrong-operation-id1", bindings), false);
  // The real Cloudflare job, with its real operation id, reopens.
  assert.equal(await accountDeletion.reopenCloudflareNativeAccountDeletion(cfUser, "op-reopen-cf-000001", bindings), true);
  const reopened = database.prepare("SELECT state, auth_delete_started_at FROM account_deletion_tombstones WHERE user_id = ?").get(cfUser);
  assert.equal(reopened.state, "prepared");
  assert.equal(reopened.auth_delete_started_at, null);
  // Reopening again (no longer in auth_delete_started) must not succeed twice.
  assert.equal(await accountDeletion.reopenCloudflareNativeAccountDeletion(cfUser, "op-reopen-cf-000001", bindings), false);
});

test("beginCloudflareAccountAuthDeletion moves prepared -> auth_delete_started, and validates the operation id", async () => {
  const nowIso = "2026-06-01T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(60);
  seedAppUser(database, userId, nowIso);
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'op-begin-0000001', 'prepared', 'supabase', ?, ?, ?)
  `).run(userId, nowIso, nowIso, nowIso);

  await assert.rejects(
    () => accountDeletion.beginCloudflareAccountAuthDeletion(userId, "op-wrong-operation-id2", bindings),
    /operation does not match/,
  );
  const result = await accountDeletion.beginCloudflareAccountAuthDeletion(userId, "op-begin-0000001", bindings);
  assert.deepEqual(result, { operationId: "op-begin-0000001", state: "auth_delete_started", authAuthority: "supabase" });
  // Calling it again with the same, now-current operation id is idempotent:
  // the WHERE clause's own update no-ops, but the row it reads back is
  // already in the target state, so it must not throw.
  const again = await accountDeletion.beginCloudflareAccountAuthDeletion(userId, "op-begin-0000001", bindings);
  assert.deepEqual(again, result);

  // A job already past "prepared" (here: auth_deleted) can never be *started*
  // again -- its own operation id is right, but the resulting state is wrong.
  const pastUserId = adUser(62);
  seedAppUser(database, pastUserId, nowIso);
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, auth_delete_started_at,
      auth_deleted_at, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'op-begin-already-done1', 'auth_deleted', 'supabase', ?, ?, ?, ?, ?)
  `).run(pastUserId, nowIso, nowIso, nowIso, nowIso, nowIso);
  await assert.rejects(
    () => accountDeletion.beginCloudflareAccountAuthDeletion(pastUserId, "op-begin-already-done1", bindings),
    /could not start Auth deletion/,
  );
});

test("confirmCloudflareAccountAuthDeleted (markAuthDeleted) is idempotent and validates the operation id", async () => {
  const nowIso = "2026-06-15T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(61);
  seedAppUser(database, userId, nowIso);
  database.prepare(`
    INSERT INTO account_deletion_tombstones (
      user_id, operation_id, state, auth_authority, auth_delete_started_at, prepared_at, lease_expires_at, updated_at
    ) VALUES (?, 'op-confirm-0000001', 'auth_delete_started', 'supabase', ?, ?, ?, ?)
  `).run(userId, nowIso, nowIso, nowIso, nowIso);

  await assert.rejects(
    () => accountDeletion.confirmCloudflareAccountAuthDeleted(userId, "op-wrong-operation-id2", bindings),
    /operation does not match/,
  );
  const confirmed = await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, "op-confirm-0000001", bindings);
  assert.equal(confirmed.state, "auth_deleted");
  const firstAuthDeletedAt = database.prepare("SELECT auth_deleted_at FROM account_deletion_tombstones WHERE user_id = ?").get(userId).auth_deleted_at;
  assert.ok(firstAuthDeletedAt);
  // Calling it again (already auth_deleted) must not move the timestamp -- coalesce(auth_deleted_at, ?).
  await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, "op-confirm-0000001", bindings);
  const secondAuthDeletedAt = database.prepare("SELECT auth_deleted_at FROM account_deletion_tombstones WHERE user_id = ?").get(userId).auth_deleted_at;
  assert.equal(secondAuthDeletedAt, firstAuthDeletedAt);
});

test("completeCloudflareAccountDeletion runs the full privacy cascade and reaches 'complete'", async () => {
  const nowIso = "2026-07-01T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(70);
  const otherUserId = adUser(71);
  seedAppUser(database, userId, nowIso, "deleting-user@example.com");
  seedAppUser(database, otherUserId, nowIso, "other-user@example.com");

  // A representative slice of owned + actor-referenced rows -- enough to
  // prove real deletes/scrubs happen, without needing every satellite table.
  database.prepare(`
    INSERT INTO learner_profiles (user_id, display_name, updated_at) VALUES (?, 'Deleting User', ?)
  `).run(userId, nowIso);
  database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, raw_inline, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'tracking', '{}', ?, ?, ?)
  `).run("sub-70", userId, nowIso, nowIso, nowIso);
  database.prepare(`
    INSERT INTO practice_attempts (
      id, user_id, module, test_id, test_title, submitted_at, band,
      result_inline, result_sha256, result_bytes, created_at, updated_at
    ) VALUES (?, ?, 'reading', 'r1', 'Reading 1', ?, 7, '{}', ?, 2, ?, ?)
  `).run("attempt-70", userId, nowIso, "a".repeat(64), nowIso, nowIso);
  database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at) VALUES (?, ?, '/api/practice', 'admitted', ?)
  `).run("usage-70", userId, nowIso);
  // The additive app_settings table *is* present here (a normal, fully
  // migrated database) -- its actor pointer must be scrubbed too.
  database.prepare(`
    INSERT INTO app_settings (key, value_json, source_updated_at, updated_by, mirrored_at)
    VALUES ('feature.flag', '{}', ?, ?, ?)
  `).run(nowIso, userId, nowIso);
  // Belongs to someone else entirely: the provider_events scrub matches by
  // object-key *prefix* (bound as subscriptionPrefix/providerEventPrefix),
  // not by user id, so this proves those prefixes are the real ones and not
  // emptied strings (an empty prefix's substr(...,1,0)="" trivially matches
  // every row).
  database.prepare(`
    INSERT INTO provider_events (provider, event_id, received_at, payload_object_key, payload_sha256)
    VALUES ('stripe', 'evt-unrelated-1', ?, ?, ?)
  `).run(nowIso, `private/subscriptions/${otherUserId}/evt.json`, "b".repeat(64));

  const prepared = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "deleting-user@example.com" }, bindings);
  await accountDeletion.beginCloudflareAccountAuthDeletion(userId, prepared.operationId, bindings);
  await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, prepared.operationId, bindings);

  const result = await accountDeletion.completeCloudflareAccountDeletion(userId, prepared.operationId, bindings);
  assert.deepEqual(result, { complete: true, state: "complete" });

  const tombstone = database.prepare("SELECT state FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
  assert.equal(tombstone.state, "complete");

  const user = database.prepare("SELECT email, role, deleted_at FROM app_users WHERE id = ?").get(userId);
  assert.equal(user.email, null);
  assert.equal(user.role, "user");
  assert.ok(user.deleted_at);

  for (const [table, column] of [
    ["learner_profiles", "user_id"],
    ["subscriptions", "user_id"],
    ["practice_attempts", "user_id"],
    ["usage_events", "user_id"],
  ]) {
    const remaining = database.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${column} = ?`).get(userId).c;
    assert.equal(remaining, 0, `${table} rows for the deleted user must be gone`);
  }
  const setting = database.prepare("SELECT updated_by FROM app_settings WHERE key = 'feature.flag'").get();
  assert.equal(setting.updated_by, null, "app_settings' actor pointer must be scrubbed when the table exists");
  const unrelatedEvent = database.prepare("SELECT payload_object_key FROM provider_events WHERE event_id = 'evt-unrelated-1'").get();
  assert.equal(
    unrelatedEvent.payload_object_key,
    `private/subscriptions/${otherUserId}/evt.json`,
    "a provider_events row under someone else's real prefix must survive untouched",
  );
  // The other user's own data is completely untouched.
  const otherProfile = database.prepare("SELECT display_name FROM learner_profiles WHERE user_id = ?").get(otherUserId);
  assert.equal(otherProfile, undefined); // never inserted; just proves the query itself still runs cleanly
  assert.equal(database.prepare("SELECT deleted_at FROM app_users WHERE id = ?").get(otherUserId).deleted_at, null);
});

test("purgeCloudflareRows refuses to run before auth_deleted, and is a no-op once already past it", async () => {
  const nowIso = "2026-07-15T00:00:00.000Z";

  // Still "prepared" -- purgeCloudflareRows' own guard throws (caught by
  // completeCloudflareAccountDeletion, which converts it into a pending,
  // non-complete result rather than ever advancing the state).
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(72);
    seedAppUser(database, userId, nowIso);
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, prepared_at, lease_expires_at, updated_at
      ) VALUES (?, 'op-guard-prepared-01', 'prepared', 'supabase', ?, ?, ?)
    `).run(userId, nowIso, nowIso, nowIso);
    const result = await accountDeletion.completeCloudflareAccountDeletion(userId, "op-guard-prepared-01", bindings);
    assert.deepEqual(result, { complete: false, state: "prepared" });
    const tombstone = database.prepare("SELECT state FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
    assert.equal(tombstone.state, "prepared");
  }

  // Already "complete" -- calling again must be a pure no-op (idempotent).
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(73);
    seedAppUser(database, userId, nowIso);
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, auth_delete_started_at, auth_deleted_at,
        data_deleted_at, completed_at, prepared_at, lease_expires_at, updated_at
      ) VALUES (?, 'op-guard-complete-01', 'complete', 'supabase', ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);
    const result = await accountDeletion.completeCloudflareAccountDeletion(userId, "op-guard-complete-01", bindings);
    assert.deepEqual(result, { complete: true, state: "complete" });
  }

  // Already "data_deleted" (the D1 privacy scrub already ran; only the R2
  // manifest walk is left) -- purgeCloudflareRows must not redo the D1 batch.
  // completeCloudflareAccountDeletion has no state==="complete"-style guard
  // of its own for this state, so the no-op has to come from inside
  // purgeCloudflareRows itself -- observed here directly via a spy on
  // db.batch, independent of whether redoing idempotent deletes would
  // otherwise be observable.
  {
    const { database, bindings } = freshAccountDeletionDb();
    const userId = adUser(75);
    seedAppUser(database, userId, nowIso);
    database.prepare(`
      INSERT INTO account_deletion_tombstones (
        user_id, operation_id, state, auth_authority, auth_delete_started_at, auth_deleted_at,
        data_deleted_at, prepared_at, lease_expires_at, updated_at
      ) VALUES (?, 'op-guard-datadel-01', 'data_deleted', 'supabase', ?, ?, ?, ?, ?, ?)
    `).run(userId, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);
    let batchCalls = 0;
    const realBatch = bindings.db.batch.bind(bindings.db);
    bindings.db.batch = (statements) => { batchCalls += 1; return realBatch(statements); };
    const result = await accountDeletion.completeCloudflareAccountDeletion(userId, "op-guard-datadel-01", bindings);
    assert.deepEqual(result, { complete: true, state: "complete" });
    assert.equal(batchCalls, 0, "a data_deleted row must not re-run the D1 privacy-scrub batch");
  }
});

test("purgeCloudflareRows works whether or not the additive app_settings table has been migrated yet", async () => {
  const nowIso = "2026-07-20T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(74);
  seedAppUser(database, userId, nowIso);
  database.exec("DROP TABLE app_settings");

  const prepared = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
  await accountDeletion.beginCloudflareAccountAuthDeletion(userId, prepared.operationId, bindings);
  await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, prepared.operationId, bindings);
  const result = await accountDeletion.completeCloudflareAccountDeletion(userId, prepared.operationId, bindings);
  assert.deepEqual(result, { complete: true, state: "complete" });
});

test("deleteR2Manifest retries a failing R2 delete exactly 3 times before giving up", async () => {
  const nowIso = "2026-08-05T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(82);
  seedAppUser(database, userId, nowIso);
  const prepared = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
  await accountDeletion.beginCloudflareAccountAuthDeletion(userId, prepared.operationId, bindings);
  await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, prepared.operationId, bindings);
  database.prepare(`
    INSERT INTO account_deletion_objects (user_id, object_key, discovered_at) VALUES (?, ?, ?)
  `).run(userId, `private/attempts/${userId}/retry-count.json`, nowIso);

  let attempts = 0;
  bindings.files.delete = async () => { attempts += 1; throw new Error("R2 down"); };
  const result = await accountDeletion.completeCloudflareAccountDeletion(userId, prepared.operationId, bindings);
  assert.deepEqual(result, { complete: false, state: "data_deleted" });
  assert.equal(attempts, 3);
});

test("completeCloudflareAccountDeletion converts an R2 manifest failure into a pending 'data_deleted' result, then finishes on retry", async () => {
  const nowIso = "2026-08-01T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(80);
  seedAppUser(database, userId, nowIso);

  const prepared = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
  await accountDeletion.beginCloudflareAccountAuthDeletion(userId, prepared.operationId, bindings);
  await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, prepared.operationId, bindings);

  const key = `private/attempts/${userId}/pending-delete.json`;
  database.prepare(`
    INSERT INTO account_deletion_objects (user_id, object_key, discovered_at) VALUES (?, ?, ?)
  `).run(userId, key, nowIso);

  let shouldFail = true;
  bindings.files.delete = async () => { if (shouldFail) throw new Error("R2 is unavailable"); };

  const failed = await accountDeletion.completeCloudflareAccountDeletion(userId, prepared.operationId, bindings);
  assert.deepEqual(failed, { complete: false, state: "data_deleted" });
  const afterFailure = database.prepare("SELECT state, last_error_code FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
  assert.equal(afterFailure.state, "data_deleted");
  assert.equal(afterFailure.last_error_code, "r2_cleanup_failed");
  // The manifest row survives a failed delete -- nothing was removed from D1
  // before the real R2 delete actually succeeded.
  assert.equal(database.prepare("SELECT count(*) AS c FROM account_deletion_objects WHERE user_id = ?").get(userId).c, 1);

  shouldFail = false;
  const finished = await accountDeletion.completeCloudflareAccountDeletion(userId, prepared.operationId, bindings);
  assert.deepEqual(finished, { complete: true, state: "complete" });
  assert.equal(database.prepare("SELECT count(*) AS c FROM account_deletion_objects WHERE user_id = ?").get(userId).c, 0);
});

test("completeCloudflareAccountDeletion's final transition really requires the manifest to be empty", async () => {
  // A manifest row that appears *after* deleteR2Manifest's own last (empty)
  // query -- a genuine race it cannot see -- must still block the final
  // 'complete' transition, via the UPDATE's own NOT EXISTS check.
  const nowIso = "2026-08-10T00:00:00.000Z";
  const { database, bindings } = freshAccountDeletionDb();
  const userId = adUser(81);
  seedAppUser(database, userId, nowIso);

  const prepared = await accountDeletion.prepareCloudflareAccountDeletion({ id: userId, email: "u@example.com" }, bindings);
  await accountDeletion.beginCloudflareAccountAuthDeletion(userId, prepared.operationId, bindings);
  await accountDeletion.confirmCloudflareAccountAuthDeleted(userId, prepared.operationId, bindings);

  const realDb = bindings.db;
  let injected = false;
  bindings.db = {
    ...realDb,
    prepare(sql) {
      const statement = realDb.prepare(sql);
      if (!injected && sql.includes("SELECT object_key FROM account_deletion_objects")) {
        return {
          bind: (...values) => {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async all() {
                const result = await bound.all();
                injected = true;
                database.prepare(`
                  INSERT INTO account_deletion_objects (user_id, object_key, discovered_at)
                  VALUES (?, ?, ?)
                `).run(userId, `private/attempts/${userId}/raced-in.json`, nowIso);
                return result; // still empty: deleteR2Manifest never sees the race
              },
            };
          },
        };
      }
      return statement;
    },
  };

  const result = await accountDeletion.completeCloudflareAccountDeletion(userId, prepared.operationId, bindings);
  assert.deepEqual(result, { complete: false, state: "data_deleted" });
  const tombstone = database.prepare("SELECT state FROM account_deletion_tombstones WHERE user_id = ?").get(userId);
  assert.equal(tombstone.state, "data_deleted", "the tombstone must not advance to complete while a manifest row remains");
});

/* ============================================================ organizations.ts */

function orgUser(n) {
  return validUuid(60000 + n);
}

/** Seeds one organization with owner/manager/teacher/student memberships and
    returns everything a test needs to poke at cloudflareOrganizationPortal's
    eligibility/role-resolution branches. */
function freshOrgPortalDb() {
  const database = freshD1();
  const now = "2026-01-01T00:00:00.000Z";
  const org = orgUser(1);
  const owner = orgUser(2);
  const manager = orgUser(3);
  const teacher = orgUser(4);
  const student = orgUser(5);

  const insertUser = database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)
  `);
  for (const [id, label] of [[owner, "owner"], [manager, "manager"], [teacher, "teacher"], [student, "student"]]) {
    insertUser.run(id, `${label}@example.com`, now, now);
  }
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Portal Test Org', NULL, 'active', ?, ?, ?)
  `).run(org, owner, now, now);

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status, share_future_history,
      share_pre_join_history, joined_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `);
  insertMembership.run(orgUser(20), org, owner, "owner", 1, 0, now, now, now);
  insertMembership.run(orgUser(21), org, manager, "manager", 1, 0, now, now, now);
  insertMembership.run(orgUser(22), org, teacher, "teacher", 1, 0, now, now, now);
  insertMembership.run(orgUser(23), org, student, "student", 1, 0, now, now, now);

  return { database, bindings: { db: runtimeD1(database), files: fakeR2Listable() }, now, org, owner, manager, teacher, student };
}

function sessionUser(id, email) {
  return { id, email: email ?? `${id}@example.com` };
}

test("paidTier recognises exactly tracking/ai/admin (and their legacy row spellings), nothing else", async () => {
  const { database, bindings, now, student } = freshOrgPortalDb();
  const setTier = (tier) => {
    database.exec("DELETE FROM subscriptions");
    database.prepare(`
      INSERT INTO subscriptions (id, user_id, provider, status, tier, raw_inline, verified_at, created_at, updated_at)
      VALUES ('sub-1', ?, 'stripe', 'active', ?, '{}', ?, ?, ?)
    `).run(student, tier, now, now, now);
  };

  for (const tier of ["tracking", "ai", "admin", "standard", "plus", "pro"]) {
    setTier(tier);
    const portal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, null, bindings);
    assert.equal(portal.eligibility.canJoin, true, `tier ${tier} should be eligible to join`);
    assert.equal(portal.actor.tier, tier === "standard" ? "tracking" : tier === "plus" || tier === "pro" ? "ai" : tier);
  }
  for (const tier of ["free", "unknown-tier", ""]) {
    setTier(tier);
    const portal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, null, bindings);
    assert.equal(portal.eligibility.canJoin, false, `tier ${tier} should not be eligible (no seat)`);
    assert.equal(portal.eligibility.reason, "A Tracking or AI plan, or an organisation seat, is required to join as a student.");
    assert.equal(portal.actor.tier, "free");
  }
});

test("platformAdmin is always eligible and tiered 'admin', independent of any subscription row", async () => {
  const { bindings, owner } = freshOrgPortalDb();
  const portal = await organizations.cloudflareOrganizationPortal(sessionUser(owner), true, null, bindings);
  assert.equal(portal.actor.tier, "admin");
  assert.equal(portal.eligibility.canJoin, true);
  assert.equal(portal.eligibility.reason, null);
});

test("membershipFrom maps share flags and the latest history/leave request per organisation, scoped by kind+scope", async () => {
  const { database, bindings, now, org, owner, student } = freshOrgPortalDb();
  database.prepare(`
    UPDATE organization_memberships SET share_future_history = 0, share_pre_join_history = 1 WHERE user_id = ?
  `).run(student);

  const insertRequest = database.prepare(`
    INSERT INTO organization_requests (
      id, organization_id, kind, status, requester_user_id, created_at, updated_at, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Older "prior"-scope request: superseded by the newer one below (only the
  // *latest* per key must win -- created_at DESC, first-seen-wins in the map).
  insertRequest.run("req-prior-old", org, "history_access_change", "rejected", student, "2025-01-01T00:00:00.000Z", now, null);
  insertRequest.run("req-prior-new", org, "history_access_change", "pending", student, "2025-06-01T00:00:00.000Z", now, null);
  insertRequest.run("req-future", org, "history_access_change", "approved", student, "2025-06-02T00:00:00.000Z", now, "scope:future");
  // note is a coincidental "scope:future"-shaped value on a *leave* request --
  // scope only means anything for history_access_change, so this must still
  // key as plain ":leave", not ":leave:future".
  insertRequest.run("req-leave", org, "leave", "pending", student, "2025-06-03T00:00:00.000Z", now, "scope:future");

  const portal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, org, bindings);
  const membership = portal.memberships.find((m) => m.organization.id === org);
  assert.equal(membership.shareFutureHistory, false);
  assert.equal(membership.sharePreJoinHistory, true);
  assert.equal(membership.preJoinHistoryRequestStatus, "pending"); // the *newer* prior-scope request wins
  assert.equal(membership.futureHistoryRequestStatus, "approved");
  assert.equal(membership.leaveRequestStatus, "pending");

  // The owner kept the *default* seeded flags (1, 0) -- the true/1 side of
  // both booleans, which the student's (0, 1) row above does not probe.
  const ownerPortal = await organizations.cloudflareOrganizationPortal(sessionUser(owner), false, org, bindings);
  const ownerMembership = ownerPortal.memberships.find((m) => m.organization.id === org);
  assert.equal(ownerMembership.shareFutureHistory, true);
  assert.equal(ownerMembership.sharePreJoinHistory, false);
});

test("a request with neither 'leave' nor 'history_access_change' kind is never fetched, and an unrelated org's requests never leak in", async () => {
  const { database, bindings, now, org, owner, student } = freshOrgPortalDb();
  const otherOrg = orgUser(30);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Other Org', NULL, 'active', ?, ?, ?)
  `).run(otherOrg, owner, now, now);
  database.prepare(`
    INSERT INTO organization_requests (
      id, organization_id, kind, status, requester_user_id, created_at, updated_at
    ) VALUES ('req-other-org', ?, 'leave', 'pending', ?, ?, ?)
  `).run(otherOrg, student, now, now);

  const portal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, org, bindings);
  const membership = portal.memberships.find((m) => m.organization.id === org);
  assert.equal(membership.leaveRequestStatus, null, "a leave request filed against a *different* organisation must not apply here");
});

test("activeOrganization: platform admin picks the URL-selected org, else the active one, else the first", async () => {
  const { database, bindings, owner } = freshOrgPortalDb();
  const suspendedOrg = orgUser(31);
  const secondActiveOrg = orgUser(32);
  // Distinct, strictly increasing timestamps: organizationRows orders by
  // created_at DESC, so suspendedOrg (newest) sits at array[0] -- distinct
  // from secondActiveOrg (the correct "first *active*" answer). That gap is
  // what separates "find the active one" from "just take [0]" or "?? vs &&".
  const later = "2026-01-02T00:00:00.000Z";
  const latest = "2026-01-03T00:00:00.000Z";
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Second Active Org', NULL, 'active', ?, ?, ?)
  `).run(secondActiveOrg, owner, later, later);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Suspended Org', NULL, 'suspended', ?, ?, ?)
  `).run(suspendedOrg, owner, latest, latest);

  // Explicit selection wins, even if it isn't the "active" one (a platform
  // admin may specifically need to look at a suspended organisation).
  const selected = await organizations.cloudflareOrganizationPortal(sessionUser(owner), true, suspendedOrg, bindings);
  assert.equal(selected.activeOrganizationId, suspendedOrg);

  // No selection -> the first organisation whose *status* is active. By
  // created_at DESC that's [suspendedOrg(newest,suspended), secondActiveOrg,
  // org(oldest)] -- the newest is suspended, so the answer must be
  // secondActiveOrg, not suspendedOrg (array[0]) and not org (oldest active).
  const unselected = await organizations.cloudflareOrganizationPortal(sessionUser(owner), true, null, bindings);
  assert.equal(unselected.activeOrganizationId, secondActiveOrg);
});

test("activeOrganization for a non-admin only considers active/leave_requested memberships in active organisations", async () => {
  const { database, bindings, now, org, student, owner } = freshOrgPortalDb();
  const suspendedMembershipOrg = orgUser(33);
  const removedMembershipOrg = orgUser(34);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Suspended-Membership Org', NULL, 'active', ?, ?, ?)
  `).run(suspendedMembershipOrg, owner, now, now);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Removed-Membership Org', NULL, 'active', ?, ?, ?)
  `).run(removedMembershipOrg, owner, now, now);
  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status, share_future_history,
      share_pre_join_history, joined_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'student', ?, 1, 0, ?, ?, ?)
  `);
  insertMembership.run(orgUser(40), suspendedMembershipOrg, student, "suspended", now, now, now);
  insertMembership.run(orgUser(41), removedMembershipOrg, student, "removed", now, now, now);
  // The inverse case: the *membership* is fully active, but the organisation
  // itself is suspended -- distinct from the two rows above, which suspend
  // the membership while the organisation stays active. Its membership is
  // the *newest* (organizationMemberships orders by created_at DESC), so if
  // the organisation-status half of the filter were dropped, this row -- not
  // the original org's -- would incorrectly win as eligibleMemberships[0].
  const orgSuspendedItself = orgUser(35);
  const membershipLater = "2026-01-05T00:00:00.000Z";
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Org Suspended Itself', NULL, 'suspended', ?, ?, ?)
  `).run(orgSuspendedItself, owner, now, now);
  insertMembership.run(orgUser(42), orgSuspendedItself, student, "active", membershipLater, membershipLater, membershipLater);

  // Only the original org's "active" membership is eligible -- suspended and
  // removed memberships in *other* organisations must not become active, nor
  // may an active membership in a suspended organisation.
  const portal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, null, bindings);
  assert.equal(portal.activeOrganizationId, org);

  // A selected org the student is NOT (eligibly) a member of falls back to
  // their newest eligible membership rather than silently succeeding.
  const withBadSelection = await organizations.cloudflareOrganizationPortal(
    sessionUser(student), false, suspendedMembershipOrg, bindings,
  );
  assert.equal(withBadSelection.activeOrganizationId, org);

  // Selecting a *second*, genuinely eligible organisation (not just falling
  // back to eligibleMemberships[0]) proves .find() itself does the locating.
  const secondEligibleOrg = orgUser(36);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, NULL, 'Second Eligible Org', NULL, 'active', ?, ?, ?)
  `).run(secondEligibleOrg, owner, now, now);
  insertMembership.run(orgUser(43), secondEligibleOrg, student, "active", now, now, now);
  const withSecondSelection = await organizations.cloudflareOrganizationPortal(
    sessionUser(student), false, secondEligibleOrg, bindings,
  );
  assert.equal(withSecondSelection.activeOrganizationId, secondEligibleOrg);

  // leave_requested is still an eligible (visible) membership status.
  database.prepare("UPDATE organization_memberships SET status = 'leave_requested' WHERE user_id = ? AND organization_id = ?")
    .run(student, org);
  const withLeaveRequested = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, org, bindings);
  assert.equal(withLeaveRequested.activeOrganizationId, org);
});

test("canClearOwnHistory is false only for a student with a currently-live membership somewhere", async () => {
  const { database, bindings, owner, teacher, student } = freshOrgPortalDb();
  const ownerPortal = await organizations.cloudflareOrganizationPortal(sessionUser(owner), false, null, bindings);
  assert.equal(ownerPortal.canClearOwnHistory, true, "an owner (not a student) may always clear their own history");

  const teacherPortal = await organizations.cloudflareOrganizationPortal(sessionUser(teacher), false, null, bindings);
  assert.equal(teacherPortal.canClearOwnHistory, true, "a teacher (not a student) may always clear their own history");

  const studentPortal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, null, bindings);
  assert.equal(studentPortal.canClearOwnHistory, false, "a live student membership blocks self-service history clearing");

  database.prepare("UPDATE organization_memberships SET status = 'removed' WHERE user_id = ?").run(student);
  const removedStudentPortal = await organizations.cloudflareOrganizationPortal(sessionUser(student), false, null, bindings);
  assert.equal(removedStudentPortal.canClearOwnHistory, true, "a removed student membership no longer blocks it");
});
