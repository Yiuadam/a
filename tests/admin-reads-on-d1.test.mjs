/*
  `admin_user_directory` and `admin_statistics`'s D1 read paths.

  The native Cloudflare paths now include the entire owner roster and the
  identity dashboard totals: email/profile/username, registration date,
  plan, organisation seats, usage, account count and signup days. Legacy RPC
  reads remain only while Supabase is configured as an explicit transition
  source.

  Every fix below was stash-verified: reverted, watched the test fail,
  restored. See the pull request for the revert/fails table.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const adminStats = await load("lib", "cloudflare", "admin-stats.ts");
const adminEntitlements = await load("lib", "cloudflare", "admin-entitlement-directory.ts");
const nativeDirectory = await load("lib", "cloudflare", "admin-directory.ts");
const sourceClockModule = await load("lib", "cloudflare", "source-clock.ts");
const { canonicalCloudflareSourceClock } = sourceClockModule;

/* --------------------------------------------------------- D1 test harness -- */

function runtimeD1(database) {
  const bound = (sql, values) => ({
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? (row[column] ?? null) : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return { prepare(sql) { return { bind: (...values) => bound(sql, values) }; } };
}

function freshD1() {
  const database = new DatabaseSync(":memory:");
  const dir = join(ROOT, "cloudflare", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(dir, file), "utf8"));
  }
  return database;
}

function insertUser(database, id, email, deletedAt = null) {
  const clock = canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z");
  database.prepare(`INSERT INTO app_users (id, email, role, created_at, updated_at, deleted_at)
    VALUES (?, ?, 'user', ?, ?, ?)`).run(id, email, clock, clock, deletedAt);
}

function insertUserAt(database, id, email, createdAt, deletedAt = null) {
  const clock = canonicalCloudflareSourceClock(createdAt);
  database.prepare(`INSERT INTO app_users (id, email, role, created_at, updated_at, deleted_at)
    VALUES (?, ?, 'user', ?, ?, ?)`).run(id, email, clock, clock, deletedAt);
}

function insertSubscription(database, { id, userId, provider, status, tier, currentPeriodEnd, verifiedAt }) {
  const clock = canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z");
  database.prepare(`INSERT INTO subscriptions
      (id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, userId, provider, status, tier,
    currentPeriodEnd ? canonicalCloudflareSourceClock(currentPeriodEnd) : null,
    canonicalCloudflareSourceClock(verifiedAt), clock, clock,
  );
}

function insertUsageEvent(database, { id, userId, route, outcome, createdAt }) {
  database.prepare(`INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, userId ?? null, route, outcome, canonicalCloudflareSourceClock(createdAt));
}

/** Real wall-clock UTC calendar day, `daysAgo` days back, as an ISO instant at the given hour. */
function utcInstant(daysAgo, hour = 12) {
  const day = new Date();
  day.setUTCHours(hour, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - daysAgo);
  return day.toISOString();
}

function utcDayString(daysAgo) {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - daysAgo);
  return day.toISOString().slice(0, 10);
}

/* ----------------------------------------------------------- usage figures -- */

test("cloudflareAdminUsageDaily fills every UTC day, excludes only the calling admin, and counts admitted/denied", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const admin = "50000000-0000-4000-8000-000000000001";
  const learner = "50000000-0000-4000-8000-000000000002";
  insertUser(database, admin, "admin@example.test");
  insertUser(database, learner, "learner@example.test");

  insertUsageEvent(database, { id: "e1", userId: learner, route: "tutor", outcome: "admitted", createdAt: utcInstant(0, 9) });
  insertUsageEvent(database, { id: "e2", userId: learner, route: "tutor", outcome: "denied_quota", createdAt: utcInstant(0, 10) });
  insertUsageEvent(database, { id: "e3", userId: null, route: "tutor", outcome: "admitted", createdAt: utcInstant(1, 9) });
  // The calling admin's own traffic is excluded from the learner-demand figure.
  insertUsageEvent(database, { id: "e4", userId: admin, route: "tutor", outcome: "admitted", createdAt: utcInstant(0, 11) });
  // Outside a 3-day window: must not appear in the totals at all.
  insertUsageEvent(database, { id: "e5", userId: learner, route: "tutor", outcome: "admitted", createdAt: utcInstant(10, 9) });

  const rows = await adminStats.cloudflareAdminUsageDaily(3, admin, bindings);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.day), [utcDayString(2), utcDayString(1), utcDayString(0)]);

  const today = rows.find((row) => row.day === utcDayString(0));
  assert.equal(today.admitted, 1, "admin's own admitted row must not be counted");
  assert.equal(today.denied, 1);

  const yesterday = rows.find((row) => row.day === utcDayString(1));
  assert.equal(yesterday.admitted, 1, "anonymous (user_id null) rows must be counted, never excluded");
  assert.equal(yesterday.denied, 0);

  const twoDaysAgo = rows.find((row) => row.day === utcDayString(2));
  assert.equal(twoDaysAgo.admitted, 0);
  assert.equal(twoDaysAgo.denied, 0, "a day with no events must still appear, zero-filled");
});

