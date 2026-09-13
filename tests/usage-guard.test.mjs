/*
  lib/usage/guard.ts's checkAiUsage: the one call every AI route makes before
  doing any work. Nothing here reaches a real Supabase project or a real
  Cloudflare Worker — Supabase is a fake fetch (the same technique
  tests/session-auth-outage.test.mjs and tests/billing-health.test.mjs use),
  and D1 is a real in-memory node:sqlite database behind the exact adapter
  tests/cloudflare-usage-quota-authority.test.mjs and
  tests/legacy-tier-aliases.test.mjs already use, wired in through
  tests/cutover-write-barrier-resolve.mjs's `@opennextjs/cloudflare` redirect.

  Two internal decisions are only observable through their side effects —
  mirrorUsageDecision and the "not configured" refusal both do their real work
  and then get logged by the SAME safeJsonError/logInternal machinery whether
  they ran correctly or a mutant skipped straight to a different failure
  mode — so several tests here intercept console.error and assert on the
  exact diagnostic label, the way an emptied block or a broken guard is meant
  to be caught.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./cutover-write-barrier-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);
const guard = await load("lib", "usage", "guard.ts");
const { checkAiUsage } = guard;

/* ------------------------------------------------------------- helpers -- */

/** Every env var any test below might touch, saved and restored around it. */
const ENV_KEYS = [
  "ACCOUNTS_ENABLED", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "USAGE_FAIL_OPEN", "ADMIN_EMAILS", "USAGE_IP_HASH_SALT",
  "CLOUDFLARE_DATA_MODE", "CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY",
  "CLOUDFLARE_NATIVE_AUTH", "ORGANIZATION_DATA_MODE",
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

/** Captures every console.error call made during `fn`, restoring it after. */
async function withLogs(fn) {
  const saved = console.error;
  const logs = [];
  console.error = (...parts) => logs.push(parts.join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.error = saved;
  }
}

const req = (headers) => new Request("https://bandup.life/api/x", { headers });
const anonymousReq = () => req({});

/* D1-over-SQLite adapter, the same shape every other D1 test in this repo uses. */
function runtimeD1(database) {
  const execute = (sql, values) => {
    const result = database.prepare(sql).run(...values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute(sql, values); },
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

/** A fresh D1-backed Cloudflare context, migrations replayed exactly as they ship. */
function d1Fixture({ seedUsageEventsSequence = true, armLearnerBarrier = false } = {}) {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(ROOT, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", file), "utf8"));
  }
  database.exec(SEQUENCE_SQL);
  if (seedUsageEventsSequence) {
    database.prepare(
      "INSERT INTO cloudflare_id_sequences (sequence_name, next_value) VALUES ('usage_events', 1000)",
    ).run();
  }
  if (armLearnerBarrier) {
    database.exec(readFileSync(join(ROOT, "scripts", "hand-run-cutover-write-barrier.sql"), "utf8"));
    database.prepare(`
      INSERT INTO cutover_write_barriers (domain, from_authority, to_authority, barrier_at, recorded_by, status)
      VALUES ('learner', 'supabase', 'cloudflare', '2026-01-01T00:00:00.000Z', 'test-harness', 'armed')
    `).run();
  }
  return { database, env: { BANDUP_DB: runtimeD1(database), BANDUP_FILES: { async put() {}, async get() { return null; }, async delete() {} } } };
}

function withCloudflareContext(env, fn) {
  globalThis.__CUTOVER_FAKE_CF_ENV__ = env;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete globalThis.__CUTOVER_FAKE_CF_ENV__;
    });
}

/* -------------------------------------------------------- server-only guard -- */

test("checkAiUsage refuses to run outside the server, naming this module", async () => {
  globalThis.window = {};
  try {
    await assert.rejects(
      () => checkAiUsage(anonymousReq(), "chat"),
      (error) => error instanceof Error && error.message.includes("lib/usage/guard.ts"),
    );
  } finally {
    delete globalThis.window;
  }
});

/* ------------------------------------------------------------ the flag -- */

test("with ACCOUNTS_ENABLED off, checkAiUsage allows everything and never touches the network", () =>
  withEnv({}, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("must not reach the network with accounts off"); };
    try {
      assert.equal(await checkAiUsage(anonymousReq(), "chat"), null);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

/* ------------------------------------------------- backend not configured -- */

test("with the runtime enabled through native auth but neither backend actually configured, checkAiUsage refuses at the configuration check, not deeper in", () =>
  withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      CLOUDFLARE_NATIVE_AUTH: "1",
      CLOUDFLARE_DATA_MODE: "cloudflare",
      ORGANIZATION_DATA_MODE: "cloudflare",
      CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY: "supabase",
    },
    async () => {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        throw new Error(`unexpected request to ${url}`);
      };
      try {
        const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
        assert.ok(result instanceof Response);
        assert.equal(result.status, 503);
        assert.ok(
          logs.some((l) => l.includes("checkAiUsage:") && l.includes("ACCOUNTS_ENABLED=1 but Supabase is not configured")),
          `expected the configuration-refusal log; got: ${JSON.stringify(logs)}`,
        );
        assert.ok(
          !logs.some((l) => l.includes("checkAiUsage/rpc")),
          "must refuse before ever attempting the Supabase RPC — a mutant that lets this through reaches the network instead",
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    },
  ));

/* --------------------------------------------------------- write barrier -- */

test("an armed learner write barrier refuses every call with a fixed sentence, naming itself in the log", () =>
  withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    },
    () =>
      withCloudflareContext(d1Fixture({ armLearnerBarrier: true }).env, async () => {
        const savedFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error("must not reach Supabase once the barrier is armed"); };
        try {
          const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
          assert.ok(result instanceof Response);
          assert.equal(result.status, 503);
          assert.ok(
            logs.some((l) => l.includes("checkAiUsage:") && l.includes("cutover write barrier is armed for learner writes")),
            `expected the barrier-armed log; got: ${JSON.stringify(logs)}`,
          );
        } finally {
          globalThis.fetch = savedFetch;
        }
      }),
  ));

