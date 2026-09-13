/*
  The D1-only usage meter (lib/cloudflare/usage-quota-authority.ts).

  Everything here runs against a real in-memory SQLite database via
  node:sqlite, the same harness cloudflare-progress-atomic-runtime.test.mjs
  uses for its own single-statement guarded writes — a JS mock of `batch()`
  would only prove the mock was written to match the code under test.

  The `cloudflare_id_sequences` table is created and seeded here rather than
  read from a committed migration file: seeding it is an operator step the
  owner takes with `wrangler d1 execute` (see the pull request that added
  this file for the exact commands), not something checked into the repo.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const authority = await import(pathToFileURL(
  join(process.cwd(), "lib", "cloudflare", "usage-quota-authority.ts"),
).href);

function runtimeD1(database) {
  const execute = (sql, values) => {
    const result = database.prepare(sql).run(...values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes ?? 0) },
    };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute(sql, values); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
  });
  return {
    prepare(sql) {
      return {
        bind: (...values) => bound(sql, values),
        ...bound(sql, []),
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => execute(statement.sql, statement.values));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const SEQUENCE_SQL = `
  CREATE TABLE IF NOT EXISTS cloudflare_id_sequences (
    sequence_name TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL
  ) STRICT;
`;

function fixture({ seedSequence = true } = {}) {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  database.exec(SEQUENCE_SQL);
  if (seedSequence) {
    database.prepare(
      "INSERT INTO cloudflare_id_sequences (sequence_name, next_value) VALUES ('usage_events', 1000)",
    ).run();
  }
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

const USER = { id: "50000000-0000-4000-8000-000000000090", email: "quota@example.test" };
const OTHER_USER = { id: "50000000-0000-4000-8000-000000000091", email: "other-quota@example.test" };

function baseRequest(overrides = {}) {
  return {
    user: USER,
    userId: USER.id,
    ipHash: "quota-ip-hash",
    route: "chat",
    isAdmin: false,
    caps: { monthly: null, weekly: null, ip: null, anonymous: null },
    monthWindowSeconds: 30 * 24 * 60 * 60,
    windowSeconds: 7 * 24 * 60 * 60,
    now: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

test("an unlimited request admits and mints a numeric id", async () => {
  const context = fixture();
  const decision = await authority.admitUsageEventOnCloudflare(baseRequest(), context.bindings);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "ok");
  assert.equal(decision.eventOutcome, "admitted");
  assert.match(decision.eventId, /^[1-9]\d*$/);
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM usage_events").get().n,
    1,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM app_users WHERE id = ?").get(USER.id).n,
    1,
  );
});

test("the monthly cap denies as quota_exceeded once reached, and every attempt is recorded", async () => {
  const context = fixture();
  const request = baseRequest({ caps: { monthly: 2, weekly: null, ip: null, anonymous: null } });
  const first = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  const second = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  const third = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "quota_exceeded");
  assert.equal(third.eventOutcome, "denied_quota");
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM usage_events").get().n,
    3,
    "the refusal must still be recorded",
  );
  assert.equal(
    context.database.prepare(
      "SELECT count(*) AS n FROM usage_events WHERE outcome = 'admitted'",
    ).get().n,
    2,
    "the refusal must not have been counted as admitted",
  );
});

test("the weekly cap denies as rate_limited while the monthly allowance remains", async () => {
  const context = fixture();
  const request = baseRequest({ caps: { monthly: 100, weekly: 1, ip: null, anonymous: null } });
  const first = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  const second = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "rate_limited");
  assert.equal(second.eventOutcome, "denied_rate");
});

test("another route is unaffected by a route's own cap", async () => {
  const context = fixture();
  const chat = baseRequest({ caps: { monthly: 1, weekly: null, ip: null, anonymous: null } });
  const define = baseRequest({ route: "define", caps: { monthly: 1, weekly: null, ip: null, anonymous: null } });
  assert.equal((await authority.admitUsageEventOnCloudflare(chat, context.bindings)).allowed, true);
  assert.equal((await authority.admitUsageEventOnCloudflare(chat, context.bindings)).allowed, false);
  assert.equal(
    (await authority.admitUsageEventOnCloudflare(define, context.bindings)).allowed,
    true,
    "one route's cap must not touch another",
  );
});

test("the per-IP cap applies across users and admin is exempt from it", async () => {
  const context = fixture();
  const capped = { monthly: null, weekly: null, ip: 1, anonymous: null };
  const first = await authority.admitUsageEventOnCloudflare(
    baseRequest({ caps: capped }),
    context.bindings,
  );
  assert.equal(first.allowed, true);
  const second = await authority.admitUsageEventOnCloudflare(
    baseRequest({ user: OTHER_USER, userId: OTHER_USER.id, caps: capped }),
    context.bindings,
  );
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "rate_limited");

  const admin = await authority.admitUsageEventOnCloudflare(
    baseRequest({ user: OTHER_USER, userId: OTHER_USER.id, isAdmin: true, caps: capped }),
    context.bindings,
  );
  assert.equal(admin.allowed, true, "an admin must be exempt from the IP ceiling");
});

test("an anonymous caller is checked against the anonymous cap, keyed by IP", async () => {
  const context = fixture();
  const request = baseRequest({
    user: null,
    userId: null,
    caps: { monthly: null, weekly: null, ip: null, anonymous: 0 },
  });
  const decision = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "quota_exceeded");
  assert.equal(
    context.database.prepare("SELECT user_id FROM usage_events WHERE id = ?")
      .get(decision.eventId).user_id,
    null,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM app_users").get().n,
    0,
    "an anonymous denial must not manufacture an account",
  );
});

test("an unseeded id sequence fails loudly rather than silently uncapping", async () => {
  const context = fixture({ seedSequence: false });
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(baseRequest(), context.bindings),
    authority.CloudflareIdSequenceNotSeededError,
  );
  let caught = null;
  try {
    await authority.admitUsageEventOnCloudflare(baseRequest(), context.bindings);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.name, "CloudflareIdSequenceNotSeededError");
  assert.match(caught.message, /The D1 id counter for "usage_events" is not seeded\. This is an operator step, not /);
  assert.match(caught.message, /a bug: see the pull request that added lib\/cloudflare\/usage-quota-authority\.ts for /);
  assert.match(caught.message, /the exact wrangler d1 execute commands, and run them before setting this domain's /);
  assert.match(caught.message, /mode to 'cloudflare'\./);
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM usage_events").get().n,
    0,
  );
});

test("assertServerOnly guards admitUsageEventOnCloudflare, naming this exact module", async () => {
  const had = "window" in globalThis;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(
      () => authority.admitUsageEventOnCloudflare(baseRequest(), { db: {} }),
      /lib\/cloudflare\/usage-quota-authority\.ts is server-only/,
    );
  } finally {
    if (had) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
});

test("mintIds assigns sequential ids from the seeded counter, in order, to admit then deny", async () => {
  const context = fixture(); // seeds cloudflare_id_sequences at next_value: 1000
  // Denied from the very first attempt, so the *second* id minted in this one
  // reservation (the deny id) is what gets written and returned.
  const request = baseRequest({ caps: { monthly: 0, weekly: null, ip: null, anonymous: null } });
  const decision = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  assert.equal(decision.allowed, false);
  assert.equal(
    decision.eventId,
    "1001",
    "the deny id must be the counter value one past the admit id (1000+1), not one before it (1000-1)",
  );
});

test("the rolling window floor is exactly windowSeconds seconds, in milliseconds, before now", async () => {
  const context = fixture();
  const USER = "50000000-0000-4000-8000-000000000095";
  // A prior admitted event 3 days before `now`, well inside a 7-day rolling
  // window but nowhere near a window that was accidentally shrunk to
  // thousandths of a second.
  context.database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(USER, "window@example.test", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  context.database.prepare(`
    INSERT INTO usage_events (id, user_id, route, outcome, created_at)
    VALUES ('900', ?, 'chat', 'admitted', '2026-08-14T00:00:00.000Z')
  `).run(USER);

  const request = baseRequest({
    user: { id: USER, email: "window@example.test" },
    userId: USER,
    caps: { monthly: null, weekly: 1, ip: null, anonymous: null },
    windowSeconds: 7 * 24 * 60 * 60,
    now: "2026-08-17T00:00:00.000Z",
  });
  const decision = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  assert.equal(decision.allowed, false, "the 3-day-old admitted row is inside a real 7-day window and must count toward the cap");
  assert.equal(decision.reason, "rate_limited");
});

test("a null ipHash is never checked against the per-IP cap, even when a cap is configured", async () => {
  const context = fixture();
  const request = baseRequest({
    user: null,
    userId: null,
    ipHash: null,
    caps: { monthly: null, weekly: null, ip: 0, anonymous: null },
  });
  const decision = await authority.admitUsageEventOnCloudflare(request, context.bindings);
  assert.equal(decision.allowed, true, "an unknown caller IP must not be checked against an IP cap of zero");
});

test("a batch where not every statement succeeded throws the exact 'batch is unavailable' message", async () => {
  function fakeDb(batchResults) {
    return {
      prepare() {
        return { bind: () => ({ async first() { return { first_id: "2000" }; }, async run() { return { success: true, meta: { changes: 0 } }; } }) };
      },
      async batch() { return batchResults; },
    };
  }
  const request = baseRequest({
    user: null, userId: null, ipHash: "batch-ip",
    caps: { monthly: null, weekly: null, ip: null, anonymous: null },
  });
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(request, { db: fakeDb([{ success: false, meta: { changes: 0 } }, { success: true, meta: { changes: 0 } }]) }),
    /^Error: Cloudflare usage authority batch is unavailable$/,
  );
  // A truncated batch response (deny result entirely missing) must still
  // reach the same controlled message, not a raw "read of undefined" throw --
  // proving the `?.` on each half is load-bearing, not decorative.
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(request, { db: fakeDb([{ success: true, meta: { changes: 0 } }]) }),
    /^Error: Cloudflare usage authority batch is unavailable$/,
  );
  // A completely empty batch response (both results missing) exercises the
  // `?.` on the *first* half the same way.
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(request, { db: fakeDb([]) }),
    /^Error: Cloudflare usage authority batch is unavailable$/,
  );
});

test("neither statement admitting or denying is treated as a hard failure, with the exact message", async () => {
  function fakeDb() {
    return {
      prepare() {
        // Also stands in for mintIds's own counter read, which needs a
        // well-shaped row to get past minting at all.
        return { bind: () => ({ async first() { return { first_id: "3000" }; }, async run() { return { success: true, meta: { changes: 0 } }; } }) };
      },
      async batch() { return [{ success: true, meta: { changes: 0 } }, { success: true, meta: { changes: 0 } }]; },
    };
  }
  const request = baseRequest({
    user: null, userId: null, ipHash: "neither-ip",
    caps: { monthly: null, weekly: null, ip: null, anonymous: null },
  });
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(request, { db: fakeDb() }),
    /^Error: Cloudflare usage authority batch admitted no row and recorded no denial$/,
  );
});

test("an unparseable explicit `now` throws the exact message rather than minting against an invalid clock", async () => {
  const request = baseRequest({ now: "not-a-real-timestamp" });
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(request, fixture().bindings),
    /^Error: Invalid usage authority timestamp$/,
  );
});

test("a request whose user does not match its own userId is refused with the exact message, before any write", async () => {
  const context = fixture();
  const request = baseRequest({
    user: { id: OTHER_USER.id, email: OTHER_USER.email },
    userId: USER.id,
  });
  await assert.rejects(
    () => authority.admitUsageEventOnCloudflare(request, context.bindings),
    /^Error: Cloudflare usage authority request user does not match userId$/,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM usage_events").get().n, 0);
});

test("many concurrent admissions against a cap never exceed it", async () => {
  const context = fixture();
  const CAP = 5;
  const ATTEMPTS = 50;
  const request = baseRequest({ caps: { monthly: CAP, weekly: null, ip: null, anonymous: null } });

  const outcomes = await Promise.all(
    Array.from({ length: ATTEMPTS }, () => authority.admitUsageEventOnCloudflare(request, context.bindings)),
  );

  const admitted = outcomes.filter((decision) => decision.allowed).length;
  assert.equal(admitted, CAP, "a meter that only enforces the cap sequentially is not done");
  assert.equal(
    context.database.prepare(
      "SELECT count(*) AS n FROM usage_events WHERE outcome = 'admitted'",
    ).get().n,
    CAP,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM usage_events").get().n,
    ATTEMPTS,
    "every attempt — admitted or denied — must be recorded exactly once",
  );
  // Every minted id is unique: the admit/deny pair never collided even though
  // every attempt raced the same counter and the same cap.
  const distinctIds = new Set(
    context.database.prepare("SELECT id FROM usage_events").all().map((row) => row.id),
  );
  assert.equal(distinctIds.size, ATTEMPTS);
});
