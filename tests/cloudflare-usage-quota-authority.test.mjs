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
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM usage_events").get().n,
    0,
  );
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