/*
  ------------------------------------------------------------------------
  The Supabase branch's mirror to D1: mirrorUsageDecision.

  Every scenario below runs with CLOUDFLARE_DATA_MODE=dual (mirrorsWritesToCloudflare
  => true) but the usage_quota_authority domain pinned to "supabase", so
  checkAiUsage takes the RPC branch, calls check_and_record_usage_with_event,
  and always tries to mirror the result. With no Cloudflare context configured,
  the mirror itself always fails (bandUpCloudflareBindings() has nothing to
  resolve), which is what makes the two failure modes distinguishable purely
  from the label mirrorUsageDecision's own logInternal call ends up making:

    "D1 did not accept the usage event replica"                 — validation
      passed, the mirror genuinely could not write (expected here, since
      there is no D1 in most of these scenarios).
    "Supabase usage decision omitted its committed event identity" — the
      *decision itself* failed validation before a mirror was ever attempted.

  A mutant that widens or narrows the identity check, or that breaks the
  admitted/denied_rate/denied_quota mapping, changes which of the two shows
  up, or makes neither show up at all (the whole function's body emptied).
*/
function withMirroredRpc(decision, fn) {
  return withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      CLOUDFLARE_DATA_MODE: "dual",
      CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY: "supabase",
    },
    async () => {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/v1/rpc/check_and_record_usage_with_event") {
          return Response.json(decision);
        }
        throw new Error(`unexpected request to ${url}`);
      };
      try {
        const outcome = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
        return fn(outcome);
      } finally {
        globalThis.fetch = savedFetch;
      }
    },
  );
}

const D1_LOG = "D1 did not accept the usage event replica";
const OMITTED_LOG = "Supabase usage decision omitted its committed event identity";

function assertMirrorLog({ logs }, expected) {
  const replicaLogs = logs.filter((l) => l.includes("checkAiUsage/cloudflare-replica"));
  assert.equal(replicaLogs.length, 1, `expected exactly one cloudflare-replica log; got: ${JSON.stringify(logs)}`);
  assert.ok(
    replicaLogs[0].includes(expected),
    `expected "${expected}" in the replica log; got: ${replicaLogs[0]}`,
  );
}

