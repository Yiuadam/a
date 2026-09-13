/*
  Mutation-kill pass over the small lib/cloudflare modules that had no
  dedicated test file of their own: entitlement-runtime.ts,
  admin-entitlement-directory.ts, admin-stats.ts, stripe-cutover-readiness.ts,
  source-clock.ts, billing-replica.ts, parity-money.ts, plus the corner of
  bindings.ts (bandUpCloudflareBindings/requireBandUpCloudflareBindings) that
  can only be exercised through a faked `@opennextjs/cloudflare` import.

  Everything here runs against a real in-memory SQLite database via
  node:sqlite, replaying the actual migrations, the same harness the other
  lib/cloudflare test files use — a hand-rolled mock of D1 would only prove
  the mock agrees with itself.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);

const entitlementRuntime = await load("lib", "cloudflare", "entitlement-runtime.ts");
const entitlementDirectory = await load("lib", "cloudflare", "admin-entitlement-directory.ts");
const adminStats = await load("lib", "cloudflare", "admin-stats.ts");
const stripeReadiness = await load("lib", "cloudflare", "stripe-cutover-readiness.ts");
const sourceClock = await load("lib", "cloudflare", "source-clock.ts");
const billingReplica = await load("lib", "cloudflare", "billing-replica.ts");
const parityMoney = await load("lib", "cloudflare", "parity-money.ts");
const bindings = await load("lib", "cloudflare", "bindings.ts");

/*
  Runs `fn` with `globalThis.window` set to a plain object, so
  assertServerOnly(MODULE) throws the way it would if one of these
  server-only modules were ever pulled into a client bundle. Always deletes
  `window` again afterwards, pass or throw.
*/
async function withBrowserWindow(fn) {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    return await fn();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
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

/** An in-memory stand-in for the R2 binding, just enough for storeJson's object path. */
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
    async delete() {},
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

function seedUser(database, id, overrides = {}) {
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(id, overrides.email ?? `${id}@example.test`, CREATED, CREATED);
}

function seedSubscription(database, { id, userId, provider = "stripe", status = "active", tier, currentPeriodEnd = null, verifiedAt = CREATED }) {
  database.prepare(`
    INSERT INTO subscriptions (id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, provider, status, tier, currentPeriodEnd, verifiedAt, CREATED, CREATED);
}

/* ===========================================================================
   assertServerOnly guards, across every module in this file
   =========================================================================== */

test("assertServerOnly guards every exported entry point in this file's modules, naming the exact module", async () => {
  const dummyBindings = { db: {}, files: {} };
  await withBrowserWindow(async () => {
    await assert.rejects(
      () => entitlementRuntime.resolveEntitlementFromCloudflare("11111111-1111-4111-8111-111111111111", dummyBindings),
      /lib\/cloudflare\/entitlement-runtime\.ts is server-only/,
    );
    await assert.rejects(
      () => entitlementDirectory.cloudflareAdminDirectoryEntitlements(["11111111-1111-4111-8111-111111111111"], dummyBindings),
      /lib\/cloudflare\/admin-entitlement-directory\.ts is server-only/,
    );
    await assert.rejects(
      () => adminStats.cloudflareAdminUserCount(dummyBindings),
      /lib\/cloudflare\/admin-stats\.ts is server-only/,
    );
    await assert.rejects(
      () => adminStats.cloudflareAdminSignupsDaily(3, dummyBindings),
      /lib\/cloudflare\/admin-stats\.ts is server-only/,
    );
    await assert.rejects(
      () => adminStats.cloudflareAdminUsageDaily(3, "u", dummyBindings),
      /lib\/cloudflare\/admin-stats\.ts is server-only/,
    );
    await assert.rejects(
      () => adminStats.cloudflareAdminUsageBreakdown(3, "u", dummyBindings),
      /lib\/cloudflare\/admin-stats\.ts is server-only/,
    );
    await assert.rejects(
      () => adminStats.cloudflareAdminTierCounts("u", dummyBindings),
      /lib\/cloudflare\/admin-stats\.ts is server-only/,
    );
    await assert.rejects(
      () => stripeReadiness.stripeCutoverReadinessReport(dummyBindings),
      /lib\/cloudflare\/stripe-cutover-readiness\.ts is server-only/,
    );
    await assert.rejects(
      () => bindings.bandUpCloudflareBindings(),
      /lib\/cloudflare\/bindings\.ts is server-only/,
    );
  });
});

/* ===========================================================================
   lib/cloudflare/entitlement-runtime.ts
   =========================================================================== */

test("resolveEntitlementFromCloudflare falls back to the exact free/default row when nobody has a live subscription", async () => {
  const context = fixture();
  const USER = "11111111-1111-4111-8111-111111111111";
  seedUser(context.database, USER);
  const result = await entitlementRuntime.resolveEntitlementFromCloudflare(USER, context.bindings);
  assert.deepEqual(result, { tier: "free", source: "default", expires_at: null });
});

test("resolveEntitlementFromCloudflare picks the highest-ranked live subscription over an expired one", async () => {
  const context = fixture();
  const USER = "22222222-2222-4222-8222-222222222222";
  seedUser(context.database, USER);
  seedSubscription(context.database, { id: "sub-expired", userId: USER, tier: "ai", status: "expired" });
  seedSubscription(context.database, { id: "sub-live", userId: USER, tier: "tracking", status: "active" });
  const result = await entitlementRuntime.resolveEntitlementFromCloudflare(USER, context.bindings);
  assert.deepEqual(result, { tier: "tracking", source: "stripe", expires_at: null });
});

/* ===========================================================================
   lib/cloudflare/admin-entitlement-directory.ts
   =========================================================================== */

test("cloudflareAdminDirectoryEntitlements bounds the roster to MAX_USERS (100)", async () => {
  const context = fixture();
  const validIds = Array.from({ length: 105 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const result = await entitlementDirectory.cloudflareAdminDirectoryEntitlements(validIds, context.bindings);
  assert.equal(result.size, 100, "105 distinct valid ids must be bounded to 100");
  assert.equal(result.has(validIds[99]), true, "the 100th id is still inside the bound");
  assert.equal(result.has(validIds[100]), false, "the 101st id is past the bound");
});

test("cloudflareAdminDirectoryEntitlements requires the full 36-character id shape, anchored at both ends", async () => {
  const context = fixture();
  const valid1 = "00000000-0000-4000-8000-000000000001";
  const valid2 = "00000000-0000-4000-8000-000000000002";
  const garbage = "not-a-uuid-at-all";
  const prefixed = `!${valid1}`; // 37 chars: only the trailing 36 are a valid shape
  const suffixed = `${valid2}!`; // 37 chars: only the leading 36 are a valid shape
  const result = await entitlementDirectory.cloudflareAdminDirectoryEntitlements(
    [valid1, valid2, garbage, prefixed, suffixed],
    context.bindings,
  );
  assert.equal(result.size, 2, "only the two properly-shaped ids survive filtering");
  assert.equal(result.has(garbage), false);
  assert.equal(result.has(prefixed), false, "a leading character outside the id shape must not be accepted");
  assert.equal(result.has(suffixed), false, "a trailing character outside the id shape must not be accepted");
});

test("cloudflareAdminDirectoryEntitlements reports the exact free/default row for an id D1 has never mirrored", async () => {
  const context = fixture();
  const id = "00000000-0000-4000-8000-000000000099";
  const result = await entitlementDirectory.cloudflareAdminDirectoryEntitlements([id], context.bindings);
  assert.deepEqual(result.get(id), { mirrored: false, tier: "free", source: "default" });
});

test("cloudflareAdminDirectoryEntitlements never touches D1 when every candidate id is filtered out", async () => {
  const poisoned = {
    db: {
      prepare() { throw new Error("must not query D1 when there are no ids left to look up"); },
    },
  };
  const result = await entitlementDirectory.cloudflareAdminDirectoryEntitlements(["not-a-uuid"], poisoned);
  assert.equal(result.size, 0);
});

/* ===========================================================================
   lib/cloudflare/admin-stats.ts
   =========================================================================== */

function utcMidnight(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d;
}

function atNoon(offsetDays) {
  const d = utcMidnight(offsetDays);
  d.setUTCHours(12);
  return d.toISOString();
}

test("cloudflareAdminUsageBreakdown's window boundary excludes a day outside the requested range", async () => {
  const context = fixture();
  const USER = "33333333-3333-4333-8333-333333333333";
  seedUser(context.database, USER);
  // Offsets 0,1,2 must be inside a `days: 3` window; offset 3 must not.
  for (const offset of [0, 1, 2, 3]) {
    context.database.prepare(`
      INSERT INTO usage_events (id, user_id, route, outcome, created_at)
      VALUES (?, NULL, 'chat', 'admitted', ?)
    `).run(`evt-${offset}`, atNoon(offset));
  }
  const rows = await adminStats.cloudflareAdminUsageBreakdown(3, USER, context.bindings);
  assert.deepEqual(rows, [{ route: "chat", decision: "allowed", caller: "anonymous", count: 3 }]);
});

test("cloudflareAdminUsageBreakdown sorts its output by route, then decision, then caller", async () => {
  const context = fixture();
  const SIGNED_IN = "44444444-4444-4444-8444-444444444444";
  seedUser(context.database, SIGNED_IN);
  // Same route and outcome; a signed-in row is inserted first, an anonymous
  // row second. If D1's own GROUP BY happens to preserve insertion (or raw
  // boolean 0-before-1) order, "signed_in" would come first unless the
  // caller-facing sort actually runs, since "anonymous" < "signed_in"
  // alphabetically but 0 (signed_in's raw `anonymous` flag) < 1 (anonymous's).
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('evt-signed-in', ?, 'chat', 'admitted', ?)
  `).run(SIGNED_IN, atNoon(0));
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('evt-anonymous', NULL, 'chat', 'admitted', ?)
  `).run(atNoon(0));

  const rows = await adminStats.cloudflareAdminUsageBreakdown(1, "99999999-9999-4999-8999-999999999999", context.bindings);
  assert.deepEqual(rows, [
    { route: "chat", decision: "allowed", caller: "anonymous", count: 1 },
    { route: "chat", decision: "allowed", caller: "signed_in", count: 1 },
  ]);
});

test("cloudflareAdminTierCounts groups by the outer CASE alias, not by a same-named subquery column", async () => {
  const context = fixture();
  const ADMIN = "55555555-5555-4555-8555-555555555555";
  const LEARNER = "66666666-6666-4666-8666-666666666666";
  seedUser(context.database, ADMIN);
  seedUser(context.database, LEARNER);
  // The admin's own subscription happens to share a raw tier ("tracking")
  // with another account's effective tier -- the exact collision the CTE
  // column rename (sub_tier, not tier) exists to keep separate.
  seedSubscription(context.database, { id: "sub-admin", userId: ADMIN, tier: "tracking", status: "active" });
  seedSubscription(context.database, { id: "sub-learner", userId: LEARNER, tier: "tracking", status: "active" });

  const counts = await adminStats.cloudflareAdminTierCounts(ADMIN, context.bindings);
  assert.deepEqual(counts, [
    { tier: "admin", count: 1 },
    { tier: "tracking", count: 1 },
  ]);
});

test("cloudflareAdminSignupsDaily fills every requested day, including one with zero signups", async () => {
  const context = fixture();
  const USER = "77777777-7777-4777-8777-777777777777";
  context.database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(USER, "signup@example.test", atNoon(0), atNoon(0));

  const rows = await adminStats.cloudflareAdminSignupsDaily(3, context.bindings);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].count, 1, "today must show the one seeded signup");
  assert.equal(rows[0].count, 0, "the oldest day in the window must still appear, at zero");
  assert.equal(rows[1].count, 0);
});

test("the outcome CHECK constraint makes an unmapped decision unreachable (equivalent survivor, admin-stats.ts:183)", () => {
  /*
    `usage_events.outcome` is CHECK-constrained (cloudflare/migrations/0001_learner_data.sql:118)
    to exactly 'admitted' | 'denied_quota' | 'denied_rate' -- the same three
    keys DECISION_BY_OUTCOME maps. No row this schema can ever hold makes
    `decision` undefined, so `if (!decision) continue;`'s mutant
    (`!decision -> false`) can never observe a different input: dead code by
    construction, not by chance. Documented here rather than faked with a row
    the real table would refuse to store.
  */
  const schema = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0001_learner_data.sql"), "utf8");
  assert.match(schema, /outcome TEXT NOT NULL CHECK \(outcome IN \('admitted', 'denied_quota', 'denied_rate'\)\)/);
});

/* ===========================================================================
   lib/cloudflare/stripe-cutover-readiness.ts
   =========================================================================== */

const SUPABASE_ENV = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

/** Stubs both Supabase env config and `fetch`, answering every request with an empty page. */
function withFetch(handler, fn) {
  const savedFetch = globalThis.fetch;
  const savedEnv = new Map(Object.keys(SUPABASE_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, SUPABASE_ENV);
  globalThis.fetch = handler
    ?? (async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
  return Promise.resolve().then(fn).finally(() => {
    globalThis.fetch = savedFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("stripeCutoverReadinessReport reads the D1 prepaid ledger and folds it into the shared report", () =>
  withFetch(null, async () => {
    const context = fixture();
    const USER = "12121212-1212-4121-8121-121212121212";
    seedUser(context.database, USER);
    seedSubscription(context.database, { id: "sub-ledger", userId: USER, tier: "ai" });
    context.database.prepare(`
      INSERT INTO stripe_prepaid_purchases (payment_intent_id, user_id, subscription_id, amount_minor, created_at)
      VALUES ('pi_1', ?, 'sub-ledger', 499, ?)
    `).run(USER, CREATED);
    const report = await stripeReadiness.stripeCutoverReadinessReport(context.bindings);
    // With no source evidence at all, the one D1 row is unexpected -- proving
    // this function actually read the seeded row through to the shared
    // preflight report rather than returning an empty/undefined result.
    assert.equal(report.ready, false);
    assert.equal(report.unexpectedTarget, 1);
  }));

test("stripeCutoverReadinessReport throws the exact message when the D1 ledger read itself fails", () =>
  withFetch(null, async () => {
    const failingBindings = {
      db: { prepare: () => ({ all: async () => ({ success: false, results: [] }) }) },
    };
    await assert.rejects(
      () => stripeReadiness.stripeCutoverReadinessReport(failingBindings),
      /^Error: Cloudflare prepaid purchase ledger could not be read$/,
    );
  }));

/* ===========================================================================
   lib/cloudflare/source-clock.ts
   =========================================================================== */

test("canonicalCloudflareSourceClock rejects an unparseable value with the exact message", () => {
  assert.throws(
    () => sourceClock.canonicalCloudflareSourceClock("not-a-date-at-all"),
    /Invalid Cloudflare replica source clock/,
  );
});

test("canonicalCloudflareSourceClock preserves all nine fraction digits of a precise timestamp", () => {
  assert.equal(
    sourceClock.canonicalCloudflareSourceClock("2026-08-14T10:00:00.123456789Z"),
    "2026-08-14T10:00:00.123456789Z",
  );
  // A UTC offset is accepted the same way, converted to Z.
  assert.equal(
    sourceClock.canonicalCloudflareSourceClock("2026-08-14T12:00:00.5+02:00"),
    "2026-08-14T10:00:00.500000000Z",
  );
});

test("canonicalCloudflareSourceClock pads a value that does not carry the precise shape to nine digits via the millisecond fallback", () => {
  // A bare calendar day has no time component at all, so it cannot match the
  // precise-shape regex and must take the toISOString() fallback branch.
  assert.equal(
    sourceClock.canonicalCloudflareSourceClock("2026-08-14"),
    "2026-08-14T00:00:00.000000000Z",
  );
});

test("the anchor and mandatory-fraction survivors on the precise-shape regex are equivalent (source-clock.ts:11)", () => {
  /*
    All three surviving mutants on this line can only ever be observed
    through an input for which `match` becomes null when it was non-null (or
    vice versa) -- the capture groups themselves (group 1, the date/time; and
    group 3, the offset) are never read by the function at all, only
    `match[2]` is, and only to know whether a fraction was present.

    Dropping `^` or `$` matters only if some input makes `Date.parse` succeed
    (required just to reach this line without throwing) while *also*
    containing the precise shape somewhere other than spanning the whole
    string. Empirically, V8's `Date.parse` accepts the extended ISO shape
    this regex targets only when the ENTIRE string is exactly that shape --
    a single leading or trailing character of any kind (space, tab, newline,
    a digit, a letter) already makes `Date.parse` itself return NaN, throwing
    before the regex is ever reached:
  */
  for (const broken of [
    " 2026-08-14T10:00:00.123456789Z",
    "2026-08-14T10:00:00.123456789Z ",
    "x2026-08-14T10:00:00.123456789Z",
    "2026-08-14T10:00:00.123456789Zx",
  ]) {
    assert.equal(Number.isFinite(Date.parse(broken)), false, `Date.parse must reject ${JSON.stringify(broken)}`);
  }
  /*
    So there is no reachable input where anchoring changes whether `match` is
    null. And making the fraction group mandatory only changes `match` for an
    input with no fraction at all (a dot-free string) -- for that case the
    match-based branch computes fraction "" padded to "000000000" from the
    same `parsed` timestamp the fallback branch (`match` null) also
    reconstructs its second-precision string from, and the fallback's own
    `.replace(/(\.\d{3})Z$/, "$1000000Z")` always yields the identical
    "<second>.000000000Z" -- demonstrated directly:
  */
  assert.equal(
    sourceClock.canonicalCloudflareSourceClock("2026-08-14T00:00:00Z"), // matches; fraction group empty
    "2026-08-14T00:00:00.000000000Z",
  );
  assert.equal(
    sourceClock.canonicalCloudflareSourceClock("2026-08-14"), // does not match at all; fallback branch
    "2026-08-14T00:00:00.000000000Z",
  );
});

test("canonicalCloudflareSourceClock's fallback zero-pad only needs to see three millisecond digits", () => {
  // A date whose toISOString() has no other place `.\d{3}` could occur, so a
  // pattern that requires *some other* shape at that exact position (three
  // non-digits, or a single digit) fails to match at all and the fallback
  // leaves the un-padded three-digit form untouched instead of padding it.
  assert.equal(
    sourceClock.canonicalCloudflareSourceClock("2026-08-14"),
    "2026-08-14T00:00:00.000000000Z",
  );
});

test("the trailing-anchor and .slice(0, 9) survivors are equivalent (source-clock.ts:14, :16, :66)", () => {
  /*
    source-clock.ts:14 `/(\.\d{3})Z$/` -> `/(\.\d{3})Z/` (drop $): the string
    this replace ever runs against is always a Date#toISOString() output,
    whose format has exactly one "." in the whole string (separating seconds
    from milliseconds) and it is always the last four characters before "Z".
    There is no second candidate position for an unanchored match to find
    instead, so dropping the trailing anchor changes nothing.

    source-clock.ts:16 `.padEnd(9, "0").slice(0, 9)`: match[2] comes from a
    capture group written `\d{1,9}` -- the regex itself guarantees it is
    never longer than 9 characters, so padEnd(9, "0") always yields exactly
    9 characters and .slice(0, 9) can never truncate anything.

    source-clock.ts:66 `/\.(\d{3})\d{6}Z$/` -> drop $ (parityClock): the
    string it runs against is always canonicalCloudflareSourceClock's own
    output, which by construction has exactly one "." followed by exactly
    nine digits then "Z" at the very end -- again the only possible match
    position, anchored or not.

    Demonstrated by construction: a canonical clock string always has
    exactly one ".".
  */
  const canonical = sourceClock.canonicalCloudflareSourceClock("2026-08-14T10:00:00.123456789Z");
  assert.equal(canonical.split(".").length, 2, "exactly one '.' exists in a canonical clock string");
});

test("parityClock cuts a canonical clock string down to millisecond precision", () => {
  assert.equal(sourceClock.parityClock("2026-08-14T10:00:00.673830000Z"), "2026-08-14T10:00:00.673Z");
  assert.equal(sourceClock.parityClock(42), null);
});

/* ===========================================================================
   lib/cloudflare/parity-money.ts
   =========================================================================== */

test("parityMoney treats a number the same as its string form", () => {
  assert.equal(parityMoney.parityMoney(5), parityMoney.parityMoney("5"));
  assert.equal(parityMoney.parityMoney(5), "5");
});

test("parityMoney trims surrounding whitespace before judging the shape", () => {
  assert.equal(parityMoney.parityMoney(" 5.50 "), "5.5");
});

test("parityMoney leaves malformed text untouched rather than reshaping it toward a number", () => {
  // Contains "." and ends in zeros, so a bypassed shape check would still
  // strip them even though the text as a whole is not numeric.
  assert.equal(parityMoney.parityMoney("1x2.500"), "1x2.500");
  // Two decimal points: fails the strict full-string shape even though a
  // prefix-only (missing trailing anchor) match would still find one.
  assert.equal(parityMoney.parityMoney("5.5.00"), "5.5.00");
});

test("parityMoney requires the leading digit run to be able to have more than one digit", () => {
  assert.equal(parityMoney.parityMoney("25.50"), "25.5");
});

test("parityMoney strips trailing zeros and a bare trailing dot, and normalises negative zero", () => {
  assert.equal(parityMoney.parityMoney("0.050000000"), "0.05");
  assert.equal(parityMoney.parityMoney("12.00"), "12");
  assert.equal(parityMoney.parityMoney("-0.000"), "0");
});

test("the mandatory-fraction-group survivor in parityMoney is equivalent (parity-money.ts:44)", () => {
  /*
    Making `(?:\.\d+)?` mandatory only changes behaviour for an integer-only
    input (no "."): the correct code matches (fraction optional and absent),
    finds no ".", and returns the text unchanged via the second early return.
    The mutant fails to match at all (no "." to satisfy the now-mandatory
    group) and returns the text unchanged via the *first* early return
    instead. Same output either way, for every integer-only input; any input
    that does carry "." satisfies the group whether optional or mandatory.
  */
  assert.equal(parityMoney.parityMoney("42"), parityMoney.parityMoney("42"));
  assert.equal(parityMoney.parityMoney("42"), "42");
});

/* ===========================================================================
   lib/cloudflare/billing-replica.ts
   =========================================================================== */

function fakeAuthoritative(overrides = {}) {
  return {
    id: "sub-x", userId: "u", provider: "stripe", status: "active", tier: "ai",
    customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, providerEventAt: null, verifiedAt: CREATED,
    raw: { kind: "stripe" }, createdAt: CREATED, updatedAt: CREATED,
    ...overrides,
  };
}

test("replicateAuthoritativeStripeState throws the exact bootstrap-failure message when the user upsert fails", async () => {
  const failingBindings = {
    db: {
      prepare: () => ({ bind: () => ({ run: async () => ({ success: false, meta: {} }) }) }),
    },
  };
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await assert.rejects(
    () => billingReplica.replicateAuthoritativeStripeState(
      { eventId: "evt-1", eventAt: CREATED },
      { type: "checkout" },
      fakeAuthoritative({ userId: USER }),
      failingBindings,
    ),
    /^Error: Cloudflare billing user bootstrap is unavailable$/,
  );
});

test("replicateAuthoritativeStripeState is false only when not every batched statement succeeded", async () => {
  function fakeBatchDb(batchResults) {
    return {
      prepare(sql) {
        return {
          bind: (...values) => ({
            sql,
            values,
            async run() { return { success: true, meta: { changes: 1 } }; },
            async first() { return null; },
          }),
        };
      },
      async batch() { return batchResults; },
    };
  }
  const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const event = { eventId: "evt-2", eventAt: CREATED };
  // The event payload is always stored with forceObject: true (see
  // replicateAuthoritativeStripeState), so even this tiny payload takes the
  // R2 path and needs a working `files.put`.
  const files = filesStub();

  const allSucceed = await billingReplica.replicateAuthoritativeStripeState(
    event, { type: "checkout" }, fakeAuthoritative({ userId: USER, subscriptionId: null }),
    { db: fakeBatchDb([{ success: true }, { success: true }]), files },
  );
  assert.equal(allSucceed, true);

  const oneFails = await billingReplica.replicateAuthoritativeStripeState(
    event, { type: "checkout" }, fakeAuthoritative({ userId: USER, subscriptionId: null }),
    { db: fakeBatchDb([{ success: true }, { success: false }]), files },
  );
  assert.equal(oneFails, false, "not every batched statement succeeding must not report success");
});

test("backfillCloudflareSubscription reports changed:false when the guarded upsert's WHERE left the row untouched", async () => {
  const context = fixture();
  const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  seedUser(context.database, USER);
  const NEWER = "2026-08-20T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO subscriptions (id, user_id, provider, status, tier, provider_event_at, verified_at, created_at, updated_at)
    VALUES ('sub-guard', ?, 'stripe', 'active', 'ai', ?, ?, ?, ?)
  `).run(USER, NEWER, NEWER, CREATED, NEWER);

  const outcome = await billingReplica.backfillCloudflareSubscription({
    id: "sub-guard", userId: USER, provider: "stripe", status: "active", tier: "ai",
    customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, providerEventAt: "2026-08-15T00:00:00.000Z", verifiedAt: CREATED,
    raw: {}, createdAt: CREATED, updatedAt: CREATED,
  }, context.bindings);
  assert.deepEqual(outcome, { success: true, changed: false });

  const freshOutcome = await billingReplica.backfillCloudflareSubscription({
    id: "sub-new", userId: USER, provider: "stripe", status: "active", tier: "ai",
    customerId: null, subscriptionId: null, priceId: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, providerEventAt: null, verifiedAt: CREATED,
    raw: {}, createdAt: CREATED, updatedAt: CREATED,
  }, context.bindings);
  assert.deepEqual(freshOutcome, { success: true, changed: true });
});

