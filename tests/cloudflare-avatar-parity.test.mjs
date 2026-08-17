/*
  lib/cloudflare/migration-readiness.ts's `profiles` fingerprint never reads
  `avatar_object_key`, so an equal profile row proves nothing about whether a
  learner's picture would survive a read cutover. These checks guard the
  module that actually answers that:

    1. A profile Supabase has an avatar for and D1 does not is named as a
       "disappearing face" — the count that has to be zero before any flip.
    2. The reverse (D1 has a key Supabase's avatar_path does not) is named
       too, never silently dropped.
    3. Matched pairs are byte-compared, and unreadable-on-either-side is kept
       distinct from "different" and from "absent" — an R2 object that is
       recorded but corrupt is worse than a profile with no avatar at all.
    4. Both the presence scan and the byte budget say honestly how far they
       got, and never claim "equal" for a comparison that stopped early.
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
const parity = await load("lib", "cloudflare", "avatar-parity.ts");

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

/** Minimal R2 stand-in. A value of `"CORRUPT"` reads back but fails to decode. */
function fakeFiles(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (value === "CORRUPT") {
        return { async arrayBuffer() { throw new Error("r2 object body could not be read"); } };
      }
      return { async arrayBuffer() { return value.buffer; } };
    },
  };
}

function fixture(files = {}) {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return { database, bindings: { db: runtimeD1(database), files: fakeFiles(files) } };
}

const CREATED = "2026-08-01T00:00:00.000Z";
const UPDATED = "2026-08-14T10:00:00.000Z";
const USERS = [
  "50000000-0000-4000-8000-000000000001", // both sides, identical bytes
  "50000000-0000-4000-8000-000000000002", // Supabase only: disappearing face
  "50000000-0000-4000-8000-000000000003", // D1 only: target-only
  "50000000-0000-4000-8000-000000000004", // deleted in D1, still has a key: must not count
];