test("an admitted decision with a matching eventOutcome passes validation and only fails at the mirror write", () =>
  withMirroredRpc(
    { allowed: true, reason: "ok", used: 1, quota: 10, eventId: "42", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "admitted" },
    (outcome) => assertMirrorLog(outcome, D1_LOG),
  ));

test("a rate-limited decision with a matching eventOutcome passes validation", () =>
  withMirroredRpc(
    { allowed: false, reason: "rate_limited", used: 5, quota: 5, eventId: "43", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "denied_rate" },
    (outcome) => assertMirrorLog(outcome, D1_LOG),
  ));

test("a quota-exceeded decision with a matching eventOutcome passes validation", () =>
  withMirroredRpc(
    { allowed: false, reason: "quota_exceeded", used: 10, quota: 10, eventId: "44", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "denied_quota" },
    (outcome) => assertMirrorLog(outcome, D1_LOG),
  ));

test("an eventOutcome that does not match the decision fails validation rather than being trusted", () =>
  withMirroredRpc(
    { allowed: true, reason: "ok", used: 1, quota: 10, eventId: "45", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "denied_quota" },
    (outcome) => assertMirrorLog(outcome, OMITTED_LOG),
  ));

test("a reason this build does not recognise as rate_limited or quota_exceeded resolves to no expected outcome at all", () =>
  withMirroredRpc(
    // A malformed decision: refused, but for neither of the two named reasons.
    // If the rate_limited or quota_exceeded checks were ever forced true this
    // would wrongly be accepted as "denied_quota".
    { allowed: false, reason: "something_else", used: 1, quota: 1, eventId: "46", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "denied_quota" },
    (outcome) => assertMirrorLog(outcome, OMITTED_LOG),
  ));

for (const [label, id] of [
  ["a single digit", "7"],
  ["several digits", "1000"],
]) {
  test(`a valid all-digit id (${label}) passes the identity check`, () =>
    withMirroredRpc(
      { allowed: true, reason: "ok", used: 1, quota: 10, eventId: id, eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "admitted" },
      (outcome) => assertMirrorLog(outcome, D1_LOG),
    ));
}

for (const [label, id] of [
  ["trailing non-digit characters", "123abc"],
  ["leading non-digit characters", "abc123"],
  ["a leading zero", "0123"],
  ["empty", ""],
]) {
  test(`an id with ${label} fails the identity check rather than being accepted`, () =>
    withMirroredRpc(
      { allowed: true, reason: "ok", used: 1, quota: 10, eventId: id, eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "admitted" },
      (outcome) => assertMirrorLog(outcome, OMITTED_LOG),
    ));
}

test("an unparseable committed-at timestamp fails the identity check", () =>
  withMirroredRpc(
    { allowed: true, reason: "ok", used: 1, quota: 10, eventId: "47", eventCreatedAt: "not a timestamp", eventOutcome: "admitted" },
    (outcome) => assertMirrorLog(outcome, OMITTED_LOG),
  ));

test("a genuinely successful D1 mirror leaves nothing at all logged under checkAiUsage/cloudflare-replica", () =>
  withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      CLOUDFLARE_DATA_MODE: "dual",
      CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY: "supabase",
    },
    () =>
      withCloudflareContext(d1Fixture().env, async () => {
        const savedFetch = globalThis.fetch;
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          if (url.pathname === "/rest/v1/rpc/check_and_record_usage_with_event") {
            return Response.json({
              allowed: true, reason: "ok", used: 1, quota: 10,
              eventId: "49", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "admitted",
            });
          }
          throw new Error(`unexpected request to ${url}`);
        };
        try {
          const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
          assert.equal(result, null, "an admitted decision must still carry on");
          assert.ok(
            !logs.some((l) => l.includes("checkAiUsage/cloudflare-replica")),
            `a successful mirror must log nothing under this label; got: ${JSON.stringify(logs)}`,
          );
        } finally {
          globalThis.fetch = savedFetch;
        }
      }),
  ));

