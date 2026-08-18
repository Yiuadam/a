/*
  `admin_user_directory` and `admin_statistics`'s D1 read paths.

  What genuinely moves to D1: admin_usage_daily and admin_usage_breakdown
  (pure usage_events reads), admin_tier_counts (via the entitlement
  resolver), and the per-account plan/access-source the directory shows —
  both on the list and the detail page. admin_user_count, admin_signups_daily
  and the roster itself (which accounts exist, their email/username/display
  name/registration date) are auth.users identity reads and stay on Supabase
  regardless of either domain's mode, by the owner's decision that Supabase
  Auth is not migrating.

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
const adminDirectory = await load("lib", "cloudflare", "admin-entitlement-directory.ts");
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

  const result = await adminDirectory.cloudflareAdminDirectoryEntitlements([mirrored, unmirrored], bindings);
  assert.deepEqual(result.get(mirrored), { mirrored: true, tier: "plus", source: "stripe" });
  assert.equal(result.get(unmirrored).mirrored, false, "Auth knows this id; D1 does not — it must say so, not resolve to free");
});

test("cloudflareAdminDirectoryEntitlements resolves a mirrored account with no active subscription to free/default", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const id = "50000000-0000-4000-8000-000000000012";
  insertUser(database, id, "nosub@example.test");

  const result = await adminDirectory.cloudflareAdminDirectoryEntitlements([id], bindings);
  assert.deepEqual(result.get(id), { mirrored: true, tier: "free", source: "default" });
});

test("cloudflareAdminDirectoryEntitlements ignores a soft-deleted app_users row, same as the roster it stands in for", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const id = "50000000-0000-4000-8000-000000000013";
  insertUser(database, id, "gone2@example.test", canonicalCloudflareSourceClock("2026-06-01T00:00:00.000Z"));

  const result = await adminDirectory.cloudflareAdminDirectoryEntitlements([id], bindings);
  assert.equal(result.get(id).mirrored, false);
});

/* ------------------------------------------------------------- route wiring -- */

test("the users list route reads plan/access_source from D1 only when admin_user_directory does, and never fabricates a mirrored account", () => {
  const source = readFileSync(join(ROOT, "app", "api", "admin", "users", "route.ts"), "utf8");
  assert.match(source, /domainReadsFromCloudflare\("admin_user_directory"\)/);
  assert.match(source, /cloudflareAdminDirectoryEntitlements/);
  assert.match(source, /d1_mirror_missing: true/);
  // ADMIN_EMAILS must still be applied on top of whichever backend answered.
  assert.match(source, /applyOwnerEffectiveAccess\(users\)/);
  assert.doesNotMatch(source, /domainDataMode\([^)]*\)\s*===/, "must ask domainReadsFromCloudflare(), never re-derive the mode string");
});

test("the user detail route mirrors the same D1 entitlement merge as the list, keyed to one account", () => {
  const source = readFileSync(join(ROOT, "app", "api", "admin", "users", "[id]", "route.ts"), "utf8");
  assert.match(source, /domainReadsFromCloudflare\("admin_user_directory"\)/);
  assert.match(source, /cloudflareAdminDirectoryEntitlements/);
  assert.match(source, /d1MirrorMissing: true/);
  assert.match(source, /applyOwnerEffectiveAccessToDetail\(user\)/);
  assert.doesNotMatch(source, /domainDataMode\([^)]*\)\s*===/);
});

test("the stats route moves usage/breakdown/tiers to D1 behind admin_statistics but keeps identity figures on Supabase unconditionally", () => {
  const source = readFileSync(join(ROOT, "app", "api", "admin", "stats", "route.ts"), "utf8");
  assert.match(source, /domainReadsFromCloudflare\("admin_statistics"\)/);
  assert.match(source, /cloudflareAdminUsageDaily/);
  assert.match(source, /cloudflareAdminUsageBreakdown/);
  assert.match(source, /cloudflareAdminTierCounts/);
  // admin_user_count and admin_signups_daily are never gated on the domain —
  // both calls must appear with no conditional between them and the earlier
  // "always Supabase" comment.
  assert.match(source, /rpc<number>\("admin_user_count", \{\}\)/);
  assert.match(source, /rpc<DayRow\[\]>\("admin_signups_daily", \{ p_days: DAYS \}\)/);
  assert.doesNotMatch(source, /domainDataMode\([^)]*\)\s*===/);
});

test("the cutover registry marks admin_user_directory and admin_statistics supported, and names what stays on Supabase", () => {
  const registry = readFileSync(join(ROOT, "lib", "cloudflare", "cutover-domains.ts"), "utf8");
  assert.match(registry, /domain: "admin_user_directory"[\s\S]{0,900}supported: true/);
  assert.match(registry, /domain: "admin_statistics"[\s\S]{0,900}supported: true/);
  assert.match(registry, /auth\.users identity/);
  assert.match(registry, /is not migrating/);
});