test("cloudflareAdminUsageBreakdown groups by route, decision and caller, identity-free", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const admin = "50000000-0000-4000-8000-000000000003";
  const learner = "50000000-0000-4000-8000-000000000004";
  insertUser(database, admin, "admin2@example.test");
  insertUser(database, learner, "learner2@example.test");

  insertUsageEvent(database, { id: "b1", userId: learner, route: "speaking", outcome: "admitted", createdAt: utcInstant(0, 9) });
  insertUsageEvent(database, { id: "b2", userId: learner, route: "speaking", outcome: "admitted", createdAt: utcInstant(0, 10) });
  insertUsageEvent(database, { id: "b3", userId: null, route: "speaking", outcome: "denied_rate", createdAt: utcInstant(0, 11) });
  insertUsageEvent(database, { id: "b4", userId: learner, route: "writing", outcome: "denied_quota", createdAt: utcInstant(0, 12) });
  insertUsageEvent(database, { id: "b5", userId: admin, route: "speaking", outcome: "admitted", createdAt: utcInstant(0, 13) });

  const rows = await adminStats.cloudflareAdminUsageBreakdown(1, admin, bindings);
  assert.deepEqual(rows, [
    { route: "speaking", decision: "allowed", caller: "signed_in", count: 2 },
    { route: "speaking", decision: "blocked_rate", caller: "anonymous", count: 1 },
    { route: "writing", decision: "blocked_quota", caller: "signed_in", count: 1 },
  ]);
});

test("Cloudflare-native identity totals count only live D1 accounts and zero-fill daily signups", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const today = utcInstant(0, 9);
  const yesterday = utcInstant(1, 9);
  insertUserAt(database, "50000000-0000-4000-8000-000000000041", "today@example.test", today);
  insertUserAt(database, "50000000-0000-4000-8000-000000000042", "yesterday@example.test", yesterday);
  insertUserAt(database, "50000000-0000-4000-8000-000000000043", "gone@example.test", today, today);

  assert.equal(await adminStats.cloudflareAdminUserCount(bindings), 2);
  const signups = await adminStats.cloudflareAdminSignupsDaily(3, bindings);
  assert.deepEqual(signups, [
    { day: utcDayString(2), count: 0 },
    { day: utcDayString(1), count: 1 },
    { day: utcDayString(0), count: 1 },
  ]);
});

test("cloudflareAdminTierCounts ranks by tier, treats the admin id as 'admin', and excludes deleted accounts", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const admin = "50000000-0000-4000-8000-000000000005";
  const pro = "50000000-0000-4000-8000-000000000006";
  const free = "50000000-0000-4000-8000-000000000007";
  const overlap = "50000000-0000-4000-8000-000000000008";
  const deleted = "50000000-0000-4000-8000-000000000009";
  insertUser(database, admin, "admin3@example.test");
  insertUser(database, pro, "pro@example.test");
  insertUser(database, free, "free@example.test");
  insertUser(database, overlap, "overlap@example.test");
  insertUser(database, deleted, "gone@example.test", canonicalCloudflareSourceClock("2026-06-01T00:00:00.000Z"));

  // The admin's own subscription row, if any, must not matter — it is
  // reported as 'admin' unconditionally, matching admin_tier_counts(uuid).
  insertSubscription(database, { id: "s0", userId: admin, provider: "stripe", status: "active", tier: "standard", currentPeriodEnd: null, verifiedAt: "2026-01-01T00:00:00.000Z" });
  insertSubscription(database, { id: "s1", userId: pro, provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: null, verifiedAt: "2026-01-01T00:00:00.000Z" });
  insertSubscription(database, { id: "s2", userId: overlap, provider: "apple", status: "trialing", tier: "plus", currentPeriodEnd: "2099-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z" });
  insertSubscription(database, { id: "s3", userId: overlap, provider: "stripe", status: "expired", tier: "pro", currentPeriodEnd: "2099-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z" });
  insertSubscription(database, { id: "s4", userId: deleted, provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: null, verifiedAt: "2026-01-01T00:00:00.000Z" });

  const rows = await adminStats.cloudflareAdminTierCounts(admin, bindings);
  const byTier = Object.fromEntries(rows.map((row) => [row.tier, row.count]));
  assert.equal(byTier.admin, 1);
  assert.equal(byTier.pro, 1);
  assert.equal(byTier.plus, 1, "an expired row must lose to an active/trialing one, not merely the highest tier ever seen");
  assert.equal(byTier.free, 1, "no active/trialing subscription resolves to free");
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 4, "the soft-deleted account must not be counted at all");
});