/*
  ------------------------------------------------------------------------
  The Cloudflare usage-quota-authority branch: checkAiUsageOnCloudflare.

  CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY=cloudflare routes admission
  through lib/cloudflare/usage-quota-authority.ts against a real in-memory D1
  (already proven directly, exhaustively, in
  tests/cloudflare-usage-quota-authority.test.mjs) — what is under test here
  is guard.ts's own wiring around that call: which tier and isAdmin flag it
  hands over, and how it turns the returned decision (or a thrown error) into
  a Response.

  The entitlement lookup stays on the Supabase branch throughout (its own
  domain override is left at the default), so a caller's tier comes from a
  faked resolve_entitlement RPC exactly as tests/entitlement-parity-expiry
  .test.mjs drives lib/billing/entitlements.ts directly.
*/
function withCloudflareAuthority({ entitlementRow, seedUsageEventsSequence = true, envOverrides = {} } = {}, fn) {
  const { env } = d1Fixture({ seedUsageEventsSequence });
  return withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY: "cloudflare",
      // Merged in here rather than through a second, nested withEnv call —
      // withEnv resets every tracked key on entry, so nesting it would wipe
      // out whatever the outer call had just set (as USAGE_FAIL_OPEN did,
      // silently, before this parameter existed).
      ...envOverrides,
    },
    () =>
      withCloudflareContext(env, async () => {
        const savedFetch = globalThis.fetch;
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          if (url.pathname === "/auth/v1/user") {
            return Response.json({ id: SUBJECT_USER, email: SUBJECT_EMAIL });
          }
          if (url.pathname === "/rest/v1/rpc/resolve_entitlement" && entitlementRow !== undefined) {
            return Response.json(entitlementRow);
          }
          throw new Error(`unexpected request to ${url}`);
        };
        try {
          return await fn();
        } finally {
          globalThis.fetch = savedFetch;
        }
      }),
  );
}

const SUBJECT_USER = "70000000-0000-4000-8000-000000000001";
const SUBJECT_EMAIL = "learner@example.test";
const signedInReq = (headers = {}) => req({ authorization: "Bearer a-real-looking-token", ...headers });

test("an anonymous caller with the zero anonymous allowance is refused as quota_exceeded, not rate_limited", () =>
  withCloudflareAuthority({}, async () => {
    const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
    assert.ok(result instanceof Response);
    assert.equal(result.status, 429);
    const body = await result.json();
    assert.match(body.error, /month/i, "quota_exceeded must read as the monthly allowance message");
    assert.ok(!logs.some((l) => l.includes("cloudflare-authority") || l.includes("cloudflare-entitlement")));
  }));

test("a signed-in AI-tier caller exhausts the weekly allowance before the monthly one, and is told rate_limited", () =>
  withCloudflareAuthority(
    { entitlementRow: { role: "user", tier: "ai", source: "stripe", expires_at: null } },
    async () => {
      const first = await checkAiUsage(signedInReq(), "grade/speaking");
      assert.equal(first, null, "the first call must be admitted (weekly cap for ai/grade-speaking is 1)");

      const second = await checkAiUsage(signedInReq(), "grade/speaking");
      assert.ok(second instanceof Response, "the second call must be refused");
      assert.equal(second.status, 429);
      const body = await second.json();
      assert.match(body.error, /week/i, "rate_limited must read as the weekly message, not the monthly one");
    },
  ));