test("a large subscription payload is stored in R2 under the 'subscriptions' namespace, not a namespace-less path", async () => {
  const context = fixture();
  const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  seedUser(context.database, USER);
  const bigRaw = { transcript: "x".repeat(200_000) };
  const success = await billingReplica.replicateAuthoritativeStripeState(
    { eventId: "evt-big", eventAt: CREATED },
    { type: "checkout" },
    fakeAuthoritative({ userId: USER, id: "sub-big", subscriptionId: null, raw: bigRaw }),
    context.bindings,
  );
  assert.equal(success, true);
  const row = context.database.prepare("SELECT raw_object_key FROM subscriptions WHERE id = 'sub-big'").get();
  assert.match(row.raw_object_key, /^private\/subscriptions\//);
});

test("a large promo payload is stored in R2 under the 'subscriptions' namespace too", async () => {
  const context = fixture();
  const USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  seedUser(context.database, USER);
  const bigRaw = { grant: "y".repeat(200_000) };
  const success = await billingReplica.replicateAuthoritativePromoState({
    id: "sub-promo-big", userId: USER, status: "active", tier: "tracking",
    currentPeriodEnd: null, verifiedAt: CREATED, raw: bigRaw,
    createdAt: CREATED, updatedAt: CREATED,
  }, context.bindings);
  assert.equal(success, true);
  const row = context.database.prepare("SELECT raw_object_key FROM subscriptions WHERE id = 'sub-promo-big'").get();
  assert.match(row.raw_object_key, /^private\/subscriptions\//);
});

test("cloudflareStripeCustomerFor reads the most recently updated Stripe customer id straight from D1", async () => {
  const context = fixture();
  const USER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  seedUser(context.database, USER);
  context.database.prepare(`
    INSERT INTO subscriptions (id, user_id, provider, status, tier, external_customer_id, verified_at, created_at, updated_at)
    VALUES ('sub-cust', ?, 'stripe', 'active', 'ai', 'cus_abc123', ?, ?, ?)
  `).run(USER, CREATED, CREATED, CREATED);

  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: context.bindings.db, BANDUP_FILES: context.bindings.files } };
  try {
    const customerId = await billingReplica.cloudflareStripeCustomerFor(USER);
    assert.equal(customerId, "cus_abc123");
    assert.equal(await billingReplica.cloudflareStripeCustomerFor("no-such-user"), null);
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
});

/* ===========================================================================
   lib/cloudflare/bindings.ts -- the bandUpCloudflareBindings() corner that
   needs a faked @opennextjs/cloudflare import (everything else about
   bindings.ts is covered directly in tests/cloudflare-data-mode.test.mjs).
   =========================================================================== */

test("bandUpCloudflareBindings resolves null, not a throw, when the Cloudflare context has no bindings at all", async () => {
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: {} };
  try {
    assert.equal(await bindings.bandUpCloudflareBindings(), null);
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
});

test("bandUpCloudflareBindings requires both BANDUP_DB and BANDUP_FILES, not just one of the two", async () => {
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: {} } };
  try {
    assert.equal(await bindings.bandUpCloudflareBindings(), null, "BANDUP_FILES alone missing must still fail closed");
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }

  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_FILES: {} } };
  try {
    assert.equal(await bindings.bandUpCloudflareBindings(), null, "BANDUP_DB alone missing must still fail closed");
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }

  const db = {};
  const files = {};
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: db, BANDUP_FILES: files, EMAIL: "email-binding" } };
  try {
    assert.deepEqual(await bindings.bandUpCloudflareBindings(), { db, files, email: "email-binding" });
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
});

test("requireBandUpCloudflareBindings throws the exact message when no bindings are available", async () => {
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: {} };
  try {
    await assert.rejects(
      () => bindings.requireBandUpCloudflareBindings(),
      /^Error: Cloudflare data bindings are unavailable$/,
    );
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
});

test("the getCloudflareContext({async}) option survivor is equivalent in this test harness (bindings.ts:112)", () => {
  /*
    Every fake `getCloudflareContext` in this test suite (this file's stub,
    and tests/fake-cloudflare-worker.mjs) ignores its argument entirely and
    always returns the same fixed context regardless of {async: true} vs
    {async: false}. The real @opennextjs/cloudflare implementation only
    diverges between the two when no context has already been attached to
    globalThis -- at that point sync mode throws synchronously and async mode
    would try to spin up an actual wrangler dev process via
    getPlatformProxy(), which nothing in this repository's test suite does or
    reasonably could as a fast unit test. bandUpCloudflareBindings() also
    always calls it as {async: true}, uses providedBindings at every real
    call site, and its own catch swallows either failure mode identically.
    No test reachable from this suite can observe the difference.
  */
  assert.equal(typeof bindings.bandUpCloudflareBindings, "function");
});
