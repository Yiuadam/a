/*
  The same instant, spelled two ways, is not a drift.

  Found against real production data: the entitlement-parity endpoint
  compared `expiresAt` with a raw `===`, and Supabase's timestamptz text
  (`2027-08-11T16:22:20+00:00`) never equals D1's nine-digit canonical clock
  (`2027-08-11T16:22:20.000000000Z`) as strings, even when they name the exact
  same moment. Every account with a live subscription reported as drifted for
  its punctuation — the same shape of fault `parityClock` exists to fix in the
  migration fingerprints, one function over.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const entitlementsModule = await import(
  pathToFileURL(join(root, "lib", "billing", "entitlements.ts")).href
);
const { sameExpiry, resolveEntitlement } = entitlementsModule;

test("the real production case: same instant, Postgres offset vs D1 nine-digit UTC", () => {
  assert.equal(
    sameExpiry("2027-08-11T16:22:20+00:00", "2027-08-11T16:22:20.000000000Z"),
    true,
  );
});

test("both null is equal, exactly one null is not", () => {
  assert.equal(sameExpiry(null, null), true);
  assert.equal(sameExpiry("2027-08-11T16:22:20+00:00", null), false);
  assert.equal(sameExpiry(null, "2027-08-11T16:22:20.000000000Z"), false);
});

test("a real difference in the instant is still caught", () => {
  assert.equal(
    sameExpiry("2027-08-11T16:22:20+00:00", "2027-08-11T16:22:21.000000000Z"),
    false,
  );
  assert.equal(
    sameExpiry("2027-08-11T16:22:20+00:00", "2028-08-11T16:22:20.000000000Z"),
    false,
  );
});

test("a non-UTC offset still resolves to the same instant", () => {
  assert.equal(
    sameExpiry("2027-08-11T08:22:20-08:00", "2027-08-11T16:22:20.000000000Z"),
    true,
  );
});

test("sub-second precision still distinguishes real drift", () => {
  assert.equal(
    sameExpiry("2027-08-11T16:22:20.500+00:00", "2027-08-11T16:22:20.000000000Z"),
    false,
  );
});

test("an unparseable value is reported as a difference, not waved through", () => {
  assert.equal(sameExpiry("not a timestamp", "2027-08-11T16:22:20.000000000Z"), false);
  assert.equal(sameExpiry("not a timestamp", "not a timestamp"), true);
});

/*
  ---------------------------------------------------------------------------
  resolveEntitlement, through the one Supabase RPC it calls: normalise()'s
  reading of a raw resolve_entitlement row.

  No real Supabase project is reached — SUPABASE_URL et al are dummy values,
  and a fake fetch answers /rest/v1/rpc/resolve_entitlement in whatever shape
  each test needs. ADMIN_EMAILS is left unset throughout, so every call here
  reaches resolveViaSupabase rather than short-circuiting on the env-granted
  admin check that comes before it.
*/
const ENTITLEMENT_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_EMAILS"];

function withEntitlementBackend(rawRow, fn) {
  const saved = {};
  for (const key of ENTITLEMENT_ENV_KEYS) saved[key] = process.env[key];
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  delete process.env.ADMIN_EMAILS;

  const requests = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    if (url.pathname === "/rest/v1/rpc/resolve_entitlement") {
      return Response.json(rawRow);
    }
    throw new Error(`unexpected request to ${url}`);
  };

  return Promise.resolve()
    .then(() => fn(requests))
    .finally(() => {
      globalThis.fetch = savedFetch;
      for (const key of ENTITLEMENT_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

const SUBJECT_USER = "11111111-1111-4111-8111-111111111111";

test("a database role of 'admin' is honoured, and only that exact string", () =>
  withEntitlementBackend(
    { role: "admin", tier: "admin", source: "role", expires_at: null },
    async () => {
      const result = await resolveEntitlement(SUBJECT_USER, "not-an-admin-email@example.test");
      assert.equal(result.role, "admin");
    },
  ));

test("an unrecognised database role degrades to 'user', never to 'admin'", () =>
  withEntitlementBackend(
    { role: "owner", tier: "free", source: "default", expires_at: null },
    async () => {
      const result = await resolveEntitlement(SUBJECT_USER, "nobody@example.test");
      assert.equal(result.role, "user");
    },
  ));

test("a tier this build does not recognise degrades to free rather than being trusted verbatim", () =>
  withEntitlementBackend(
    { role: "user", tier: "some-unrecognised-future-tier", source: "stripe", expires_at: null },
    async () => {
      const result = await resolveEntitlement(SUBJECT_USER, "learner@example.test");
      assert.equal(result.tier, "free");
    },
  ));

test("every recognised tier name, including a legacy alias, is carried through unchanged", () =>
  withEntitlementBackend(
    { role: "user", tier: "ai", source: "stripe", expires_at: null },
    async () => {
      const result = await resolveEntitlement(SUBJECT_USER, "learner@example.test");
      assert.equal(result.tier, "ai");
    },
  ));

test("'apple' and 'anonymous' sources are preserved, not folded into 'default'", () =>
  withEntitlementBackend(
    { role: "user", tier: "ai", source: "apple", expires_at: null },
    async () => {
      const result = await resolveEntitlement(SUBJECT_USER, "learner@example.test");
      assert.equal(result.source, "apple");
    },
  ));

test("an anonymous-sourced row is preserved as 'anonymous', not folded into 'default'", () =>
  withEntitlementBackend(
    { role: "user", tier: "free", source: "anonymous", expires_at: null },
    async () => {
      const result = await resolveEntitlement(SUBJECT_USER, "learner@example.test");
      assert.equal(result.source, "anonymous");
    },
  ));

test("resolveEntitlement sends the caller's own user id as the RPC's p_user_id, and nothing else", () =>
  withEntitlementBackend(
    { role: "user", tier: "free", source: "default", expires_at: null },
    async (requests) => {
      await resolveEntitlement(SUBJECT_USER, "learner@example.test");
      const rpcCall = requests.find((r) => r.url.pathname === "/rest/v1/rpc/resolve_entitlement");
      assert.ok(rpcCall, "resolve_entitlement must actually be called");
      assert.deepEqual(rpcCall.body, { p_user_id: SUBJECT_USER });
    },
  ));

test("resolveEntitlement and resolveEntitlementForParity refuse to run outside the server", async () => {
  globalThis.window = {};
  try {
    await assert.rejects(
      () => resolveEntitlement(SUBJECT_USER, "learner@example.test"),
      (error) => error instanceof Error && error.message.includes("lib/billing/entitlements.ts"),
    );
    await assert.rejects(
      () => entitlementsModule.resolveEntitlementForParity(SUBJECT_USER, "learner@example.test"),
      (error) => error instanceof Error && error.message.includes("lib/billing/entitlements.ts"),
    );
  } finally {
    delete globalThis.window;
  }
});

test("fieldsEqual routes expiresAt through sameExpiry, not a bare ===", () => {
  const source = readFileSync(
    join(root, "app", "api", "admin", "cloudflare", "entitlement-parity", "route.ts"),
    "utf8",
  );
  const start = source.indexOf("function fieldsEqual(");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /sameExpiry\(a\.expiresAt, b\.expiresAt\)/);
  assert.doesNotMatch(body, /a\.expiresAt === b\.expiresAt/);
  assert.match(source, /import \{ resolveEntitlementForParity, sameExpiry,/);
});