test("an entitlement lookup that itself fails closes with 503 and logs under cloudflare-entitlement", () =>
  withCloudflareAuthority({}, async () => {
    // No entitlementRow means resolve_entitlement's own mock branch is not
    // configured — this specific test overrides fetch again to have that one
    // endpoint fail outright while /auth/v1/user still answers normally.
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ id: SUBJECT_USER, email: SUBJECT_EMAIL });
      }
      if (url.pathname === "/rest/v1/rpc/resolve_entitlement") {
        return new Response("upstream down", { status: 503 });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    try {
      const { result, logs } = await withLogs(() => checkAiUsage(signedInReq(), "chat"));
      assert.ok(result instanceof Response);
      assert.equal(result.status, 503);
      assert.ok(
        logs.some((l) => l.includes("checkAiUsage/cloudflare-entitlement")),
        `expected the entitlement-failure log; got: ${JSON.stringify(logs)}`,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("an unseeded usage_events id sequence fails closed with 503 regardless of USAGE_FAIL_OPEN, naming cloudflare-authority", () =>
  withCloudflareAuthority(
    {
      entitlementRow: { role: "user", tier: "free", source: "default", expires_at: null },
      seedUsageEventsSequence: false,
      envOverrides: { USAGE_FAIL_OPEN: "1" },
    },
    async () => {
      const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
      assert.ok(result instanceof Response, "USAGE_FAIL_OPEN must not apply to an unseeded id sequence");
      assert.equal(result.status, 503);
      assert.ok(
        logs.some((l) => l.includes("checkAiUsage/cloudflare-authority")),
        `expected the cloudflare-authority log; got: ${JSON.stringify(logs)}`,
      );
    },
  ));

test("a database-granted admin (tier admin, not env-listed) is exempt from the per-IP ceiling", () =>
  withCloudflareAuthority(
    {
      entitlementRow: { role: "admin", tier: "admin", source: "role", expires_at: null },
      // The IP ceiling only ever enters the query when hashIp actually
      // returns something — with no salt configured it is always null, which
      // would make this pass for the wrong reason (no IP tracking at all,
      // rather than a real exemption from a real cap).
      envOverrides: { USAGE_IP_HASH_SALT: "test-guard-admin-ip-salt" },
    },
    async () => {
      const ipReq = () => signedInReq({ "x-forwarded-for": "203.0.113.200" });
      // IP_DAILY_CEILING is 60 and is not something a test can inject a
      // smaller value for — admin exemption from it is the one behaviour
      // that can only be shown by actually exceeding it.
      for (let i = 0; i < 61; i += 1) {
        const outcome = await checkAiUsage(ipReq(), "define");
        assert.equal(outcome, null, `call ${i + 1} must be admitted — an admin has no cap of its own and must be exempt from the IP ceiling too`);
      }
    },
  ));

test("an ordinary tier is not exempt from the per-IP ceiling — the admin exemption above is a real one", () =>
  withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY: "cloudflare",
      USAGE_IP_HASH_SALT: "test-guard-non-admin-ip-salt",
    },
    () =>
      withCloudflareContext(d1Fixture().env, async () => {
        const savedFetch = globalThis.fetch;
        // Every route's own weekly allowance tops out at 10 (ai/"define"),
        // far short of the 60-call IP ceiling — so proving a non-admin is
        // bound by that ceiling needs many *different* users sharing one
        // address, each of them nowhere near their own weekly cap. The
        // bearer token here is a fake, per-user index the fetch mock reads
        // back out to answer /auth/v1/user distinctly for each of the 61.
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/auth/v1/user") {
            const authHeader = init?.headers instanceof Headers
              ? init.headers.get("Authorization")
              : new Headers(init?.headers).get("Authorization");
            const index = /token-(\d+)/.exec(authHeader ?? "")?.[1] ?? "0";
            return Response.json({
              id: `70000000-0000-4000-8000-${index.padStart(12, "0")}`,
              email: `learner-${index}@example.test`,
            });
          }
          if (url.pathname === "/rest/v1/rpc/resolve_entitlement") {
            return Response.json({ role: "user", tier: "ai", source: "stripe", expires_at: null });
          }
          throw new Error(`unexpected request to ${url}`);
        };
        try {
          const reqFor = (i) => req({ authorization: `Bearer token-${i}`, "x-forwarded-for": "203.0.113.201" });
          for (let i = 0; i < 60; i += 1) {
            const outcome = await checkAiUsage(reqFor(i), "define");
            assert.equal(outcome, null, `call ${i + 1} (a distinct user each time) should still be inside the IP ceiling`);
          }
          const refused = await checkAiUsage(reqFor(60), "define");
          assert.ok(refused instanceof Response, "call 61 must be refused — a non-admin is not exempt from the IP ceiling");
          assert.equal(refused.status, 429);
        } finally {
          globalThis.fetch = savedFetch;
        }
      }),
  ));