/* --------------------------------------------------------- directory reads -- */

test("cloudflareAdminDirectoryEntitlements marks an id with no app_users row as unmirrored, never as free", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const mirrored = "50000000-0000-4000-8000-000000000010";
  const unmirrored = "50000000-0000-4000-8000-000000000011";
  insertUser(database, mirrored, "mirrored@example.test");
  insertSubscription(database, { id: "d1", userId: mirrored, provider: "stripe", status: "active", tier: "plus", currentPeriodEnd: null, verifiedAt: "2026-01-01T00:00:00.000Z" });

  const result = await adminEntitlements.cloudflareAdminDirectoryEntitlements([mirrored, unmirrored], bindings);
  assert.deepEqual(result.get(mirrored), { mirrored: true, tier: "plus", source: "stripe" });
  assert.equal(result.get(unmirrored).mirrored, false, "Auth knows this id; D1 does not — it must say so, not resolve to free");
});

test("cloudflareAdminDirectoryEntitlements resolves a mirrored account with no active subscription to free/default", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const id = "50000000-0000-4000-8000-000000000012";
  insertUser(database, id, "nosub@example.test");

  const result = await adminEntitlements.cloudflareAdminDirectoryEntitlements([id], bindings);
  assert.deepEqual(result.get(id), { mirrored: true, tier: "free", source: "default" });
});

test("cloudflareAdminDirectoryEntitlements ignores a soft-deleted app_users row, same as the roster it stands in for", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const id = "50000000-0000-4000-8000-000000000013";
  insertUser(database, id, "gone2@example.test", canonicalCloudflareSourceClock("2026-06-01T00:00:00.000Z"));

  const result = await adminEntitlements.cloudflareAdminDirectoryEntitlements([id], bindings);
  assert.equal(result.get(id).mirrored, false);
});

test("cloudflareAdminDirectoryEntitlements resolves a roster past the old UNION-ALL branch limit", async () => {
  // #163 found D1's SQLITE_LIMIT_COMPOUND_SELECT already exceeded at seven
  // fixed UNION ALL branches. This query used to build one such branch per
  // account id, so a roster this size (production has nine accounts) failed
  // in production even though the in-memory node:sqlite fixture every other
  // test here runs against has no such limit and never caught it. json_each
  // reads the ids from one bound JSON array instead — no compound SELECT at
  // any roster size.
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const ids = Array.from({ length: 12 }, (_, index) =>
    `50000000-0000-4000-8000-0000000000${String(20 + index).padStart(2, "0")}`);
  ids.forEach((id, index) => insertUser(database, id, `roster${index}@example.test`));
  insertSubscription(database, {
    id: "roster-sub", userId: ids[5], provider: "stripe", status: "active",
    tier: "pro", currentPeriodEnd: null, verifiedAt: "2026-01-01T00:00:00.000Z",
  });

  const result = await adminEntitlements.cloudflareAdminDirectoryEntitlements(ids, bindings);
  assert.equal(result.size, ids.length);
  for (const id of ids) assert.equal(result.get(id).mirrored, true);
  assert.deepEqual(result.get(ids[5]), { mirrored: true, tier: "pro", source: "stripe" });
});