function seedTarget(database, { withAvatar = [], deleted = [] } = {}) {
  for (const user of USERS) {
    database.prepare(`
      INSERT INTO app_users (id,email,role,created_at,updated_at,deleted_at)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run(user, `${user}@example.test`, CREATED, UPDATED, deleted.includes(user) ? UPDATED : null);
    const objectKey = withAvatar.includes(user) ? `private/avatars/${user}/${user}.jpg` : null;
    database.prepare(`
      INSERT INTO learner_profiles (user_id,display_name,avatar_object_key,source_updated_at,avatar_source_updated_at,updated_at)
      VALUES (?, 'Learner', ?, ?, ?, ?)
    `).run(user, objectKey, UPDATED, objectKey ? UPDATED : null, UPDATED);
  }
}

function sourcePage(rows) {
  return async (after, limit) => rows
    .filter((row) => row.userId > after)
    .sort((left, right) => (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0))
    .slice(0, limit);
}

const bytesA = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const bytesB = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]);

test("a profile with the identical picture on both sides is reported equal, not merely present", async () => {
  const context = fixture({ [`private/avatars/${USERS[0]}/${USERS[0]}.jpg`]: bytesA });
  seedTarget(context.database, { withAvatar: [USERS[0]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[0], avatarPath: `${USERS[0]}/original.jpg` }]),
    readSourceBytes: async () => bytesA,
  });

  assert.equal(report.status, "equal");
  assert.equal(report.complete, true);
  assert.equal(report.disappearingFaces.total, 0);
  assert.equal(report.targetOnly.total, 0);
  assert.equal(report.bytes.equal.total, 1);
  assert.deepEqual(report.bytes.equal.sample, [USERS[0]]);
  assert.equal(report.bytes.different.total, 0);
});

test("a learner with a Supabase avatar and no D1 pointer is counted as a disappearing face", async () => {
  const context = fixture();
  seedTarget(context.database);

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[1], avatarPath: `${USERS[1]}/original.jpg` }]),
    readSourceBytes: async () => bytesA,
  });

  assert.equal(report.status, "drifted");
  assert.equal(report.disappearingFaces.total, 1);
  assert.deepEqual(report.disappearingFaces.sample, [USERS[1]]);
  // Nothing was checked, because there was nothing to compare it against.
  assert.equal(report.bytes.checked, 0);
});

test("a D1 pointer Supabase's avatar_path does not name is reported, not fixed", async () => {
  const context = fixture();
  seedTarget(context.database, { withAvatar: [USERS[2]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([]),
    readSourceBytes: async () => null,
  });

  assert.equal(report.status, "drifted");
  assert.equal(report.targetOnly.total, 1);
  assert.deepEqual(report.targetOnly.sample, [USERS[2]]);
  assert.equal(report.disappearingFaces.total, 0);
});

test("a soft-deleted D1 account's leftover avatar key is excluded from target-only", async () => {
  const context = fixture();
  seedTarget(context.database, { withAvatar: [USERS[3]], deleted: [USERS[3]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([]),
    readSourceBytes: async () => null,
  });

  assert.equal(report.targetOnly.total, 0);
  assert.equal(report.status, "equal");
});

test("mismatched bytes are reported as different, not equal", async () => {
  const context = fixture({ [`private/avatars/${USERS[0]}/${USERS[0]}.jpg`]: bytesB });
  seedTarget(context.database, { withAvatar: [USERS[0]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[0], avatarPath: `${USERS[0]}/original.jpg` }]),
    readSourceBytes: async () => bytesA,
  });

  assert.equal(report.status, "drifted");
  assert.equal(report.bytes.different.total, 1);
  assert.deepEqual(report.bytes.different.sample, [USERS[0]]);
  assert.equal(report.bytes.equal.total, 0);
});

test("an R2 object recorded but unreadable is its own outcome, distinct from absent", async () => {
  const context = fixture({ [`private/avatars/${USERS[0]}/${USERS[0]}.jpg`]: "CORRUPT" });
  seedTarget(context.database, { withAvatar: [USERS[0]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[0], avatarPath: `${USERS[0]}/original.jpg` }]),
    readSourceBytes: async () => bytesA,
  });

  assert.equal(report.bytes.targetUnreadable.total, 1);
  assert.deepEqual(report.bytes.targetUnreadable.sample, [USERS[0]]);
  assert.equal(report.bytes.different.total, 0);
  assert.equal(report.bytes.sourceUnreadable.total, 0);
});

test("a Supabase Storage read failure is its own outcome, distinct from a missing R2 object", async () => {
  const context = fixture({ [`private/avatars/${USERS[0]}/${USERS[0]}.jpg`]: bytesA });
  seedTarget(context.database, { withAvatar: [USERS[0]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[0], avatarPath: `${USERS[0]}/original.jpg` }]),
    readSourceBytes: async () => null,
  });

  assert.equal(report.bytes.sourceUnreadable.total, 1);
  assert.deepEqual(report.bytes.sourceUnreadable.sample, [USERS[0]]);
  assert.equal(report.bytes.targetUnreadable.total, 0);
});

test("unreadable on both sides is counted separately from either single-side outcome", async () => {
  const context = fixture();
  seedTarget(context.database, { withAvatar: [USERS[0]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[0], avatarPath: `${USERS[0]}/original.jpg` }]),
    readSourceBytes: async () => null,
  });

  assert.equal(report.bytes.bothUnreadable.total, 1);
  assert.equal(report.bytes.sourceUnreadable.total, 0);
  assert.equal(report.bytes.targetUnreadable.total, 0);
});

test("a bounded presence scan says how far it got instead of claiming the rest is clean", async () => {
  const context = fixture({ [`private/avatars/${USERS[1]}/${USERS[1]}.jpg`]: bytesA });
  seedTarget(context.database, { withAvatar: [USERS[1]] });
  // USERS[1] matches on both sides; USERS[2] would be a disappearing face,
  // but the bound must stop the scan before it is ever read.
  const rows = [
    { userId: USERS[1], avatarPath: `${USERS[1]}/original.jpg` },
    { userId: USERS[2], avatarPath: `${USERS[2]}/original.jpg` },
  ];

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage(rows),
    readSourceBytes: async () => bytesA,
    rowLimit: 1,
  });

  assert.equal(report.presenceComplete, false);
  assert.equal(report.complete, false);
  assert.equal(report.status, "partial");
  assert.equal(report.comparedSourceRows, 1);
  // Nothing wrongly counted as a disappearing face just because the scan
  // never reached it.
  assert.equal(report.disappearingFaces.total, 0);
});

test("a bounded byte budget skips the rest of a page instead of claiming it verified", async () => {
  const context = fixture({
    [`private/avatars/${USERS[0]}/${USERS[0]}.jpg`]: bytesA,
    [`private/avatars/${USERS[3]}/${USERS[3]}.jpg`]: bytesA,
  });
  seedTarget(context.database, { withAvatar: [USERS[0], USERS[3]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([
      { userId: USERS[0], avatarPath: `${USERS[0]}/original.jpg` },
      { userId: USERS[3], avatarPath: `${USERS[3]}/original.jpg` },
    ]),
    readSourceBytes: async () => bytesA,
    byteCheckLimit: 1,
  });

  assert.equal(report.bytes.checked, 1);
  assert.equal(report.bytes.skipped, 1);
  assert.equal(report.bytesComplete, false);
  assert.equal(report.complete, false);
  // The presence facts are still exact — only the expensive half was bounded.
  assert.equal(report.presenceComplete, true);
  assert.equal(report.disappearingFaces.total, 0);
  assert.equal(report.targetOnly.total, 0);
});

test("the sample is bounded while the total counts every disappearing face found", async () => {
  const context = fixture();
  seedTarget(context.database);
  const rows = USERS.slice(1, 3).map((userId) => ({ userId, avatarPath: `${userId}/original.jpg` }));

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage(rows),
    sampleLimit: 1,
  });

  assert.equal(report.disappearingFaces.total, 2);
  assert.equal(report.disappearingFaces.sample.length, 1);
});

test("an unreadable source names the side that failed and never the database message", async () => {
  const context = fixture();
  seedTarget(context.database);

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: async () => { throw new Error("supabase storage detail must stay server-only"); },
  });

  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailable, "source");
  assert.doesNotMatch(JSON.stringify(report), /supabase storage detail must stay server-only/);
});

test("no image byte or avatar path reaches the report — only user ids and outcomes", async () => {
  const context = fixture({ [`private/avatars/${USERS[0]}/${USERS[0]}.jpg`]: bytesB });
  seedTarget(context.database, { withAvatar: [USERS[0]] });

  const report = await parity.avatarObjectParityReport(context.bindings, {
    readSourcePage: sourcePage([{ userId: USERS[0], avatarPath: `${USERS[0]}/some-secret-original-name.jpg` }]),
    readSourceBytes: async () => bytesA,
  });

  const body = JSON.stringify(report);
  assert.doesNotMatch(body, /some-secret-original-name/);
  assert.doesNotMatch(body, /private\/avatars/);
  assert.match(body, new RegExp(USERS[0]));
});

test("the avatarObjectParity parameter is a plain on/off flag", () => {
  assert.equal(parity.parseAvatarObjectParityFlag(null), false);
  assert.equal(parity.parseAvatarObjectParityFlag(""), false);
  assert.equal(parity.parseAvatarObjectParityFlag("0"), false);
  assert.equal(parity.parseAvatarObjectParityFlag("nonsense"), false);
  assert.equal(parity.parseAvatarObjectParityFlag("1"), true);
  assert.equal(parity.parseAvatarObjectParityFlag("true"), true);
  assert.equal(parity.parseAvatarObjectParityFlag("all"), true);
});

test("avatar parity is admin-only, off by default, wired through the readiness route, and writes nothing on either side", () => {
  const route = code(readFileSync(
    join(process.cwd(), "app", "api", "admin", "cloudflare", "readiness", "route.ts"),
    "utf8",
  ));
  assert.match(route, /isAdminEmail\(actor\.email\)/);
  assert.match(route, /parseAvatarObjectParityFlag\(query\.get\("avatarObjectParity"\)\)/);
  assert.match(route, /if \(wantsAvatarParity\)/);
  assert.match(route, /private, no-store/);

  const moduleSource = code(readFileSync(
    join(process.cwd(), "lib", "cloudflare", "avatar-parity.ts"),
    "utf8",
  ));
  assert.doesNotMatch(moduleSource, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/);
  assert.doesNotMatch(moduleSource, /files\.put|files\.delete/);

  const supabaseSource = code(readFileSync(join(process.cwd(), "lib", "auth", "supabase.ts"), "utf8"));
  assert.match(supabaseSource, /export async function avatarPathPage/);
  assert.match(supabaseSource, /export async function downloadAvatarBytes/);

  // The registry entry this stage was assigned already exists; a genuinely
  // unverified domain (nothing here has run against production) must stay
  // `supported: false` rather than a diagnostic tool flipping it on its own.
  const registry = code(readFileSync(join(process.cwd(), "lib", "cloudflare", "cutover-domains.ts"), "utf8"));
  assert.match(registry, /domain: "avatar_object_parity",\s*\n\s*description:[^\n]*,\s*\n\s*supported: false,/);
});