test("a D1 failure that is not the unseeded-sequence error still respects USAGE_FAIL_OPEN", () =>
  withEnv(
    { ACCOUNTS_ENABLED: "1", SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-role-key", CLOUDFLARE_DATA_MODE_USAGE_QUOTA_AUTHORITY: "cloudflare", USAGE_FAIL_OPEN: "1" },
    async () => {
      // No Cloudflare context at all: bandUpCloudflareBindings() throws a
      // plain "bindings unavailable" Error, not CloudflareIdSequenceNotSeededError.
      const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "chat"));
      assert.equal(result, null, "an ordinary D1 failure must still fail OPEN when USAGE_FAIL_OPEN=1");
      assert.ok(logs.some((l) => l.includes("checkAiUsage/cloudflare-authority")));
    },
  ));

/*
  ------------------------------------------------------------------------
  Session resolution: the ADMIN_EMAILS exemption, and a session lookup that
  itself fails (an unverifiable token metered as anonymous, not as an error).
*/
test("an ADMIN_EMAILS-listed caller is exempt from metering entirely, before any backend is even asked", () =>
  withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      ADMIN_EMAILS: "owner@example.test",
    },
    async () => {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/user") {
          return Response.json({ id: "80000000-0000-4000-8000-000000000001", email: "owner@example.test" });
        }
        throw new Error(`must not reach ${url} — the ADMIN_EMAILS exemption must come first`);
      };
      try {
        const result = await checkAiUsage(signedInReq(), "chat");
        assert.equal(result, null);
      } finally {
        globalThis.fetch = savedFetch;
      }
    },
  ));

test("a session lookup that itself throws is metered as anonymous, not surfaced as an error, and logs checkAiUsage/session", () =>
  withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    },
    async () => {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/user") return new Response("upstream down", { status: 503 });
        if (url.pathname === "/rest/v1/rpc/check_and_record_usage") {
          return Response.json({ allowed: true, reason: "ok", used: 1, quota: 40, eventId: null, eventCreatedAt: null, eventOutcome: null });
        }
        throw new Error(`unexpected request to ${url}`);
      };
      try {
        const { result, logs } = await withLogs(() => checkAiUsage(signedInReq(), "chat"));
        // The metering itself still ran (against the free/anonymous tier
        // this build applies once the session lookup gives up), and its own
        // result is what is returned — an outage in auth must not read as
        // an outage in metering.
        assert.equal(result, null);
        assert.ok(
          logs.some((l) => l.includes("checkAiUsage/session")),
          `expected the session-failure log; got: ${JSON.stringify(logs)}`,
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    },
  ));

/*
  ------------------------------------------------------------------------
  The Supabase RPC core: which function is called, with which arguments, and
  how its decision (or failure to answer at all) becomes a Response.

  shouldMirror is mirrorsWritesToCloudflare() — CLOUDFLARE_DATA_MODE "dual" or
  "read_cloudflare" — which is independent of the usage_quota_authority
  domain override left at its default ("supabase") throughout this section.
*/
function withRpcCall({ shouldMirror = false, decision, onRequest } = {}, fn) {
  return withEnv(
    {
      ACCOUNTS_ENABLED: "1",
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      CLOUDFLARE_DATA_MODE: shouldMirror ? "dual" : undefined,
    },
    async () => {
      const requests = [];
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url, body });
        if (onRequest) {
          const custom = await onRequest(url, body);
          if (custom !== undefined) return custom;
        }
        if (url.pathname.startsWith("/rest/v1/rpc/check_and_record_usage")) {
          return Response.json(decision);
        }
        throw new Error(`unexpected request to ${url}`);
      };
      try {
        return await fn(requests);
      } finally {
        globalThis.fetch = savedFetch;
      }
    },
  );
}

test("without mirroring, the plain RPC is called with exactly the caller's own arguments", () =>
  withRpcCall(
    { shouldMirror: false, decision: { allowed: true, reason: "ok", used: 0, quota: 40 } },
    async (requests) => {
      await checkAiUsage(anonymousReq(), "define");
      const rpcCall = requests.find((r) => r.url.pathname.startsWith("/rest/v1/rpc/"));
      assert.equal(rpcCall.url.pathname, "/rest/v1/rpc/check_and_record_usage");
      assert.deepEqual(Object.keys(rpcCall.body).sort(), ["p_ip_hash", "p_limits", "p_route", "p_user_id", "p_window_seconds"].sort());
      assert.equal(rpcCall.body.p_user_id, null, "anonymous must send a null user id, not an omitted one");
      assert.equal(rpcCall.body.p_route, "define");
      assert.equal(rpcCall.body.p_window_seconds, 7 * 24 * 60 * 60);
      assert.equal(rpcCall.body.p_limits.month_seconds, 30 * 24 * 60 * 60);
    },
  ));