test("Cloudflare-native directory uses its own roster, profile, username and D1 effective tier", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const id = "50000000-0000-4000-8000-000000000051";
  const deleted = "50000000-0000-4000-8000-000000000052";
  insertUser(database, id, "learner@example.test");
  insertUser(database, deleted, "gone@example.test", canonicalCloudflareSourceClock("2026-06-01T00:00:00.000Z"));
  database.prepare(`INSERT INTO learner_profiles
    (user_id, display_name, account_kind, updated_at) VALUES (?, ?, 'student', ?)`)
    .run(id, "Learner", canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"));
  database.prepare("INSERT INTO usernames (username, user_id, created_at) VALUES (?, ?, ?)")
    .run("learner", id, canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"));
  insertSubscription(database, { id: "native-directory-sub", userId: id, provider: "stripe", status: "active", tier: "pro", currentPeriodEnd: null, verifiedAt: "2026-01-01T00:00:00.000Z" });
  insertUsageEvent(database, { id: "native-directory-usage", userId: id, route: "tutor", outcome: "admitted", createdAt: utcInstant(0, 9) });

  const page = await nativeDirectory.cloudflareAdminDirectoryPage({ query: "learner", limit: 50, offset: 0 }, bindings);
  assert.equal(page.total, 1);
  assert.deepEqual(page.users[0], {
    id,
    email: "learner@example.test",
    username: "learner",
    displayName: "Learner",
    accountKind: "student",
    registeredAt: canonicalCloudflareSourceClock("2026-01-01T00:00:00.000Z"),
    plan: "pro",
    accessSource: "stripe",
    organizationSeatCount: 0,
    usage30d: 1,
    totalCount: 1,
  });
  const detail = await nativeDirectory.cloudflareAdminDirectoryDetail(id, bindings);
  assert.deepEqual(detail?.usage, [{ route: "tutor", admitted: 1, refused: 0 }]);
  assert.equal(await nativeDirectory.cloudflareAdminDirectoryDetail(deleted, bindings), null);
});

test("the ids CTE is never rebuilt as a UNION ALL per account — the in-memory D1 fixture has no branch limit to catch it if it were", () => {
  const source = readFileSync(
    join(ROOT, "lib", "cloudflare", "admin-entitlement-directory.ts"),
    "utf8",
  );
  // Comments are stripped first: the fix's own explanation legitimately
  // mentions "UNION ALL" in prose, describing what this file used to do.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  assert.doesNotMatch(code, /UNION ALL/);
  assert.match(code, /json_each/);
});

/* ------------------------------------------------------------- route wiring -- */

test("the users list route has a full D1-native roster path and preserves the legacy bridge path", () => {
  const source = readFileSync(join(ROOT, "app", "api", "admin", "users", "route.ts"), "utf8");
  assert.match(source, /domainReadsFromCloudflare\("admin_user_directory"\)/);
  assert.match(source, /cloudflareAdminDirectoryPage/);
  assert.match(source, /!supabaseConfigured\(\)/);
  assert.match(source, /cloudflareAdminDirectoryEntitlements/);
  assert.match(source, /d1_mirror_missing: true/);
  // ADMIN_EMAILS must still be applied on top of whichever backend answered.
  assert.match(source, /applyOwnerEffectiveAccess\(users\)/);
  assert.doesNotMatch(source, /domainDataMode\([^)]*\)\s*===/, "must ask domainReadsFromCloudflare(), never re-derive the mode string");
});

test("the user detail route has the same D1-native identity path as the list", () => {
  const source = readFileSync(join(ROOT, "app", "api", "admin", "users", "[id]", "route.ts"), "utf8");
  assert.match(source, /domainReadsFromCloudflare\("admin_user_directory"\)/);
  assert.match(source, /cloudflareAdminDirectoryDetail/);
  assert.match(source, /!supabaseConfigured\(\)/);
  assert.match(source, /cloudflareAdminDirectoryEntitlements/);
  assert.match(source, /d1MirrorMissing: true/);
  assert.match(source, /applyOwnerEffectiveAccessToDetail\(user\)/);
  assert.doesNotMatch(source, /domainDataMode\([^)]*\)\s*===/);
});

test("the stats route moves all figures to D1 when native identity is authoritative", () => {
  const source = readFileSync(join(ROOT, "app", "api", "admin", "stats", "route.ts"), "utf8");
  assert.match(source, /domainReadsFromCloudflare\("admin_statistics"\)/);
  assert.match(source, /cloudflareAdminUsageDaily/);
  assert.match(source, /cloudflareAdminUsageBreakdown/);
  assert.match(source, /cloudflareAdminTierCounts/);
  assert.match(source, /cloudflareAdminUserCount/);
  assert.match(source, /cloudflareAdminSignupsDaily/);
  assert.match(source, /nativeAuthCutoverActive/);
  assert.match(source, /rpc<number>\("admin_user_count", \{\}\)/);
  assert.match(source, /rpc<DayRow\[\]>\("admin_signups_daily", \{ p_days: DAYS \}\)/);
  assert.doesNotMatch(source, /domainDataMode\([^)]*\)\s*===/);
});

test("the cutover registry marks admin_user_directory and admin_statistics supported, including native identity", () => {
  const registry = readFileSync(join(ROOT, "lib", "cloudflare", "cutover-domains.ts"), "utf8");
  assert.match(registry, /domain: "admin_user_directory"[\s\S]{0,900}supported: true/);
  assert.match(registry, /domain: "admin_statistics"[\s\S]{0,900}supported: true/);
  assert.match(registry, /D1-native roster reader/);
  assert.match(registry, /live-account count/);
});