test("with mirroring on, the with-event RPC variant is called instead of the plain one", () =>
  withRpcCall(
    { shouldMirror: true, decision: { allowed: true, reason: "ok", used: 0, quota: 40, eventId: "51", eventCreatedAt: "2026-08-01T00:00:00Z", eventOutcome: "admitted" } },
    async (requests) => {
      await checkAiUsage(anonymousReq(), "define");
      const rpcCall = requests.find((r) => r.url.pathname.startsWith("/rest/v1/rpc/"));
      assert.equal(rpcCall.url.pathname, "/rest/v1/rpc/check_and_record_usage_with_event");
    },
  ));

test("an RPC failure logs under checkAiUsage/rpc and fails closed by default", () =>
  withRpcCall(
    { onRequest: (url) => (url.pathname.startsWith("/rest/v1/rpc/") ? new Response("db down", { status: 500 }) : undefined) },
    async () => {
      const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "define"));
      assert.ok(result instanceof Response);
      assert.equal(result.status, 503);
      assert.ok(logs.some((l) => l.includes("checkAiUsage/rpc")));
    },
  ));

test("a decision whose allowed field is not a boolean is treated as unrecognised, not as truthy", () =>
  withRpcCall(
    // A string "true" — truthy in JS, and exactly the shape a schema drift
    // (or a hand-edited stub) could produce.
    { decision: { allowed: "true", reason: "ok", used: 0, quota: 40 } },
    async () => {
      const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "define"));
      assert.ok(result instanceof Response, "a non-boolean allowed must not be read as permission to proceed");
      assert.equal(result.status, 503);
      assert.ok(
        logs.some((l) => l.includes("checkAiUsage/rpc") && l.includes("unrecognised usage decision")),
        `expected the unrecognised-decision log; got: ${JSON.stringify(logs)}`,
      );
    },
  ));

test("shouldMirror false never attempts to mirror, even when the decision would otherwise fail the mirror's own validation", () =>
  withRpcCall(
    // Deliberately invalid for mirrorUsageDecision (no eventId at all) — if
    // this were ever mirrored it would throw and log under
    // checkAiUsage/cloudflare-replica. shouldMirror is false, so mirroring
    // must never even be attempted.
    { shouldMirror: false, decision: { allowed: true, reason: "ok", used: 0, quota: 40 } },
    async () => {
      const { result, logs } = await withLogs(() => checkAiUsage(anonymousReq(), "define"));
      assert.equal(result, null);
      assert.ok(
        !logs.some((l) => l.includes("cloudflare-replica")),
        `mirroring must not run at all when shouldMirror is false; got: ${JSON.stringify(logs)}`,
      );
    },
  ));

test("an admitted decision carries on (returns null)", () =>
  withRpcCall(
    { decision: { allowed: true, reason: "ok", used: 1, quota: 40 } },
    async () => {
      assert.equal(await checkAiUsage(anonymousReq(), "define"), null);
    },
  ));

test("a rate_limited refusal reads as the weekly message at 429", () =>
  withRpcCall(
    { decision: { allowed: false, reason: "rate_limited", used: 10, quota: 10 } },
    async () => {
      const result = await checkAiUsage(anonymousReq(), "define");
      assert.ok(result instanceof Response);
      assert.equal(result.status, 429);
      const body = await result.json();
      assert.match(body.error, /week/i);
    },
  ));

test("a refusal for any other reason reads as the monthly quota_exceeded message at 429, not the weekly one", () =>
  withRpcCall(
    { decision: { allowed: false, reason: "quota_exceeded", used: 40, quota: 40 } },
    async () => {
      const result = await checkAiUsage(anonymousReq(), "define");
      assert.ok(result instanceof Response);
      assert.equal(result.status, 429);
      const body = await result.json();
      assert.match(body.error, /month/i);
      assert.doesNotMatch(body.error, /week/i);
    },
  ));
