/*
  Mutation-hardening for the Cloudflare-native identity/session resolution,
  the password import + migration proof, and the native Stripe/promo
  subscription writers.

  These modules are security- and billing-critical: they decide who a bearer
  token is, whether an imported password verifier is allowed to attach to an
  account, and what a verified Stripe or promo event writes into `subscriptions`.
  Every test here drives the real exported function and asserts on what it
  returns, throws, or wrote to D1 — never on the source text.

  The D1 harness mirrors tests/native-stripe-billing.test.mjs and
  tests/native-promo-write.test.mjs: a real node:sqlite database with every
  migration applied, wrapped in the same minimal D1 shape (`prepare().bind()`,
  `.first()`, `.all()`, `.run()`, `.batch()`) the Worker binding provides.
  Using the real engine means a UNIQUE or CHECK constraint fires exactly as it
  would in production, so a "concurrent write already exists" branch can be
  exercised with a genuine conflicting row rather than a hand-wired stub.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const identity = await load("lib", "cloudflare", "native-identity.ts");
const identityAudit = await load("lib", "cloudflare", "native-identity-audit.ts");
const identityBackfill = await load("lib", "cloudflare", "native-identity-backfill.ts");
const passwordImport = await load("lib", "cloudflare", "native-password-import.ts");
const passwordMigrationAudit = await load("lib", "cloudflare", "native-password-migration-audit.ts");
const passwordProof = await load("lib", "cloudflare", "native-password-proof.ts");
const stripeBilling = await load("lib", "cloudflare", "native-stripe-billing.ts");
const promo = await load("lib", "cloudflare", "native-promo.ts");
const billingReadiness = await load("lib", "cloudflare", "native-billing-readiness.ts");
const authReadiness = await load("lib", "cloudflare", "native-auth-readiness.ts");

/* --------------------------------------------------------------------------
   D1 harness — identical shape to tests/native-stripe-billing.test.mjs
   -------------------------------------------------------------------------- */

function runtimeD1(database) {
  const execute = (statement) => {
    const result = database.prepare(statement.sql).run(...statement.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute({ sql, values }); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return {
    prepare(sql) { return { bind: (...values) => bound(sql, values), ...bound(sql, []) }; },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(ROOT, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", file), "utf8"));
  }
  const objects = new Map();
  return {
    database,
    objects,
    bindings: {
      db: runtimeD1(database),
      files: {
        async put(key, value) { objects.set(key, Uint8Array.from(value)); },
        async delete(key) { objects.delete(key); },
        async get(key) {
          const value = objects.get(key);
          return value ? { async arrayBuffer() { return value.buffer; } } : null;
        },
      },
    },
  };
}

/** A stable, valid-length id: `${prefix}` padded with zeros to stay in [16, 80]. */
function uid(prefix, index = 0) {
  const body = `${prefix}-${String(index).padStart(8, "0")}`;
  return body.length >= 16 ? body : body.padEnd(16, "0");
}

function insertUser(database, id, overrides = {}) {
  const row = {
    email: `${id}@example.test`,
    role: "user",
    created_at: "2026-08-29T00:00:00.000000000Z",
    updated_at: "2026-08-29T00:00:00.000000000Z",
    deleted_at: null,
    identity_authority: "supabase",
    ...overrides,
  };
  database.prepare(`
    INSERT INTO app_users (id, identity_provider, email, role, created_at, updated_at, deleted_at, identity_authority)
    VALUES (?, 'supabase', ?, ?, ?, ?, ?, ?)
  `).run(id, row.email, row.role, row.created_at, row.updated_at, row.deleted_at, row.identity_authority);
  return id;
}

/* --------------------------------------------------------------------------
   assertServerOnly / MODULE — every exported entry point that guards itself
   -------------------------------------------------------------------------- */

function serverOnlyPattern(modulePath) {
  return new RegExp(`${modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is server-only`);
}

async function expectServerOnly(modulePath, run) {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    await assert.rejects(run, serverOnlyPattern(modulePath));
  } finally {
    delete globalThis.window;
  }
}

function expectServerOnlySync(modulePath, run) {
  assert.equal(globalThis.window, undefined, "this test assumes no browser global yet");
  globalThis.window = {};
  try {
    assert.throws(run, serverOnlyPattern(modulePath));
  } finally {
    delete globalThis.window;
  }
}

test("native-auth-readiness guards both its exported entry points", () => {
  expectServerOnlySync("lib/cloudflare/native-auth-readiness.ts", () => authReadiness.nativeAuthDataAuthority());
  expectServerOnlySync("lib/cloudflare/native-auth-readiness.ts", () => authReadiness.nativeAuthCutoverActive());
});

test("native-billing-readiness guards its one entry point and stays off by default", () => {
  expectServerOnlySync("lib/cloudflare/native-billing-readiness.ts", () => billingReadiness.nativeStripeBillingActive());
});

test("native-identity-backfill guards its one entry point", async () => {
  await expectServerOnly(
    "lib/cloudflare/native-identity-backfill.ts",
    () => identityBackfill.backfillNativeGoogleIdentities({ db: {}, files: {} }, { readSource: async () => [] }),
  );
});

test("native-identity-audit guards its one entry point", async () => {
  await expectServerOnly(
    "lib/cloudflare/native-identity-audit.ts",
    () => identityAudit.nativeIdentityReadinessReport({ db: {}, files: {} }, { readSource: async () => [] }),
  );
});

test("native-password-import guards both its D1 writers", async () => {
  const credential = {
    userId: uid("spo", 1),
    email: "spo1@example.test",
    verifier: "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm",
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  };
  await expectServerOnly(
    "lib/cloudflare/native-password-import.ts",
    () => passwordImport.importNativePasswordCredential(credential, { db: {}, files: {} }),
  );
  await expectServerOnly(
    "lib/cloudflare/native-password-import.ts",
    () => passwordImport.importNativePasswordCredentialBatch([credential], { db: {}, files: {} }),
  );
});

test("native-password-migration-audit guards both its entry points", async () => {
  await expectServerOnly(
    "lib/cloudflare/native-password-migration-audit.ts",
    () => passwordMigrationAudit.nativePasswordMigrationEvidence({ db: {}, files: {} }),
  );
  await expectServerOnly(
    "lib/cloudflare/native-password-migration-audit.ts",
    () => passwordMigrationAudit.certifyNativePasswordMigration(0, "f".repeat(64), { db: {}, files: {} }),
  );
});

test("native-identity guards every entry point that touches a session or an identity", async () => {
  const bindings = { db: {}, files: {} };
  const dummyGoogle = { subject: "s", email: null, emailVerified: false };
  const dummyApple = { subject: "s", email: null, emailVerified: false };
  await expectServerOnly("lib/cloudflare/native-identity.ts", () => identity.bridgeLegacyBrowserSession({ id: uid("x"), email: null, createdAt: null }, "secret", bindings));
  await expectServerOnly("lib/cloudflare/native-identity.ts", () => identity.resolveGoogleIdentity(dummyGoogle, bindings));
  await expectServerOnly("lib/cloudflare/native-identity.ts", () => identity.resolveAppleIdentity(dummyApple, null, bindings));
  await expectServerOnly("lib/cloudflare/native-identity.ts", () => identity.userFromNativeBrowserSessionToken("token", "secret", bindings));
  await expectServerOnly("lib/cloudflare/native-identity.ts", () => identity.revokeNativeBrowserSessionToken("token", "secret", bindings));
  await expectServerOnly("lib/cloudflare/native-identity.ts", () => identity.refreshNativeBrowserSession("token", "secret", bindings));
});

test("native-stripe-billing guards every writer", async () => {
  const bindings = { db: {}, files: {} };
  await expectServerOnly("lib/cloudflare/native-stripe-billing.ts", () => stripeBilling.applyNativeStripeSubscription({}, {}, bindings));
  await expectServerOnly("lib/cloudflare/native-stripe-billing.ts", () => stripeBilling.applyNativeStripePrepaidPurchase({}, {}, bindings));
  await expectServerOnly("lib/cloudflare/native-stripe-billing.ts", () => stripeBilling.applyNativeStripePrepaidRefund({}, {}, bindings));
});

test("native-promo guards every writer", async () => {
  const bindings = { db: {}, files: {} };
  await expectServerOnly("lib/cloudflare/native-promo.ts", () => promo.nativePromoSubscriptionState(uid("x"), bindings));
  await expectServerOnly("lib/cloudflare/native-promo.ts", () => promo.nativeInsertPromoSubscription(uid("x"), bindings));
  await expectServerOnly("lib/cloudflare/native-promo.ts", () => promo.nativeReleasePromoSubscription(uid("x"), bindings));
});

/* ==========================================================================
   native-password-proof.ts — canonical, non-sensitive migration commitment
   ========================================================================== */

const VALID_VERIFIER = "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm";
const VALID_ROW = {
  userId: "u".repeat(20),
  verifier: VALID_VERIFIER,
  sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
};

test("normalisePasswordProofRow rejects a non-string userId rather than coercing it", () => {
  // "Stryker was here!" is 17 characters — inside [16, 80] — so a mutant that
  // stops defaulting a non-string userId to "" would slip this row through.
  assert.equal(passwordProof.normalisePasswordProofRow({ ...VALID_ROW, userId: 123456 }), null);
  // A mutant that forces the `typeof === "string"` guard to `true` would call
  // `.trim()` on the number above and throw instead of cleanly returning null.
  assert.doesNotThrow(() => passwordProof.normalisePasswordProofRow({ ...VALID_ROW, userId: 123456 }));
});

test("normalisePasswordProofRow trims a userId, and the trim can cross the length boundary", () => {
  // Untrimmed length is 82 (invalid); trimmed length is 78 (valid). Only a
  // real `.trim()` call makes this row pass.
  const padded = `  ${"u".repeat(78)}  `;
  const row = passwordProof.normalisePasswordProofRow({ ...VALID_ROW, userId: padded });
  assert.equal(row?.userId, "u".repeat(78));
});

test("normalisePasswordProofRow requires the verifier to actually be a string", () => {
  // An array of length 60 would pass a mutated `verifier.length !== 60` check
  // if the `typeof value.verifier === "string"` guard were forced to `true`.
  assert.equal(passwordProof.normalisePasswordProofRow({
    ...VALID_ROW,
    verifier: new Array(60).fill("x"),
  }), null);
});

test("normalisePasswordProofRow requires sourceUpdatedAt to actually be a string", () => {
  // Date.parse() will happily stringify-and-parse a Date object, so forcing
  // the `typeof === "string"` guard to `true` would let this validate.
  assert.equal(passwordProof.normalisePasswordProofRow({
    ...VALID_ROW,
    sourceUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }), null);
});

test("normalisePasswordProofRow enforces every length boundary exactly", () => {
  const cases = [
    [{ userId: "u".repeat(15) }, null, "userId one under the floor"],
    [{ userId: "u".repeat(16) }, "row", "userId exactly at the floor"],
    [{ userId: "u".repeat(80) }, "row", "userId exactly at the ceiling"],
    [{ userId: "u".repeat(81) }, null, "userId one over the ceiling"],
    [{ verifier: `$2b$10$${"a".repeat(51)}` }, null, "verifier one short of 60"],
    [{ verifier: VALID_VERIFIER }, "row", "verifier exactly 60"],
    [{ verifier: `${VALID_VERIFIER}x` }, null, "verifier one over 60"],
    [{ sourceUpdatedAt: "not a date" }, null, "unparseable date"],
  ];
  for (const [overrides, expect, why] of cases) {
    const result = passwordProof.normalisePasswordProofRow({ ...VALID_ROW, ...overrides });
    if (expect === null) assert.equal(result, null, why);
    else assert.notEqual(result, null, why);
  }
});

test("passwordProofManifest hashes the exact canonical row encoding", async () => {
  const rows = [
    { userId: "11111111-1111-4111-8111-111111111111", sourceUpdatedAt: "2026-08-28T00:00:00.000Z", verifier: "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm" },
    { userId: "22222222-2222-4222-8222-222222222222", sourceUpdatedAt: "2026-08-28T00:01:00.000Z", verifier: "$2b$10$O3qtiPNUNg1dIX2p3iY2Z.45nGd9IL8UnLiW2C/RUxNh5JysNcpE." },
  ];
  // Pinned against the real implementation. A mutated field/row separator
  // ("|" or "\n" dropped) changes the canonical string and so the digest.
  assert.equal(
    await passwordProof.passwordProofManifest(rows),
    "acbd1db3953dd64f0e819746279aeab45ce6b7c7fd4936698cfa60798f86e254",
  );
  assert.equal(
    await passwordProof.passwordProofManifest([rows[0]]),
    "47484a5de8f135195cbd791afffc6b8913da6abcecd8d64aa94dec85b303a75c",
  );
});

test("isPasswordProofManifest requires a real 64-character lowercase hex string, fully anchored", () => {
  assert.equal(passwordProof.isPasswordProofManifest("a".repeat(64)), true);
  assert.equal(passwordProof.isPasswordProofManifest(64), false, "a non-string must not slip through a forced-true guard");
  // Anchoring: a dropped `^` would match a 64-hex-char suffix on a longer string.
  assert.equal(passwordProof.isPasswordProofManifest(`z${"a".repeat(64)}`), false);
  // A dropped `$` would match a 64-hex-char prefix on a longer string.
  assert.equal(passwordProof.isPasswordProofManifest(`${"a".repeat(64)}z`), false);
  assert.equal(passwordProof.isPasswordProofManifest("g".repeat(64)), false, "not hex");
});

/* ==========================================================================
   native-promo.ts — the D1-only free-Pro-trial writer
   ========================================================================== */

test("nativePromoSubscriptionState reduces every row combination to the right state", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("promo-state"));
  function setStatuses(statuses) {
    context.database.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(owner);
    statuses.forEach((status, index) => {
      context.database.prepare(`
        INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
        VALUES (?, ?, 'promo', ?, 'ai', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z')
      `).run(`promo-state-row-${index}`, owner, status);
    });
  }
  const cases = [
    [[], "none"],
    [["active"], "holding"],
    // Isolates the "trialing" branch: a mutant that folds it into the "bad"
    // set, or drops it from the holding set, turns this into "ended"/"released".
    [["trialing"], "holding"],
    [["paused"], "released"],
    [["canceled"], "ended"],
    // Mixed: exactly one bad status must be enough to win over an active one,
    // which only a real `.some(...)` (not `.every(...)`) enforces.
    [["active", "canceled"], "ended"],
    // Mixed: one holding-eligible + one released-only status must still read
    // "holding" — only a real `.some(...)` (not `.every(...)`) enforces this.
    [["trialing", "paused"], "holding"],
  ];
  for (const [statuses, expected] of cases) {
    setStatuses(statuses);
    assert.equal(await promo.nativePromoSubscriptionState(owner, context.bindings), expected, JSON.stringify(statuses));
  }
});

test("nativeInsertPromoSubscription writes the one fixed promo/active/ai row and is idempotent", async () => {
  const context = fixture();
  const owner = uid("promo-insert");

  assert.equal(await promo.nativeInsertPromoSubscription(owner, context.bindings), "failed", "no such account yet");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM subscriptions").get().n, 0);

  insertUser(context.database, owner);
  assert.equal(await promo.nativeInsertPromoSubscription(owner, context.bindings), "inserted");
  const row = context.database.prepare(`
    SELECT id, status, tier, provider, cancel_at_period_end, current_period_end FROM subscriptions WHERE user_id = ?
  `).get(owner);
  assert.deepEqual(
    { id: row.id, status: row.status, tier: row.tier, provider: row.provider, cancel_at_period_end: row.cancel_at_period_end, current_period_end: row.current_period_end },
    { id: `promo:${owner}`, status: "active", tier: "ai", provider: "promo", cancel_at_period_end: 0, current_period_end: null },
  );
  assert.equal(await promo.nativeInsertPromoSubscription(owner, context.bindings), "exists", "the stable primary key collapses a retry");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM subscriptions").get().n, 1);
});

test("nativeInsertPromoSubscription refuses a deleted account even when a stale row still exists", async () => {
  const context = fixture();
  const owner = uid("promo-dead");
  insertUser(context.database, owner);
  assert.equal(await promo.nativeInsertPromoSubscription(owner, context.bindings), "inserted");
  context.database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?")
    .run("2026-08-30T00:00:00.000000000Z", owner);
  // The account-liveness guard must reject before ever consulting the row
  // that a skipped guard would otherwise fall through to and read as "exists".
  assert.equal(await promo.nativeInsertPromoSubscription(owner, context.bindings), "failed");
});

test("nativeReleasePromoSubscription and nativeResumePromoSubscription move only the documented transitions", async () => {
  const context = fixture();
  const owner = uid("promo-cycle");
  insertUser(context.database, owner);
  await promo.nativeInsertPromoSubscription(owner, context.bindings);

  assert.equal(await promo.nativeReleasePromoSubscription(owner, context.bindings), "changed");
  const released = context.database.prepare("SELECT status, raw_inline FROM subscriptions WHERE user_id = ?").get(owner);
  assert.equal(released.status, "paused");
  assert.equal(JSON.parse(released.raw_inline).kind, "free-ai-trial");
  assert.ok("releasedAt" in JSON.parse(released.raw_inline));

  // Releasing must also match a still-trialing row, not only an active one —
  // both are named in updateNativePromo's `from` set.
  context.database.prepare("UPDATE subscriptions SET status = 'trialing' WHERE user_id = ?").run(owner);
  assert.equal(await promo.nativeReleasePromoSubscription(owner, context.bindings), "changed");
  assert.equal(context.database.prepare("SELECT status FROM subscriptions WHERE user_id = ?").get(owner).status, "paused");

  assert.equal(await promo.nativeResumePromoSubscription(owner, context.bindings), "changed");
  const resumed = context.database.prepare("SELECT status, raw_inline FROM subscriptions WHERE user_id = ?").get(owner);
  assert.equal(resumed.status, "active");
  const resumedPayload = JSON.parse(resumed.raw_inline);
  assert.equal(resumedPayload.kind, "free-ai-trial");
  // BooleanLiteral survivor: `restarted: true` must actually be `true`.
  assert.equal(resumedPayload.restarted, true);

  // A cancelled row is a final, irreversible state.
  context.database.prepare("UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?").run(owner);
  assert.equal(await promo.nativeResumePromoSubscription(owner, context.bindings), "no-match");
  assert.equal(await promo.nativeReleasePromoSubscription(owner, context.bindings), "no-match");
});

test("native-promo's D1 success:false guards are load-bearing", async () => {
  // Real D1/sqlite never returns success:false from .run() without throwing,
  // so these checks need a hand-built binding that can.
  // liveAccount()'s own SELECT uses `.first`, not `.run`, so patch just enough
  // to reach each write: liveAccount must read truthy, then the write fails.
  function failingWriteBindings() {
    return {
      db: {
        prepare(sql) {
          const isLiveCheck = /SELECT id FROM app_users/.test(sql);
          // nativeInsertPromoSubscription's own catch would otherwise mask a
          // forced-false `!result.success`: it falls through to re-derive the
          // state via nativePromoSubscriptionState, and a genuinely
          // "no such row" answer there (the only thing an unhandled query
          // could produce) reads as "failed" either way. Answering this
          // query for real, with a non-"none" state, is what makes the
          // mutant's fallthrough observably different ("exists").
          const isStatusCheck = /SELECT status FROM subscriptions/.test(sql);
          return {
            bind: (...values) => ({
              async first() { return isLiveCheck ? { id: values[0] } : null; },
              async run() { return { success: false, meta: { changes: 0 } }; },
              async all() { return isStatusCheck ? { success: true, results: [{ status: "active" }], meta: {} } : { success: true, results: [], meta: {} }; },
            }),
          };
        },
      },
      files: { async put() {}, async delete() {}, async get() { return null; } },
    };
  }
  assert.equal(await promo.nativeInsertPromoSubscription(uid("x"), failingWriteBindings()), "failed");
  assert.equal(await promo.nativeReleasePromoSubscription(uid("x"), failingWriteBindings()), "failed");
});

test("nativeInsertPromoSubscription re-derives 'failed' from a genuinely empty state, not just from any zero-change insert", async () => {
  // A guarded INSERT can legitimately write zero rows for a reason other than
  // "a row already exists" (this exact benign race is why the code re-checks
  // state at all) — model that directly: the insert reports success with no
  // change, and a fresh read of the row set is genuinely empty.
  const owner = uid("racecheck", 1);
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        if (/SELECT id FROM app_users/.test(sql)) return { bind: (...values) => ({ async first() { return { id: values[0] }; } }) };
        if (/INSERT INTO subscriptions/.test(sql)) return { bind: () => ({ async run() { return { success: true, meta: { changes: 0 } }; } }) };
        if (/SELECT status FROM subscriptions/.test(sql)) return { bind: () => ({ async all() { return { success: true, results: [], meta: {} }; } }) };
        throw new Error(`unexpected D1 statement: ${sql}`);
      },
    },
  };
  assert.equal(await promo.nativeInsertPromoSubscription(owner, bindings), "failed");
});

/* ==========================================================================
   native-stripe-billing.ts — the verified Stripe event ledger
   ========================================================================== */

function subscriptionEvent(overrides = {}) {
  return {
    eventId: "evt_sub_created",
    eventAt: "2026-08-29T12:00:00.000Z",
    userId: undefined,
    status: "active",
    tier: "ai",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    priceId: "price_ai",
    currentPeriodEnd: "2026-09-29T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function prepaidEvent(overrides = {}) {
  return {
    eventId: "evt_wallet_1",
    eventAt: "2026-08-29T12:00:00.000Z",
    userId: undefined,
    tier: "tracking",
    planId: "tracking-monthly",
    interval: "month",
    customerId: "cus_wallet",
    paymentIntentId: "pi_1",
    ...overrides,
  };
}

test("resolveSubscriptionUser falls back to the subscription-id lookup when no userId is given", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("resolve-sub"));
  // Seed a subscription row the way an earlier, userId-bearing event would.
  await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_seed", userId: owner, subscriptionId: "sub_lookup" }),
    { id: "evt_seed" },
    context.bindings,
  );
  // A later event for the same subscription omits userId entirely — an empty
  // "bySubscription" query string would throw instead of finding the owner.
  const outcome = await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_followup", userId: undefined, subscriptionId: "sub_lookup", status: "past_due" }),
    { id: "evt_followup" },
    context.bindings,
  );
  assert.equal(outcome, "applied");
  assert.equal(
    context.database.prepare("SELECT status FROM subscriptions WHERE external_subscription_id = 'sub_lookup'").get().status,
    "past_due",
  );
});

test("resolveSubscriptionUser only tries the customer-id lookup when a customerId is actually present", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("resolve-cust"));
  await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_cust_seed", userId: owner, subscriptionId: "sub_cust_seed", customerId: "cus_shared" }),
    { id: "evt_cust_seed" },
    context.bindings,
  );
  // No userId, no matching subscriptionId, but a matching customerId: must
  // still resolve — an inverted (or query-text-emptied) customerId guard
  // would either bail early or crash on an empty SQL string.
  const byCustomer = await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_cust_next", userId: undefined, subscriptionId: "sub_cust_new", customerId: "cus_shared" }),
    { id: "evt_cust_next" },
    context.bindings,
  );
  assert.equal(byCustomer, "applied");
  // No userId, no subscriptionId match, and no customerId at all: must fail
  // closed rather than proceed with an undefined lookup value.
  const noCustomer = await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_no_cust", userId: undefined, subscriptionId: "sub_absent", customerId: undefined }),
    { id: "evt_no_cust" },
    context.bindings,
  );
  assert.equal(noCustomer, "unknown_user");
});

test("prepaidAmount demands a real positive integer amount_total, with the exact validation message", async () => {
  const context = fixture();
  insertUser(context.database, uid("prepaid-amt"));
  const cases = [
    [null, /no positive amount_total/],
    [{}, /no positive amount_total/],
    [{ data: { object: { amount_total: 0 } } }, /no positive amount_total/],
    [{ data: { object: { amount_total: -1 } } }, /no positive amount_total/],
    [{ data: { object: { amount_total: 4.5 } } }, /no positive amount_total/],
  ];
  for (const [payload, pattern] of cases) {
    await assert.rejects(
      stripeBilling.applyNativeStripePrepaidPurchase(prepaidEvent({ userId: uid("prepaid-amt") }), payload, context.bindings),
      pattern,
      JSON.stringify(payload),
    );
  }
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM provider_events").get().n, 0, "a rejected amount must claim no event");
});

test("subscriptionRowId and the prepaid external_price_id use their exact documented formats", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("row-id"));
  await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_rowid", userId: owner, subscriptionId: "sub_rowid_1" }),
    { id: "evt_rowid" },
    context.bindings,
  );
  assert.equal(
    context.database.prepare("SELECT id FROM subscriptions WHERE external_subscription_id = 'sub_rowid_1'").get().id,
    "stripe:subscription:sub_rowid_1",
  );

  await stripeBilling.applyNativeStripePrepaidPurchase(
    prepaidEvent({ eventId: "evt_wallet_rowid", userId: owner, paymentIntentId: "pi_rowid_1", planId: "tracking-annual" }),
    { data: { object: { amount_total: 999 } } },
    context.bindings,
  );
  const row = context.database.prepare("SELECT id, external_price_id FROM subscriptions WHERE external_subscription_id = 'pi_rowid_1'").get();
  assert.equal(row.id, "stripe:prepaid:pi_rowid_1");
  assert.equal(row.external_price_id, "wallet:tracking-annual");
});

test("a subscription payload big enough to leave D1 is stored under the 'subscriptions' R2 prefix", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("big-sub"));
  const big = { padding: "x".repeat(200_000) };
  const outcome = await stripeBilling.applyNativeStripeSubscription(
    subscriptionEvent({ eventId: "evt_big", userId: owner, subscriptionId: "sub_big" }),
    big,
    context.bindings,
  );
  assert.equal(outcome, "applied");
  const key = context.database.prepare("SELECT raw_object_key FROM subscriptions WHERE external_subscription_id = 'sub_big'").get().raw_object_key;
  assert.match(key, /^private\/subscriptions\//);
  assert.ok(context.objects.has(key));
});

test("a big prepaid subscription payload also leaves D1 under the 'subscriptions' R2 prefix", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("big-prepaid"));
  const big = { padding: "x".repeat(200_000), data: { object: { amount_total: 100 } } };
  const outcome = await stripeBilling.applyNativeStripePrepaidPurchase(
    prepaidEvent({ eventId: "evt_big_prepaid", userId: owner, paymentIntentId: "pi_big" }),
    big,
    context.bindings,
  );
  assert.equal(outcome, "applied");
  const key = context.database.prepare("SELECT raw_object_key FROM subscriptions WHERE external_subscription_id = 'pi_big'").get().raw_object_key;
  assert.match(key, /^private\/subscriptions\//);
});

test("the prepaid purchase and refund receipts always go to R2, never inline, however small", async () => {
  for (const which of ["purchase", "refund"]) {
    const context = fixture();
    const owner = insertUser(context.database, uid(`force-${which}`));
    if (which === "refund") {
      await stripeBilling.applyNativeStripePrepaidPurchase(
        prepaidEvent({ eventId: "evt_seed_refund", userId: owner, paymentIntentId: "pi_force" }),
        { data: { object: { amount_total: 500 } } },
        context.bindings,
      );
    }
    context.bindings.files.put = async () => { throw new Error("R2 temporarily unavailable"); };
    const call = which === "purchase"
      ? stripeBilling.applyNativeStripePrepaidPurchase(
        prepaidEvent({ eventId: "evt_tiny", userId: owner, paymentIntentId: "pi_tiny" }),
        { data: { object: { amount_total: 500 } } },
        context.bindings,
      )
      : stripeBilling.applyNativeStripePrepaidRefund(
        { eventId: "evt_tiny_refund", eventAt: "2026-08-30T12:00:00.000Z", paymentIntentId: "pi_force", amountMinor: 500, fullRefundConfirmed: true },
        { id: "evt_tiny_refund" },
        context.bindings,
      );
    // forceObject:true means even this tiny receipt must be written to R2 — a
    // mutant that drops the option would store it inline and never call put(),
    // so the rejection below would not happen.
    await assert.rejects(call, /R2 temporarily unavailable/);
  }
});

test("a duplicate subscription delivery is detected from the receipt insert alone", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("dup-sub"));
  const event = subscriptionEvent({ eventId: "evt_dup", userId: owner, subscriptionId: "sub_dup" });
  assert.equal(await stripeBilling.applyNativeStripeSubscription(event, { id: event.eventId }, context.bindings), "applied");
  // Redelivering the exact same event id a second time must read purely as
  // "duplicate" from the receipt's own ON CONFLICT DO NOTHING, not fall
  // through to a stale/unknown_user re-derivation.
  assert.equal(await stripeBilling.applyNativeStripeSubscription(event, { id: event.eventId }, context.bindings), "duplicate");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM provider_events").get().n, 1);
});

test("a prepaid purchase requires both the subscription row and the ledger row to change before reporting 'applied'", async () => {
  const owner = uid("asym");

  // Scenario (a): the subscription upsert changes a row (1) but the ledger
  // insert conflicts on a pre-existing payment_intent_id (0) — only a real
  // `&&` (not `||`, and not either side forced true/>=0) must call this "stale".
  {
    const context = fixture();
    insertUser(context.database, owner);
    context.database.prepare(`
      INSERT INTO subscriptions (id, user_id, provider, status, tier, external_subscription_id, verified_at, created_at, updated_at)
      VALUES ('decoy-sub-1', ?, 'stripe', 'active', 'ai', 'decoy-ext-id', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z')
    `).run(owner);
    context.database.prepare(`
      INSERT INTO stripe_prepaid_purchases (payment_intent_id, user_id, subscription_id, amount_minor, created_at)
      VALUES ('pi_target_a', ?, 'decoy-sub-1', 100, '2026-08-29T00:00:00.000000000Z')
    `).run(owner);
    const outcome = await stripeBilling.applyNativeStripePrepaidPurchase(
      prepaidEvent({ eventId: "evt_asym_a", userId: owner, paymentIntentId: "pi_target_a" }),
      { data: { object: { amount_total: 321 } } },
      context.bindings,
    );
    // Unlike the subscription and refund writers, a live user here falls back
    // to "duplicate" rather than "stale" — see the last line of
    // applyNativeStripePrepaidPurchase.
    assert.equal(outcome, "duplicate");
  }

  // Scenario (b): the ledger insert changes a row (1, the id it guards on
  // already exists) but the subscription upsert changes none (0) — the
  // opposite asymmetry, needed to pin the *other* side of the `&&`.
  {
    const context = fixture();
    insertUser(context.database, owner);
    context.database.prepare(`
      INSERT INTO subscriptions (id, user_id, provider, status, tier, external_subscription_id, verified_at, created_at, updated_at)
      VALUES ('stripe:prepaid:pi_target_b', ?, 'stripe', 'active', 'ai', 'pi_target_b', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z')
    `).run(owner);
    const outcome = await stripeBilling.applyNativeStripePrepaidPurchase(
      prepaidEvent({ eventId: "evt_asym_b", userId: owner, paymentIntentId: "pi_target_b" }),
      { data: { object: { amount_total: 654 } } },
      context.bindings,
    );
    assert.equal(outcome, "duplicate");
  }
});

test("a stale full-refund event changes no row and must not report 'applied'", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("stale-refund"));
  await stripeBilling.applyNativeStripePrepaidPurchase(
    prepaidEvent({ eventId: "evt_refund_seed", userId: owner, paymentIntentId: "pi_stale_refund", eventAt: "2026-08-29T12:00:00.000Z" }),
    { data: { object: { amount_total: 700 } } },
    context.bindings,
  );
  await stripeBilling.applyNativeStripePrepaidRefund(
    { eventId: "evt_refund_first", eventAt: "2026-09-01T00:00:00.000Z", paymentIntentId: "pi_stale_refund", amountMinor: 700, fullRefundConfirmed: true },
    { id: "evt_refund_first" },
    context.bindings,
  );
  // A second, fresh event id, but its eventAt is *earlier* than the refund
  // already applied — the ordering guard must block the update.
  const stale = await stripeBilling.applyNativeStripePrepaidRefund(
    { eventId: "evt_refund_stale", eventAt: "2026-08-31T00:00:00.000Z", paymentIntentId: "pi_stale_refund", amountMinor: 700, fullRefundConfirmed: true },
    { id: "evt_refund_stale" },
    context.bindings,
  );
  assert.equal(stale, "stale");
});

test("a big full-refund replacement payload also leaves D1 under the 'subscriptions' R2 prefix", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("big-refund"));
  await stripeBilling.applyNativeStripePrepaidPurchase(
    prepaidEvent({ eventId: "evt_big_refund_seed", userId: owner, paymentIntentId: "pi_big_refund" }),
    { data: { object: { amount_total: 800 } } },
    context.bindings,
  );
  const big = { padding: "x".repeat(200_000), data: { object: { amount_total: 800 } } };
  const outcome = await stripeBilling.applyNativeStripePrepaidRefund(
    { eventId: "evt_big_refund", eventAt: "2026-08-30T12:00:00.000Z", paymentIntentId: "pi_big_refund", amountMinor: 800, fullRefundConfirmed: true },
    big,
    context.bindings,
  );
  assert.equal(outcome, "applied");
  const key = context.database.prepare("SELECT raw_object_key FROM subscriptions WHERE external_subscription_id = 'pi_big_refund'").get().raw_object_key;
  assert.match(key, /^private\/subscriptions\//);
});

/* ==========================================================================
   Shared: a small D1 query spy, for chunk-boundary tests that need to see
   how many times (and with how many bound values) a specific query ran —
   the return VALUE alone does not distinguish an extra empty D1 chunk from
   none, since `WHERE id IN ()` legitimately matches zero rows either way.
   ========================================================================== */

function spiedBindings(bindings, sqlPattern) {
  const chunkSizes = [];
  const realDb = bindings.db;
  return {
    chunkSizes,
    bindings: {
      ...bindings,
      db: {
        prepare(sql) {
          const real = realDb.prepare(sql);
          if (!sqlPattern.test(sql)) return real;
          return {
            bind(...values) {
              chunkSizes.push(values.length);
              return real.bind(...values);
            },
          };
        },
        batch: (...args) => realDb.batch(...args),
      },
    },
  };
}

/* ==========================================================================
   native-identity-backfill.ts — the only writer for legacy Google identity
   links
   ========================================================================== */

function googleIdentity(overrides = {}) {
  return {
    authUserId: uid("gid", 1),
    identityUserId: uid("gid", 1),
    providerSubject: "google-subject-1",
    email: "learner@example.test",
    emailVerified: true,
    ...overrides,
  };
}

test("backfillNativeGoogleIdentities chunks D1 lookups at exactly the 80-row boundary", async () => {
  const context = fixture();
  const identities = [];
  for (let i = 0; i < 80; i += 1) {
    const id = uid("chunk80", i);
    insertUser(context.database, id);
    identities.push(googleIdentity({ authUserId: id, identityUserId: id, providerSubject: `subject-chunk80-${i}` }));
  }
  const spy = spiedBindings(context.bindings, /SELECT id FROM app_users/);
  const result = await identityBackfill.backfillNativeGoogleIdentities(spy.bindings, { readSource: async () => identities });
  assert.deepEqual(result, { sourceGoogleIdentities: 80, mappingsCreated: 80, mappingsAlreadyCorrect: 0 });
  // Exactly 80 values in exactly one call: a mutant that lets the chunk loop
  // run one iteration past the boundary would add a second, empty (0-value)
  // call here.
  assert.deepEqual(spy.chunkSizes, [80]);
});

test("backfillNativeGoogleIdentities rejects an identity whose user id is not a live D1 user", async () => {
  const context = fixture();
  const liveId = uid("live", 1);
  insertUser(context.database, liveId);
  const missingId = uid("missing", 1);
  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      readSource: async () => [googleIdentity({ authUserId: missingId, identityUserId: missingId, providerSubject: "subject-missing" })],
    }),
    /one or more Google identities do not have a live D1 user/,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_user_identities").get().n, 0);
});

test("backfillNativeGoogleIdentities rejects a source with an invalid record before writing anything", async () => {
  const context = fixture();
  const id = uid("malformed", 1);
  insertUser(context.database, id);
  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      readSource: async () => [
        googleIdentity({ authUserId: id, identityUserId: id, providerSubject: "ok-subject" }),
        googleIdentity({ authUserId: "too-short", identityUserId: "too-short", providerSubject: "bad-subject" }),
      ],
    }),
    /Google identity source is malformed/,
  );
});

test("backfillNativeGoogleIdentities rejects a record whose authUserId and identityUserId disagree", async () => {
  const context = fixture();
  const id = uid("mismatch-uid", 1);
  insertUser(context.database, id);
  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      readSource: async () => [googleIdentity({ authUserId: id, identityUserId: uid("mismatch-uid", 2), providerSubject: "mismatch-uid-subject" })],
    }),
    /Google identity source is malformed/,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_user_identities").get().n, 0);
});

test("backfillNativeGoogleIdentities' normalise() enforces the exact userId and subject length boundaries", async () => {
  function idOfLength(len) {
    return "u".repeat(len);
  }
  const cases = [
    [idOfLength(15), "sub-len", false, "userId one under 16"],
    [idOfLength(16), "sub-len", true, "userId exactly 16"],
    [idOfLength(80), "sub-len", true, "userId exactly 80"],
    [idOfLength(81), "sub-len", false, "userId one over 80"],
    [idOfLength(20), "", false, "subject one under length 1"],
    [idOfLength(20), "s", true, "subject exactly length 1"],
    [idOfLength(20), "s".repeat(255), true, "subject exactly 255"],
    [idOfLength(20), "s".repeat(256), false, "subject one over 255"],
  ];
  for (const [rawId, subject, expectValid, why] of cases) {
    const context = fixture();
    // A fresh, distinctly-lengthed id each time — insert it live only when
    // the case expects the row to be treated as valid.
    if (expectValid) insertUser(context.database, rawId);
    const call = identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      readSource: async () => [googleIdentity({ authUserId: rawId, identityUserId: rawId, providerSubject: subject })],
    });
    if (expectValid) {
      const result = await call;
      assert.equal(result.sourceGoogleIdentities, 1, why);
    } else {
      // Every invalid case must be rejected by validateSource itself, before
      // the function ever touches D1 — never by the separate (and, for a
      // 15- or 81-character id, unreachable-to-set-up) live-user check.
      await assert.rejects(call, /Google identity source is malformed$/, why);
    }
  }
});

test("backfillNativeGoogleIdentities rejects two different Google subjects claimed for the same user", async () => {
  const context = fixture();
  const id = uid("dup-user", 1);
  insertUser(context.database, id);
  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      readSource: async () => [
        googleIdentity({ authUserId: id, identityUserId: id, providerSubject: "subject-one" }),
        googleIdentity({ authUserId: id, identityUserId: id, providerSubject: "subject-two" }),
      ],
    }),
    /Google identity source has multiple Google identities for one user/,
  );
});

test("backfillNativeGoogleIdentities normalises email presence, case and the verified flag on write", async () => {
  const cases = [
    { email: "  Mixed@Example.TEST  ", emailVerified: true, expectEmail: "mixed@example.test", expectVerified: 1 },
    { email: "ab", emailVerified: true, expectEmail: null, expectVerified: 1, why: "email one under the length floor" },
    { email: "abc", emailVerified: true, expectEmail: "abc", expectVerified: 1, why: "email exactly at the length floor (3)" },
    { email: `${"a".repeat(250)}@b.c`, emailVerified: true, expectEmail: `${"a".repeat(250)}@b.c`, expectVerified: 1, why: "email exactly at the length ceiling (254)" },
    { email: `${"a".repeat(251)}@b.c`, emailVerified: true, expectEmail: null, expectVerified: 1, why: "email one over the length ceiling" },
    { email: "ok@example.test", emailVerified: "yes", expectEmail: "ok@example.test", expectVerified: 0, why: "a truthy non-boolean must not read as verified" },
    { email: "ok@example.test", emailVerified: false, expectEmail: "ok@example.test", expectVerified: 0 },
  ];
  for (const [index, testCase] of cases.entries()) {
    const context = fixture();
    const id = uid("norm", index);
    insertUser(context.database, id);
    await identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      readSource: async () => [googleIdentity({
        authUserId: id,
        identityUserId: id,
        providerSubject: `subject-norm-${index}`,
        email: testCase.email,
        emailVerified: testCase.emailVerified,
      })],
    });
    const row = context.database.prepare("SELECT email, email_verified FROM app_user_identities WHERE user_id = ?").get(id);
    assert.equal(row.email, testCase.expectEmail, testCase.why ?? JSON.stringify(testCase));
    assert.equal(row.email_verified, testCase.expectVerified, testCase.why ?? JSON.stringify(testCase));
  }
});

test("backfillNativeGoogleIdentities counts an already-correct mapping instead of rewriting it", async () => {
  const context = fixture();
  const id = uid("already", 1);
  insertUser(context.database, id);
  const source = { readSource: async () => [googleIdentity({ authUserId: id, identityUserId: id, providerSubject: "subject-already" })] };
  const first = await identityBackfill.backfillNativeGoogleIdentities(context.bindings, source);
  assert.deepEqual(first, { sourceGoogleIdentities: 1, mappingsCreated: 1, mappingsAlreadyCorrect: 0 });
  // A second pass over the exact same source must recognise the row it just
  // wrote as already correct — this depends on the subject->user and
  // user->subject read-back maps actually being populated from D1.
  const second = await identityBackfill.backfillNativeGoogleIdentities(context.bindings, source);
  assert.deepEqual(second, { sourceGoogleIdentities: 1, mappingsCreated: 0, mappingsAlreadyCorrect: 1 });
});

test("backfillNativeGoogleIdentities refuses to relink a subject or a user away from an existing mapping", async () => {
  const context = fixture();
  const userA = uid("relink-a", 1);
  const userB = uid("relink-b", 1);
  insertUser(context.database, userA);
  insertUser(context.database, userB);
  await identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
    readSource: async () => [googleIdentity({ authUserId: userA, identityUserId: userA, providerSubject: "subject-stable" })],
  });

  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      // The source now claims the same subject for a different, still-live user.
      readSource: async () => [googleIdentity({ authUserId: userB, identityUserId: userB, providerSubject: "subject-stable" })],
    }),
    /an existing Google subject mapping points to another user/,
  );

  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(context.bindings, {
      // The source now claims a different subject for the already-mapped user.
      readSource: async () => [googleIdentity({ authUserId: userA, identityUserId: userA, providerSubject: "subject-new" })],
    }),
    /an existing user has a different Google subject mapping/,
  );

  assert.deepEqual(
    { ...context.database.prepare("SELECT provider_subject, user_id FROM app_user_identities").get() },
    { provider_subject: "subject-stable", user_id: userA },
  );
});

test("backfillNativeGoogleIdentities surfaces a failed D1 write instead of certifying it", async () => {
  const id = uid("write-fail", 1);
  const idTwo = uid("write-fail", 2);
  const liveIds = new Set([id, idTwo]);
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              sql,
              values,
              async all() {
                if (sql.includes("SELECT id FROM app_users")) {
                  return { success: true, results: values.filter((v) => liveIds.has(v)).map((v) => ({ id: v })) };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
      async batch(statements) {
        assert.match(statements[0].sql, /INSERT INTO app_user_identities/);
        // One real success and one real failure in the same batch — this is
        // what actually distinguishes `.some(...)` from `.every(...)`: with
        // only one statement, either method reads identically.
        return statements.map((_, index) => (index === 0
          ? { success: true, meta: { changes: 1 } }
          : { success: false, meta: { changes: 0 } }));
      },
    },
  };
  await assert.rejects(
    identityBackfill.backfillNativeGoogleIdentities(bindings, {
      readSource: async () => [
        googleIdentity({ authUserId: id, identityUserId: id, providerSubject: "subject-write-fail-1" }),
        googleIdentity({ authUserId: idTwo, identityUserId: idTwo, providerSubject: "subject-write-fail-2" }),
      ],
    }),
    /a Google identity mapping could not be written/,
  );
});

/* ==========================================================================
   native-password-import.ts — the only D1 writer for an imported legacy
   password verifier
   ========================================================================== */

const VALID_BCRYPT = "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm";
const VALID_CREDENTIAL_INPUT = {
  userId: "u".repeat(20),
  email: "  Learner@Example.TEST  ",
  verifier: VALID_BCRYPT,
  sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
};

test("parseImportedPasswordCredential rejects the wrong JS shape outright", () => {
  for (const bad of [null, undefined, "a string", 42, [], [1, 2]]) {
    assert.equal(passwordImport.parseImportedPasswordCredential(bad), null, JSON.stringify(bad));
  }
  // A function is truthy and not an array, so only the `typeof !== "object"`
  // check rejects it — attach otherwise-fully-valid fields to prove that
  // check is what's doing the work, not the falsy/array checks alone.
  const fn = Object.assign(() => {}, { ...VALID_CREDENTIAL_INPUT });
  assert.equal(passwordImport.parseImportedPasswordCredential(fn), null, "a function must never be accepted as a credential object");
});

test("parseImportedPasswordCredential trims and lower-cases, and enforces every boundary", () => {
  const parsed = passwordImport.parseImportedPasswordCredential(VALID_CREDENTIAL_INPUT);
  assert.equal(parsed.email, "learner@example.test");
  assert.equal(parsed.userId, VALID_CREDENTIAL_INPUT.userId);

  const cases = [
    [{ userId: "u".repeat(15) }, null, "userId one under the floor"],
    [{ userId: "u".repeat(16) }, "ok", "userId exactly at the floor"],
    [{ userId: "u".repeat(80) }, "ok", "userId exactly at the ceiling"],
    [{ userId: "u".repeat(81) }, null, "userId one over the ceiling"],
    [{ userId: `  ${"u".repeat(78)}  ` }, "ok", "untrimmed length 82 is over the ceiling, but trimmed length 78 is valid"],
    [{ userId: 12345678901234567 }, null, "a non-string userId, even one whose fallback text would pass the length check"],
    [{ email: "" }, null, "empty email"],
    [{ email: "not-an-email" }, null, "missing @"],
    [{ email: `${"a".repeat(251)}@b.c` }, null, "email one over 254 (255 total)"],
    [{ email: `${"a".repeat(250)}@b.c` }, "ok", "email exactly 254"],
    [{ verifier: "not-a-bcrypt-verifier" }, null],
    [{ verifier: 12345 }, null, "a non-string verifier"],
    [{ sourceUpdatedAt: "not a date" }, null],
    [{ sourceUpdatedAt: 1723852800000 }, null, "a numeric timestamp is not accepted"],
  ];
  for (const [overrides, expect, why] of cases) {
    const result = passwordImport.parseImportedPasswordCredential({ ...VALID_CREDENTIAL_INPUT, ...overrides });
    if (expect === null) assert.equal(result, null, why);
    else assert.notEqual(result, null, why);
  }
});

test("importNativePasswordCredential stores, recognises an already-newer row, and reports a mismatch — with real D1", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("import-cred"), { email: "learner@example.test" });

  const first = await passwordImport.importNativePasswordCredential({
    userId: owner, email: "learner@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  }, context.bindings);
  assert.equal(first, "stored");
  assert.equal(
    context.database.prepare("SELECT identity_authority FROM app_users WHERE id = ?").get(owner).identity_authority,
    "cloudflare",
  );

  // An older export than what's already stored must not overwrite it.
  const older = await passwordImport.importNativePasswordCredential({
    userId: owner, email: "learner@example.test", verifier: "$2b$10$O3qtiPNUNg1dIX2p3iY2Z.45nGd9IL8UnLiW2C/RUxNh5JysNcpE.", sourceUpdatedAt: "2026-08-27T00:00:00.000Z",
  }, context.bindings);
  assert.equal(older, "already_newer");
  assert.equal(
    context.database.prepare("SELECT verifier FROM app_password_credentials WHERE user_id = ?").get(owner).verifier,
    VALID_BCRYPT,
    "the older verifier must not have been written",
  );

  // A newer export, still the same account, does overwrite.
  const newer = await passwordImport.importNativePasswordCredential({
    userId: owner, email: "learner@example.test", verifier: "$2b$10$O3qtiPNUNg1dIX2p3iY2Z.45nGd9IL8UnLiW2C/RUxNh5JysNcpE.", sourceUpdatedAt: "2026-08-29T00:00:00.000Z",
  }, context.bindings);
  assert.equal(newer, "stored");

  // Wrong email for that exact user id: no write to either table.
  const wrongEmail = await passwordImport.importNativePasswordCredential({
    userId: owner, email: "someone-else@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
  }, context.bindings);
  assert.equal(wrongEmail, "mismatch");
});

test("importNativePasswordCredential's success:false and short-batch guards are load-bearing", async () => {
  const credential = { userId: uid("guard", 1), email: "guard1@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };

  const failing = {
    files: {},
    db: {
      prepare(sql) { return { bind: (...values) => ({ sql, values, async run() { return { success: false, meta: { changes: 0 } }; } }) }; },
      async batch(statements) { return statements.map((s) => s.run()); },
    },
  };
  await assert.rejects(
    passwordImport.importNativePasswordCredential(credential, failing),
    /native password credential could not be imported/,
  );

  // A batch() that (incorrectly) returns fewer results than statements sent
  // must still resolve to "mismatch" rather than throw on an unguarded
  // `results[n].meta` read.
  const short = {
    files: {},
    db: {
      prepare(sql) { return { bind: (...values) => ({ sql, values, async run() { return { success: true, meta: { changes: 1 } }; } }) }; },
      async batch() { return []; },
    },
  };
  assert.equal(await passwordImport.importNativePasswordCredential(credential, short), "mismatch");

  // A batch() reply with a hole at exactly index 0 (results[1] present and
  // fine) must still resolve cleanly to "already_newer" rather than throw —
  // this is the one shape that isolates results[0]'s own optional chaining
  // from results[1]'s (a fully-missing array trips the results[1] guard
  // first and never reaches this line at all).
  const holeAtZero = {
    files: {},
    db: {
      prepare(sql) { return { bind: (...values) => ({ sql, values, async run() { return { success: true, meta: { changes: 1 } }; } }) }; },
      async batch() {
        const results = [];
        results[1] = { success: true, meta: { changes: 1 } };
        return results;
      },
    },
  };
  assert.equal(await passwordImport.importNativePasswordCredential(credential, holeAtZero), "already_newer");
});

test("importNativePasswordCredentialBatch refuses an empty or an over-size batch before touching D1", async () => {
  const bindings = { db: {}, files: {} };
  assert.deepEqual(await passwordImport.importNativePasswordCredentialBatch([], bindings), { status: "mismatch", stored: 0 });
  const oneOver = Array.from({ length: 501 }, (_, i) => ({
    userId: uid("over", i), email: `over${i}@example.test`, verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  }));
  assert.deepEqual(await passwordImport.importNativePasswordCredentialBatch(oneOver, bindings), { status: "mismatch", stored: 0 });
  // Exactly at the ceiling must at least pass the length gate (and then fail
  // for the mundane reason that `bindings.db` here has no real prepare()).
  const atCeiling = oneOver.slice(1);
  assert.equal(atCeiling.length, 500);
  await assert.rejects(() => passwordImport.importNativePasswordCredentialBatch(atCeiling, {
    db: { prepare() { throw new Error("reached D1, as expected for exactly 500"); } }, files: {},
  }));
});

test("importNativePasswordCredentialBatch rejects a duplicate userId or a case-insensitive duplicate email inside one batch", async () => {
  const bindings = { db: {}, files: {} };
  const base = { verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };
  const dupUser = [
    { ...base, userId: uid("dup", 1), email: "one@example.test" },
    { ...base, userId: uid("dup", 1), email: "two@example.test" },
  ];
  assert.deepEqual(await passwordImport.importNativePasswordCredentialBatch(dupUser, bindings), { status: "mismatch", stored: 0 });

  const dupEmail = [
    { ...base, userId: uid("dupe", 1), email: "Same@Example.Test" },
    { ...base, userId: uid("dupe", 2), email: "same@example.test" },
  ];
  assert.deepEqual(await passwordImport.importNativePasswordCredentialBatch(dupEmail, bindings), { status: "mismatch", stored: 0 });
});

test("importNativePasswordCredentialBatch writes a complete, matched batch atomically — with real D1", async () => {
  const context = fixture();
  const first = { userId: uid("batch", 1), email: "batch1@example.test" };
  const second = { userId: uid("batch", 2), email: "batch2@example.test" };
  insertUser(context.database, first.userId, { email: first.email });
  insertUser(context.database, second.userId, { email: second.email });

  const credentials = [first, second].map((who, i) => ({
    userId: who.userId,
    email: who.email,
    verifier: i === 0 ? VALID_BCRYPT : "$2b$10$O3qtiPNUNg1dIX2p3iY2Z.45nGd9IL8UnLiW2C/RUxNh5JysNcpE.",
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  }));
  const result = await passwordImport.importNativePasswordCredentialBatch(credentials, context.bindings);
  assert.deepEqual(result, { status: "stored", stored: 2 });
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_password_credentials").get().n, 2);

  // A batch where even one account id does not match a live account must
  // write nothing at all for the whole batch.
  const thirdMismatch = [...credentials, { userId: uid("batch", 3), email: "missing@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" }];
  const rejectedBatch = await passwordImport.importNativePasswordCredentialBatch(thirdMismatch, context.bindings);
  assert.deepEqual(rejectedBatch, { status: "mismatch", stored: 0 });
});

test("importNativePasswordCredentialBatch refuses to proceed on a bare success:false from the account precheck", async () => {
  // A real D1 .all() never reports success:false without throwing, and any
  // row-count/email mismatch is independently caught later — so this needs a
  // fake that reports success:false while still handing back data that would
  // otherwise look like a perfect match, to isolate this one guard.
  const credential = { userId: uid("acctfail", 1), email: "acctfail1@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        if (sql.includes("SELECT id, email FROM app_users")) {
          return { bind: () => ({ async all() { return { success: false, results: [{ id: credential.userId, email: credential.email }] }; } }) };
        }
        throw new Error(`unexpected D1 statement reached: ${sql}`);
      },
    },
  };
  const result = await passwordImport.importNativePasswordCredentialBatch([credential], bindings);
  assert.deepEqual(result, { status: "mismatch", stored: 0 });
});

test("importNativePasswordCredentialBatch rejects an account precheck with more rows than credentials requested", async () => {
  // Every requested credential having a correct, matching row is not enough:
  // an extra, unrequested row in the account precheck must also fail the
  // batch. A per-id email lookup alone would miss this (each real credential
  // still finds its own correct match); only the row-count check catches it.
  const credential = { userId: uid("acctextra", 1), email: "acctextra1@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        if (sql.includes("SELECT id, email FROM app_users")) {
          return {
            bind: () => ({
              async all() {
                return {
                  success: true,
                  results: [
                    { id: credential.userId, email: credential.email },
                    { id: "an-unrelated-account-id", email: "unrelated@example.test" },
                  ],
                };
              },
            }),
          };
        }
        throw new Error(`unexpected D1 statement reached: ${sql}`);
      },
    },
  };
  const result = await passwordImport.importNativePasswordCredentialBatch([credential], bindings);
  assert.deepEqual(result, { status: "mismatch", stored: 0 });
});

test("importNativePasswordCredentialBatch rejects a stale export whose email no longer matches the live account — with real D1", async () => {
  // The account count matches exactly (unlike the earlier mismatch tests),
  // so only the per-credential email comparison can catch this: the export
  // claims an email the account no longer has. A second, perfectly-matching
  // credential alongside it is what actually distinguishes `.some(...)` (any
  // one mismatch fails the batch) from `.every(...)` (only failing if *all*
  // of them mismatch, which a single bad credential in a mixed batch never is).
  const context = fixture();
  const owner = insertUser(context.database, uid("staleemail", 1), { email: "current@example.test" });
  const okOwner = insertUser(context.database, uid("staleemail", 2), { email: "ok@example.test" });
  const credential = { userId: owner, email: "stale-export-email@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };
  const okCredential = { userId: okOwner, email: "ok@example.test", verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };
  const result = await passwordImport.importNativePasswordCredentialBatch([credential, okCredential], context.bindings);
  assert.deepEqual(result, { status: "mismatch", stored: 0 });
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_password_credentials").get().n, 0);
});

test("importNativePasswordCredentialBatch rolls back completely when a concurrent change breaks the exact-import guard", async () => {
  const context = fixture();
  const who = { userId: uid("race", 1), email: "race1@example.test" };
  insertUser(context.database, who.userId, { email: who.email });
  const credential = { userId: who.userId, email: who.email, verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };

  // Wrap batch() so that, right before it runs, the account's email changes
  // underneath the already-read precheck — the guard statement must then
  // raise, and the whole batch (including the credential insert that
  // "succeeded" moments before) must roll back.
  const racingDb = {
    ...context.bindings.db,
    async batch(statements) {
      context.database.prepare("UPDATE app_users SET email = ? WHERE id = ?").run("changed@example.test", who.userId);
      return context.bindings.db.batch(statements);
    },
  };
  await assert.rejects(
    passwordImport.importNativePasswordCredentialBatch([credential], { ...context.bindings, db: racingDb }),
    /native password credential batch could not be imported|constraint|overflow/i,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_password_credentials").get().n, 0);
});

test("importNativePasswordCredentialBatch refuses to certify a batch() reply shorter than the statements it sent", async () => {
  // Real D1's batch() either returns one result per statement or throws —
  // it can never silently hand back fewer results. This defensive check
  // guards against exactly that misbehaviour, so only a fake can trigger it.
  const context = fixture();
  const who = { userId: uid("shortbatch", 1), email: "shortbatch1@example.test" };
  insertUser(context.database, who.userId, { email: who.email });
  const credential = { userId: who.userId, email: who.email, verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };

  const realDb = context.bindings.db;
  const shortReplyDb = {
    ...realDb,
    async batch(statements) {
      assert.equal(statements.length, 3, "one credential is 3 statements: insert, identity_authority update, exact-import guard");
      // Two good-looking results for three statements sent.
      return [{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } }];
    },
  };
  await assert.rejects(
    passwordImport.importNativePasswordCredentialBatch([credential], { ...context.bindings, db: shortReplyDb }),
    /native password credential batch could not be imported/,
  );
});

test("importNativePasswordCredentialBatch refuses to certify a batch() reply with even one failed statement among the rest", async () => {
  // Real D1's batch() rolls back (and throws) on any single statement
  // failure, so it can never hand back a correct-length array containing a
  // mix of success:true and success:false — only a fake can model that shape,
  // which is exactly what distinguishes .some(...) from .every(...) here.
  const context = fixture();
  const who = { userId: uid("mixedbatch", 1), email: "mixedbatch1@example.test" };
  insertUser(context.database, who.userId, { email: who.email });
  const credential = { userId: who.userId, email: who.email, verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" };

  const realDb = context.bindings.db;
  const mixedReplyDb = {
    ...realDb,
    async batch(statements) {
      assert.equal(statements.length, 3);
      return [
        { success: true, meta: { changes: 1 } },
        { success: false, meta: { changes: 0 } },
        { success: true, meta: { changes: 1 } },
      ];
    },
  };
  await assert.rejects(
    passwordImport.importNativePasswordCredentialBatch([credential], { ...context.bindings, db: mixedReplyDb }),
    /native password credential batch could not be imported/,
  );
});

test("importNativePasswordCredentialBatch reports 'mismatch' when even one credential's own write pair didn't both change exactly once", async () => {
  // Two credentials: the first's insert+update pair both changed a row, the
  // second's insert was silently skipped (changes:0, as a stale-timestamp
  // ON CONFLICT guard would do) while its update still went through. Every
  // credential must individually pass — one bad apple must fail the whole
  // batch, not be outvoted by the good one, which is what actually tells
  // `.every(...)` apart from `.some(...)` here.
  const context = fixture();
  const first = { userId: uid("exactly1", 1), email: "exactly1-1@example.test" };
  const second = { userId: uid("exactly1", 2), email: "exactly1-2@example.test" };
  insertUser(context.database, first.userId, { email: first.email });
  insertUser(context.database, second.userId, { email: second.email });
  const credentials = [first, second].map((who) => ({ userId: who.userId, email: who.email, verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" }));

  const realDb = context.bindings.db;
  const partialWriteDb = {
    ...realDb,
    async batch(statements) {
      assert.equal(statements.length, 6);
      return [
        { success: true, meta: { changes: 1 } }, // credential 1: insert
        { success: true, meta: { changes: 1 } }, // credential 1: identity_authority update
        { success: true, meta: { changes: 1 } }, // credential 1: exact-import guard
        { success: true, meta: { changes: 0 } }, // credential 2: insert — skipped
        { success: true, meta: { changes: 1 } }, // credential 2: identity_authority update
        { success: true, meta: { changes: 1 } }, // credential 2: exact-import guard
      ];
    },
  };
  const result = await passwordImport.importNativePasswordCredentialBatch(credentials, { ...context.bindings, db: partialWriteDb });
  assert.deepEqual(result, { status: "mismatch", stored: 0 });
});

test("importNativePasswordCredentialBatch's per-credential write check reads its own two write statements, not any other credential's", async () => {
  // Credential 1's own insert+update both changed a row; credential 2's own
  // insert+update both changed a row too. Credential 1's *guard* entry (not
  // one of the two writes this check should look at) is deliberately not 1 —
  // a wrong start offset for the second credential's slice would pull that
  // unrelated entry into its own check and wrongly fail a batch that is, in
  // every way that matters, complete.
  const context = fixture();
  const first = { userId: uid("ownslice", 1), email: "ownslice-1@example.test" };
  const second = { userId: uid("ownslice", 2), email: "ownslice-2@example.test" };
  insertUser(context.database, first.userId, { email: first.email });
  insertUser(context.database, second.userId, { email: second.email });
  const credentials = [first, second].map((who) => ({ userId: who.userId, email: who.email, verifier: VALID_BCRYPT, sourceUpdatedAt: "2026-08-28T00:00:00.000Z" }));

  const realDb = context.bindings.db;
  const oddGuardDb = {
    ...realDb,
    async batch(statements) {
      assert.equal(statements.length, 6);
      return [
        { success: true, meta: { changes: 1 } }, // credential 1: insert
        { success: true, meta: { changes: 1 } }, // credential 1: identity_authority update
        { success: true, meta: { changes: 0 } }, // credential 1: exact-import guard — not one of "its" two writes
        { success: true, meta: { changes: 1 } }, // credential 2: insert
        { success: true, meta: { changes: 1 } }, // credential 2: identity_authority update
        { success: true, meta: { changes: 1 } }, // credential 2: exact-import guard
      ];
    },
  };
  const result = await passwordImport.importNativePasswordCredentialBatch(credentials, { ...context.bindings, db: oddGuardDb });
  assert.deepEqual(result, { status: "stored", stored: 2 });
});

/* ==========================================================================
   native-password-migration-audit.ts — aggregate proof of the password import
   ========================================================================== */

function proofBindings({ tableExists = true, storedProof = null, rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    bindings: {
      files: {},
      db: {
        prepare(sql) {
          if (sql.includes("sqlite_master")) {
            return { first: async () => (tableExists ? { name: "native_password_migration_proofs" } : null) };
          }
          if (sql.includes("FROM native_password_migration_proofs")) {
            return { first: async () => storedProof };
          }
          if (sql.includes("FROM app_password_credentials")) {
            return {
              bind(...values) {
                calls.push(values);
                // A short (< PAGE_SIZE) first page: importedRows returns
                // immediately with exactly `rows`, never looping.
                return { async all() { return { success: true, results: rows, meta: {} }; } };
              },
            };
          }
          if (sql.includes("INSERT INTO native_password_migration_proofs")) {
            return { bind: (...values) => ({ async run() { calls.push(values); return { success: true, meta: { changes: 1 } }; } }) };
          }
          throw new Error(`unexpected D1 statement: ${sql}`);
        },
      },
    },
  };
}

function credentialRow(overrides = {}) {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    source_updated_at: "2026-08-28T00:00:00.000Z",
    verifier: VALID_BCRYPT,
    ...overrides,
  };
}

test("nativePasswordMigrationEvidence reads 'missing' only from a genuinely absent proof table — real D1", async () => {
  const context = fixture();
  assert.equal((await passwordMigrationAudit.nativePasswordMigrationEvidence(context.bindings)).status, "pending");
  context.database.exec("DROP TABLE native_password_migration_proofs");
  assert.deepEqual(await passwordMigrationAudit.nativePasswordMigrationEvidence(context.bindings), {
    status: "missing", sourceRows: null, importedRows: null, verifiedAt: null,
  });
});

test("nativePasswordMigrationEvidence is 'pending' before any certificate is stored, regardless of imported rows", async () => {
  const { bindings } = proofBindings({ rows: [credentialRow()] });
  const evidence = await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings);
  assert.equal(evidence.status, "pending");
  assert.equal(evidence.importedRows, 1);
  assert.equal(evidence.sourceRows, null);
});

test("nativePasswordMigrationEvidence treats a structurally invalid stored proof as a mismatch, not verified", async () => {
  const validManifest = await passwordProof.passwordProofManifest([credentialRow()].map((r) => ({ userId: r.user_id, sourceUpdatedAt: r.source_updated_at, verifier: r.verifier })));
  const cases = [
    { source_rows: -1, source_manifest_sha256: validManifest, target_rows: 1, target_manifest_sha256: validManifest, verified_at: "2026-08-28T02:00:00.000Z" },
    { source_rows: 1, source_manifest_sha256: "not-64-hex", target_rows: 1, target_manifest_sha256: validManifest, verified_at: "2026-08-28T02:00:00.000Z" },
    { source_rows: 1, source_manifest_sha256: validManifest, target_rows: -1, target_manifest_sha256: validManifest, verified_at: "2026-08-28T02:00:00.000Z" },
    { source_rows: 1, source_manifest_sha256: validManifest, target_rows: 1, target_manifest_sha256: "not-64-hex", verified_at: "2026-08-28T02:00:00.000Z" },
    { source_rows: 1, source_manifest_sha256: validManifest, target_rows: 1, target_manifest_sha256: validManifest, verified_at: "not a date" },
  ];
  for (const storedProof of cases) {
    const { bindings } = proofBindings({ storedProof, rows: [credentialRow()] });
    const evidence = await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings);
    assert.equal(evidence.status, "mismatch", JSON.stringify(storedProof));
  }
});

test("nativePasswordMigrationEvidence is 'mismatch' when the live rows can't even be canonicalised", async () => {
  // Two rows sharing a userId make passwordProofManifest return null.
  const rows = [credentialRow(), credentialRow()];
  const { bindings } = proofBindings({
    storedProof: { source_rows: 2, source_manifest_sha256: "a".repeat(64), target_rows: 2, target_manifest_sha256: "a".repeat(64), verified_at: "2026-08-28T02:00:00.000Z" },
    rows,
  });
  const evidence = await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings);
  assert.equal(evidence.status, "mismatch");
  assert.equal(evidence.importedRows, 2);
});

test("nativePasswordMigrationEvidence is 'verified' only when every row count and both digests match exactly", async () => {
  const row = credentialRow();
  const manifest = await passwordProof.passwordProofManifest([{ userId: row.user_id, sourceUpdatedAt: row.source_updated_at, verifier: row.verifier }]);
  const goodProof = { source_rows: 1, source_manifest_sha256: manifest, target_rows: 1, target_manifest_sha256: manifest, verified_at: "2026-08-28T02:00:00.000Z" };

  {
    const { bindings } = proofBindings({ storedProof: goodProof, rows: [row] });
    assert.equal((await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings)).status, "verified");
  }
  // Off by one on source_rows alone must fail.
  {
    const { bindings } = proofBindings({ storedProof: { ...goodProof, source_rows: 2 }, rows: [row] });
    assert.equal((await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings)).status, "mismatch");
  }
  // Off by one on target_rows alone must fail.
  {
    const { bindings } = proofBindings({ storedProof: { ...goodProof, target_rows: 2 }, rows: [row] });
    assert.equal((await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings)).status, "mismatch");
  }
  // A source digest one bit off (still 64 hex chars) must fail.
  {
    const otherDigest = `${manifest.slice(0, 63)}${manifest.at(-1) === "0" ? "1" : "0"}`;
    const { bindings } = proofBindings({ storedProof: { ...goodProof, source_manifest_sha256: otherDigest }, rows: [row] });
    assert.equal((await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings)).status, "mismatch");
  }
  // A target digest one bit off must fail.
  {
    const otherDigest = `${manifest.slice(0, 63)}${manifest.at(-1) === "0" ? "1" : "0"}`;
    const { bindings } = proofBindings({ storedProof: { ...goodProof, target_manifest_sha256: otherDigest }, rows: [row] });
    assert.equal((await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings)).status, "mismatch");
  }
});

test("importedRows pages by exactly PAGE_SIZE and gives up exactly at the 50,000-row D1 safety cap", async () => {
  const offsetsSeen = [];
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        if (sql.includes("sqlite_master")) return { first: async () => ({ name: "native_password_migration_proofs" }) };
        if (sql.includes("FROM native_password_migration_proofs")) return { first: async () => null };
        if (sql.includes("FROM app_password_credentials")) {
          return {
            bind(pageSize, offset) {
              offsetsSeen.push(offset);
              // Every offset from 0 to 50,000 inclusive looks like a full
              // (never-short) page, so only the loop's own offset bound can
              // end it — a hard stop at 300 calls guards against any
              // surprise even if that reasoning were somehow wrong.
              const full = offset >= 0 && offset <= 50_000 && offsetsSeen.length <= 300;
              const rows = full
                ? Array.from({ length: pageSize }, (_, i) => credentialRow({ user_id: `u-${offset}-${i}` }))
                : [];
              return { async all() { return { success: true, results: rows, meta: {} }; } };
            },
          };
        }
        throw new Error(`unexpected D1 statement: ${sql}`);
      },
    },
  };
  const evidence = await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings);
  // Every page looked full, so importedRows gives up and returns null.
  assert.equal(evidence.importedRows, null);
  // Exactly 251 calls (offsets 0, 200, ..., 49800, 50000): a mutant that
  // changes `<=` to `<` stops one call early; one that flips `+=` to `-=`
  // falls out of the fake's "full" range after the very next call.
  assert.equal(offsetsSeen.length, 251);
  assert.equal(offsetsSeen.at(-1), 50_000);
});

test("importedRows gives up immediately on a page longer than it asked for, rather than trusting it", async () => {
  let calls = 0;
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        if (sql.includes("sqlite_master")) return { first: async () => ({ name: "native_password_migration_proofs" }) };
        if (sql.includes("FROM native_password_migration_proofs")) return { first: async () => null };
        if (sql.includes("FROM app_password_credentials")) {
          return {
            bind: () => ({
              async all() {
                calls += 1;
                // 201 rows for a 200-row LIMIT can never happen from real D1,
                // but the guard exists precisely so a misbehaving backend
                // can't silently certify more than it proved.
                return { success: true, results: new Array(201).fill(credentialRow()), meta: {} };
              },
            }),
          };
        }
        throw new Error(`unexpected D1 statement: ${sql}`);
      },
    },
  };
  const evidence = await passwordMigrationAudit.nativePasswordMigrationEvidence(bindings);
  assert.equal(evidence.importedRows, null);
  // One call, not ~251: a mutant that disables this guard would otherwise
  // keep paging (each "page" still looking oversized) all the way to the
  // same offset cap tested above, reaching the same null by a different and
  // much longer route.
  assert.equal(calls, 1);
});

test("certifyNativePasswordMigration validates its own two public inputs before ever touching D1", async () => {
  const bindings = { db: {}, files: {} };
  const cases = [
    [-1, "a".repeat(64), "negative row count"],
    [1.5, "a".repeat(64), "non-integer row count"],
    [50_001, "a".repeat(64), "one over MAX_LEGACY_ROWS"],
    [0, "a".repeat(64), "zero rows is a valid count", true],
    [50_000, "a".repeat(64), "exactly MAX_LEGACY_ROWS", true],
    [1, "not-64-hex", "malformed manifest"],
    [1, "A".repeat(64), "uppercase hex is not accepted"],
  ];
  for (const [rows, manifest, why, expectPastGate] of cases) {
    if (expectPastGate) {
      // These pass the input gate, so they go on to touch D1 — and this
      // fixture's db has no real prepare(), which certifyNativePasswordMigration's
      // own try/catch turns into a clean "unavailable" rather than a throw.
      assert.deepEqual(
        await passwordMigrationAudit.certifyNativePasswordMigration(rows, manifest, bindings),
        { status: "unavailable", sourceRows: rows, importedRows: null, verifiedAt: null },
        why,
      );
      continue;
    }
    assert.deepEqual(
      await passwordMigrationAudit.certifyNativePasswordMigration(rows, manifest, bindings),
      { status: "mismatch", sourceRows: null, importedRows: null, verifiedAt: null },
      why,
    );
  }
});

test("certifyNativePasswordMigration writes a certificate only when the live D1 set exactly matches the claim — real D1", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("certify", 1));
  context.database.prepare(`
    INSERT INTO app_password_credentials (user_id, scheme, verifier, source_updated_at, imported_at, updated_at, migration_source)
    VALUES (?, 'bcrypt', ?, ?, ?, ?, 'supabase_import')
  `).run(owner, VALID_BCRYPT, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");

  const realManifest = await passwordProof.passwordProofManifest([{ userId: owner, sourceUpdatedAt: "2026-08-28T00:00:00.000Z", verifier: VALID_BCRYPT }]);

  const wrongCount = await passwordMigrationAudit.certifyNativePasswordMigration(2, realManifest, context.bindings, Date.UTC(2026, 7, 28, 3));
  assert.equal(wrongCount.status, "mismatch");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM native_password_migration_proofs").get().n, 0);

  const wrongManifest = await passwordMigrationAudit.certifyNativePasswordMigration(1, "f".repeat(64), context.bindings, Date.UTC(2026, 7, 28, 3));
  assert.equal(wrongManifest.status, "mismatch");

  const now = Date.UTC(2026, 7, 28, 3);
  const good = await passwordMigrationAudit.certifyNativePasswordMigration(1, realManifest, context.bindings, now);
  assert.deepEqual(good, { status: "verified", sourceRows: 1, importedRows: 1, verifiedAt: new Date(now).toISOString() });
  const stored = context.database.prepare("SELECT source_rows, target_rows, source_manifest_sha256, target_manifest_sha256 FROM native_password_migration_proofs").get();
  assert.deepEqual({ ...stored }, { source_rows: 1, target_rows: 1, source_manifest_sha256: realManifest, target_manifest_sha256: realManifest });

  // A repeat certification with the same true state is idempotent (an
  // ON CONFLICT upsert), not a second row or a failure.
  const again = await passwordMigrationAudit.certifyNativePasswordMigration(1, realManifest, context.bindings, now + 1000);
  assert.equal(again.status, "verified");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM native_password_migration_proofs").get().n, 1);
});

test("certifyNativePasswordMigration refuses to certify a write that didn't affect exactly one row", async () => {
  // A real D1 upsert on the singleton primary key always reports
  // success:true, changes:1 — this exact mismatch (success without the
  // expected single row change) can only be modelled with a wrapped D1.
  const context = fixture();
  const owner = insertUser(context.database, uid("certify-guard", 1));
  context.database.prepare(`
    INSERT INTO app_password_credentials (user_id, scheme, verifier, source_updated_at, imported_at, updated_at, migration_source)
    VALUES (?, 'bcrypt', ?, ?, ?, ?, 'supabase_import')
  `).run(owner, VALID_BCRYPT, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
  const realManifest = await passwordProof.passwordProofManifest([{ userId: owner, sourceUpdatedAt: "2026-08-28T00:00:00.000Z", verifier: VALID_BCRYPT }]);

  const realDb = context.bindings.db;
  const zeroChangeDb = {
    ...realDb,
    prepare(sql) {
      if (!sql.includes("INSERT INTO native_password_migration_proofs")) return realDb.prepare(sql);
      return { bind: () => ({ async run() { return { success: true, meta: { changes: 0 } }; } }) };
    },
  };
  const outcome = await passwordMigrationAudit.certifyNativePasswordMigration(1, realManifest, { ...context.bindings, db: zeroChangeDb }, Date.UTC(2026, 7, 28, 3));
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.verifiedAt, null);
});

test("certifyNativePasswordMigration reads 'missing' from a genuinely absent proof table — real D1", async () => {
  const context = fixture();
  context.database.exec("DROP TABLE native_password_migration_proofs");
  const result = await passwordMigrationAudit.certifyNativePasswordMigration(0, "a".repeat(64), context.bindings);
  assert.deepEqual(result, { status: "missing", sourceRows: 0, importedRows: null, verifiedAt: null });
});

/* ==========================================================================
   native-identity.ts — session issuance and Google/Apple identity resolution
   ========================================================================== */

const SIGNING_SECRET = "a dedicated test session signing secret";

/**
 * Wraps `bindings.db.prepare` so that the FIRST call whose SQL contains
 * `sqlFragment` and finds nothing (a `.first()` miss) triggers `onFirstMiss`
 * as a side effect before returning that (still-empty) result to the caller.
 *
 * This is how a genuine "someone else's concurrent first sign-in already
 * landed" race is simulated against a real, single-threaded D1 fixture: the
 * competing row is inserted for real, between this request's own initial
 * existence check and its INSERT, so the INSERT hits a real UNIQUE
 * constraint and the code's own catch/re-check path runs for real.
 */
function withInterceptedLookup(bindings, sqlFragment, onFirstMiss) {
  const realDb = bindings.db;
  let calls = 0;
  return {
    ...bindings,
    db: {
      ...realDb,
      prepare(sql) {
        const real = realDb.prepare(sql);
        if (!sql.includes(sqlFragment)) return real;
        return {
          bind(...values) {
            const boundReal = real.bind(...values);
            return {
              ...boundReal,
              async first(column) {
                calls += 1;
                const result = await boundReal.first(column);
                if (calls === 1 && !result) onFirstMiss();
                return result;
              },
            };
          },
        };
      },
    },
  };
}

test("createNativeBrowserSessionForUser computes exactly a 30-day refresh expiry", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("expiry", 1));
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "expiry1@example.test", createdAt: "2026-08-28T00:00:00.000Z" },
    SIGNING_SECRET,
    context.bindings,
    now,
  );
  const row = context.database.prepare("SELECT expires_at FROM app_auth_sessions WHERE user_id = ?").get(owner);
  const expected = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(row.expires_at, expected);
});

test("createNativeBrowserSessionForUser surfaces a failed session insert instead of minting a token for it", async () => {
  const bindings = {
    files: {},
    db: {
      prepare() { return { bind: () => ({ async run() { return { success: false, meta: { changes: 0 } }; } }) }; },
    },
  };
  await assert.rejects(
    identity.createNativeBrowserSessionForUser({ id: uid("fail", 1), email: null, createdAt: null }, SIGNING_SECRET, bindings),
    /native session could not be stored/,
  );
});

test("bridgeLegacyBrowserSession only bridges an existing, live D1 user and never trusts the legacy email", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("bridge", 1), { email: "d1-email@example.test" });
  const bridged = await identity.bridgeLegacyBrowserSession(
    { id: owner, email: "legacy-email-ignored@example.test", createdAt: "2026-08-01T00:00:00.000Z" },
    SIGNING_SECRET,
    context.bindings,
  );
  assert.ok(bridged?.accessToken);
  assert.equal(bridged.email, "d1-email@example.test", "the D1 row's email must win, never the compatibility provider's");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_auth_sessions WHERE user_id = ?").get(owner).n, 1);

  assert.equal(
    await identity.bridgeLegacyBrowserSession({ id: uid("nobody", 1), email: null, createdAt: null }, SIGNING_SECRET, context.bindings),
    null,
  );

  context.database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?").run("2026-08-30T00:00:00.000000000Z", owner);
  assert.equal(
    await identity.bridgeLegacyBrowserSession({ id: owner, email: "d1-email@example.test", createdAt: null }, SIGNING_SECRET, context.bindings),
    null,
  );
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_auth_sessions WHERE user_id = ?").get(owner).n, 1, "no second session for a deleted account");
});

test("resolveGoogleIdentity creates exactly one linked account for a brand-new subject", async () => {
  const context = fixture();
  const googleIdentity = { subject: "google-subject-new-1", email: "New.Learner@Example.TEST", emailVerified: true };
  const resolved = await identity.resolveGoogleIdentity(googleIdentity, context.bindings);
  assert.ok(resolved?.id);
  const user = context.database.prepare("SELECT email, identity_authority FROM app_users WHERE id = ?").get(resolved.id);
  assert.equal(user.identity_authority, "cloudflare");
  const link = context.database.prepare("SELECT provider, provider_subject, email, email_verified FROM app_user_identities WHERE user_id = ?").get(resolved.id);
  assert.deepEqual({ ...link }, { provider: "google", provider_subject: googleIdentity.subject, email: googleIdentity.email, email_verified: 1 });
});

test("resolveGoogleIdentity re-syncs email and identity_authority for an already-linked user", async () => {
  const context = fixture();
  const googleIdentity = { subject: "google-subject-existing-1", email: "first@example.test", emailVerified: true };
  const first = await identity.resolveGoogleIdentity(googleIdentity, context.bindings);
  const second = await identity.resolveGoogleIdentity({ ...googleIdentity, email: "second@example.test" }, context.bindings);
  assert.equal(second.id, first.id, "the same subject must resolve to the same account every time");
  assert.equal(second.email, "second@example.test");
  const user = context.database.prepare("SELECT email FROM app_users WHERE id = ?").get(first.id);
  assert.equal(user.email, "second@example.test");
  const link = context.database.prepare("SELECT email FROM app_user_identities WHERE user_id = ?").get(first.id);
  assert.equal(link.email, "second@example.test");
});

test("resolveGoogleIdentity surfaces a failed app_users re-sync update instead of certifying it", async () => {
  // Real D1's UPDATE always reports success:true (or throws); only a fake
  // can model the defensive success:false branch on this specific write.
  const row = { id: "11111111-1111-4111-8111-111111111111", email: "existing@example.test", created_at: "2026-08-28T00:00:00.000Z", deleted_at: null };
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        return {
          bind: (...values) => ({
            sql,
            values,
            async first() { return sql.includes("i.provider = 'google'") ? row : null; },
            async run() { return { success: false, meta: { changes: 0 } }; },
          }),
        };
      },
    },
  };
  await assert.rejects(
    identity.resolveGoogleIdentity({ subject: "google-subject-resync-fail", email: "new@example.test", emailVerified: true }, bindings),
    /native identity could not be updated/,
  );
});

test("resolveGoogleIdentity links to the account a concurrent first sign-in just won, rather than creating a duplicate", async () => {
  const context = fixture();
  const googleIdentity = { subject: "google-race-subject-1", email: "race@example.test", emailVerified: true };
  let winnerId = null;
  const raced = withInterceptedLookup(context.bindings, "i.provider = 'google' AND i.provider_subject = ?", () => {
    winnerId = uid("race-winner", 1);
    insertUser(context.database, winnerId, { email: "winner@example.test" });
    context.database.prepare(`
      INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
      VALUES ('google', ?, ?, 'winner@example.test', 1, ?, ?)
    `).run(googleIdentity.subject, winnerId, "2026-08-29T00:00:00.000000000Z", "2026-08-29T00:00:00.000000000Z");
  });
  const resolved = await identity.resolveGoogleIdentity(googleIdentity, raced);
  assert.equal(resolved?.id, winnerId, "the race's actual winner must be returned, not a second new account");
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_users").get().n, 1, "no duplicate account was created");
});

test("resolveGoogleIdentity refuses to attach a new Google identity to an email already owned by a live account", async () => {
  const context = fixture();
  insertUser(context.database, uid("owner", 1), { email: "shared@example.test" });
  const result = await identity.resolveGoogleIdentity({ subject: "google-subject-conflict-1", email: "shared@example.test", emailVerified: true }, context.bindings);
  assert.equal(result, null);
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_user_identities").get().n, 0);
});

test("resolveGoogleIdentity returns null for a linked but deleted account, without writing to it", async () => {
  const context = fixture();
  const googleIdentity = { subject: "google-subject-deleted-1", email: "deleted@example.test", emailVerified: true };
  const first = await identity.resolveGoogleIdentity(googleIdentity, context.bindings);
  context.database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?").run("2026-08-30T00:00:00.000000000Z", first.id);
  const second = await identity.resolveGoogleIdentity(googleIdentity, context.bindings);
  assert.equal(second, null);
  assert.equal(
    context.database.prepare("SELECT email FROM app_users WHERE id = ?").get(first.id).email,
    googleIdentity.email,
    "a deleted account must not be silently re-synced",
  );
});

test("resolveGoogleIdentity surfaces a failed creation batch rather than certifying a half-made account", async () => {
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        return { bind: (...values) => ({ sql, values, async first() { return null; }, async run() { return { success: true, meta: { changes: 1 } }; } }) };
      },
      // Mixed on purpose: one statement "succeeding" and the other not is
      // what actually distinguishes "any write failed" from "every write
      // failed" — a batch where all statements fail is caught identically
      // either way.
      async batch(statements) { return statements.map((_, index) => ({ success: index !== 1, meta: { changes: index !== 1 ? 1 : 0 } })); },
    },
  };
  await assert.rejects(
    identity.resolveGoogleIdentity({ subject: "google-subject-batchfail-1", email: "x@example.test", emailVerified: true }, bindings),
    /native user could not be created/,
  );
});

test("createGoogleNativeSession issues a session only when the identity actually resolves", async () => {
  const context = fixture();
  insertUser(context.database, uid("conflict", 1), { email: "taken@example.test" });
  const blocked = await identity.createGoogleNativeSession(
    { subject: "google-subject-session-blocked", email: "taken@example.test", emailVerified: true },
    SIGNING_SECRET,
    context.bindings,
  );
  assert.equal(blocked, null);

  const session = await identity.createGoogleNativeSession(
    { subject: "google-subject-session-ok", email: "fresh@example.test", emailVerified: true },
    SIGNING_SECRET,
    context.bindings,
  );
  assert.ok(session?.accessToken);
  assert.ok(session?.refreshToken);
});

test("resolveAppleIdentity creates an account and captures the display name only on that same creating call", async () => {
  const context = fixture();
  const appleIdentity = { subject: "apple-subject-new-1", email: "apple-new@example.test", emailVerified: true };
  const resolved = await identity.resolveAppleIdentity(appleIdentity, "First Last", context.bindings);
  assert.ok(resolved?.id);
  assert.equal(
    context.database.prepare("SELECT display_name FROM learner_profiles WHERE user_id = ?").get(resolved.id)?.display_name,
    "First Last",
  );

  // A later sign-in for the SAME (now-existing) subject is not a creation —
  // a name arriving on it must not be written at all, whether or not a
  // profile row happens to already exist.
  const again = await identity.resolveAppleIdentity({ ...appleIdentity, email: "apple-updated@example.test" }, "Somebody Else", context.bindings);
  assert.equal(again.id, resolved.id);
  assert.equal(
    context.database.prepare("SELECT display_name FROM learner_profiles WHERE user_id = ?").get(resolved.id)?.display_name,
    "First Last",
    "the name from the creating call must not be replaced on a later sign-in",
  );
});

test("resolveAppleIdentity never attempts a display name write for a non-creating call, even with no profile row yet", async () => {
  const context = fixture();
  // First sign-in carries no name at all (Apple's normal case for a name
  // that was never collected) — created=true but displayName=null, so no
  // profile row is made either way.
  const first = await identity.resolveAppleIdentity({ subject: "apple-subject-noname-1", email: "noname@example.test", emailVerified: true }, null, context.bindings);
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM learner_profiles WHERE user_id = ?").get(first.id).n, 0);

  // A later call for the same, already-existing subject supplies a name —
  // created is false here, so this must still write nothing.
  await identity.resolveAppleIdentity({ subject: "apple-subject-noname-1", email: "noname@example.test", emailVerified: true }, "Late Name", context.bindings);
  assert.equal(
    context.database.prepare("SELECT count(*) AS n FROM learner_profiles WHERE user_id = ?").get(first.id).n,
    0,
    "created must be false on a repeat sign-in, so a forced-true created flag is the only way this could write",
  );
});

test("resolveAppleIdentity tolerates a changed email on re-authorization and keeps the verified flag monotonic", async () => {
  const context = fixture();
  const subject = "apple-subject-monotonic-1";
  const first = await identity.resolveAppleIdentity({ subject, email: "first@example.test", emailVerified: true }, null, context.bindings);

  // Re-authorization with a different (still live, unclaimed) email must be
  // tolerated and actually applied — this is the "coalesce" path, not a
  // no-op — and the verified flag must never fall back to unverified.
  const second = await identity.resolveAppleIdentity({ subject, email: "second@example.test", emailVerified: false }, null, context.bindings);
  assert.equal(second.id, first.id);
  assert.equal(second.email, "second@example.test");
  assert.equal(context.database.prepare("SELECT email FROM app_users WHERE id = ?").get(first.id).email, "second@example.test");
  const link = context.database.prepare("SELECT email, email_verified FROM app_user_identities WHERE user_id = ?").get(first.id);
  assert.equal(link.email, "second@example.test");
  assert.equal(link.email_verified, 1, "email_verified must stay 1 once set, even when this sign-in's token omits it");

  // A sign-in that omits the email claim entirely still marks the account
  // Cloudflare-authoritative, and does not blank the stored address.
  const third = await identity.resolveAppleIdentity({ subject, email: null, emailVerified: false }, null, context.bindings);
  assert.equal(third.email, "second@example.test");
  assert.equal(context.database.prepare("SELECT identity_authority FROM app_users WHERE id = ?").get(first.id).identity_authority, "cloudflare");
});

test("resolveAppleIdentity refuses to attach a new subject to an email already owned by a live account", async () => {
  const context = fixture();
  insertUser(context.database, uid("apple-owner", 1), { email: "apple-shared@example.test" });
  const result = await identity.resolveAppleIdentity({ subject: "apple-subject-conflict-1", email: "apple-shared@example.test", emailVerified: true }, null, context.bindings);
  assert.equal(result, null);
});

test("resolveAppleIdentity surfaces a failed creation batch rather than certifying a half-made account", async () => {
  const bindings = {
    files: {},
    db: {
      prepare(sql) {
        return { bind: (...values) => ({ sql, values, async first() { return null; }, async run() { return { success: true, meta: { changes: 1 } }; } }) };
      },
      // Mixed, for the same reason as the Google test: all-failed or
      // all-succeeded batches don't distinguish `.some(...)` from `.every(...)`.
      async batch(statements) { return statements.map((_, index) => ({ success: index !== 1, meta: { changes: index !== 1 ? 1 : 0 } })); },
    },
  };
  await assert.rejects(
    identity.resolveAppleIdentity({ subject: "apple-subject-batchfail-1", email: "apple-x@example.test", emailVerified: true }, null, bindings),
    /native user could not be created/,
  );
});

test("resolveAppleIdentity links to a concurrent winner and re-throws an unrelated failure when there is no email to check", async () => {
  const context = fixture();
  const appleIdentity = { subject: "apple-race-subject-1", email: "apple-race@example.test", emailVerified: true };
  let winnerId = null;
  const raced = withInterceptedLookup(context.bindings, "i.provider = 'apple' AND i.provider_subject = ?", () => {
    winnerId = uid("apple-race-winner", 1);
    insertUser(context.database, winnerId, { email: "apple-winner@example.test" });
    context.database.prepare(`
      INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
      VALUES ('apple', ?, ?, 'apple-winner@example.test', 1, ?, ?)
    `).run(appleIdentity.subject, winnerId, "2026-08-29T00:00:00.000000000Z", "2026-08-29T00:00:00.000000000Z");
  });
  const resolved = await identity.resolveAppleIdentity(appleIdentity, null, raced);
  assert.equal(resolved?.id, winnerId);
  assert.equal(context.database.prepare("SELECT count(*) AS n FROM app_users").get().n, 1);

  // A failure unrelated to any real conflict, with no email on the identity
  // at all, must re-throw as-is rather than attempt an email lookup.
  const unrelated = {
    files: {},
    db: {
      prepare(sql) {
        if (sql.includes("i.provider = 'apple'")) return { bind: () => ({ async first() { return null; } }) };
        return { bind: () => ({ async first() { throw new Error("unexpected email lookup attempted"); } }) };
      },
      async batch() { throw new Error("simulated-unrelated-failure"); },
    },
  };
  await assert.rejects(
    identity.resolveAppleIdentity({ subject: "apple-subject-unrelated-1", email: null, emailVerified: false }, null, unrelated),
    /simulated-unrelated-failure/,
  );
});

test("createAppleNativeSession issues a session only when the identity actually resolves", async () => {
  const context = fixture();
  insertUser(context.database, uid("apple-conflict", 1), { email: "apple-taken@example.test" });
  const blocked = await identity.createAppleNativeSession(
    { subject: "apple-subject-session-blocked", email: "apple-taken@example.test", emailVerified: true },
    null,
    SIGNING_SECRET,
    context.bindings,
  );
  assert.equal(blocked, null);
  const session = await identity.createAppleNativeSession(
    { subject: "apple-subject-session-ok", email: "apple-fresh@example.test", emailVerified: true },
    null,
    SIGNING_SECRET,
    context.bindings,
  );
  assert.ok(session?.accessToken);
});

test("userFromNativeBrowserSessionToken checks the signature, the exact session id, expiry and revocation together", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("session-user", 1), { email: "session1@example.test" });
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const session = await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "session1@example.test", createdAt: null }, SIGNING_SECRET, context.bindings, now,
  );

  const valid = await identity.userFromNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, context.bindings, now + 1000);
  // createdAt here is read fresh from the app_users row (via insertUser's
  // default), not from the value passed into createNativeBrowserSessionForUser.
  assert.deepEqual(valid, { id: owner, email: "session1@example.test", createdAt: "2026-08-29T00:00:00.000000000Z" });

  assert.equal(await identity.userFromNativeBrowserSessionToken(session.accessToken, "wrong secret", context.bindings, now + 1000), null);
  assert.equal(await identity.userFromNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, context.bindings, session.expiresAt), null, "expired access token");

  context.database.prepare("UPDATE app_auth_sessions SET revoked_at = ? WHERE user_id = ?").run("2026-08-29T01:00:00.000000000Z", owner);
  assert.equal(await identity.userFromNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, context.bindings, now + 1000), null, "a revoked session must not authenticate");
});

test("userFromNativeBrowserSessionToken refuses a deleted account even with a live, unrevoked session row", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("session-dead", 1), { email: "session-dead1@example.test" });
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const session = await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "session-dead1@example.test", createdAt: null }, SIGNING_SECRET, context.bindings, now,
  );
  context.database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?").run("2026-08-29T01:00:00.000000000Z", owner);
  assert.equal(await identity.userFromNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, context.bindings, now + 1000), null);
});

test("revokeNativeBrowserSessionToken actually revokes the exact named session, and a bad token is a harmless no-op", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("revoke", 1), { email: "revoke1@example.test" });
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const session = await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "revoke1@example.test", createdAt: null }, SIGNING_SECRET, context.bindings, now,
  );
  assert.equal(context.database.prepare("SELECT revoked_at FROM app_auth_sessions WHERE user_id = ?").get(owner).revoked_at, null);
  await identity.revokeNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, context.bindings, now + 5000);
  const revoked = context.database.prepare("SELECT revoked_at FROM app_auth_sessions WHERE user_id = ?").get(owner).revoked_at;
  assert.notEqual(revoked, null);

  // A second sign-out for the same (now-invalid) token must not throw and
  // must not move the already-recorded revocation timestamp.
  await identity.revokeNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, context.bindings, now + 9000);
  assert.equal(context.database.prepare("SELECT revoked_at FROM app_auth_sessions WHERE user_id = ?").get(owner).revoked_at, revoked);

  await identity.revokeNativeBrowserSessionToken("not-a-real-token", SIGNING_SECRET, context.bindings, now);
});

test("refreshNativeBrowserSession rotates the refresh token exactly at its length boundary and rejects a stale/foreign one", async () => {
  const context = fixture();
  const owner = insertUser(context.database, uid("refresh", 1), { email: "refresh1@example.test" });
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const session = await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "refresh1@example.test", createdAt: null }, SIGNING_SECRET, context.bindings, now,
  );

  assert.equal(await identity.refreshNativeBrowserSession("", SIGNING_SECRET, context.bindings, now), null, "empty token");
  assert.equal(await identity.refreshNativeBrowserSession("r".repeat(513), SIGNING_SECRET, context.bindings, now), null, "one over 512");
  assert.equal(await identity.refreshNativeBrowserSession("not-the-real-token", SIGNING_SECRET, context.bindings, now), null, "unknown token");

  const rotated = await identity.refreshNativeBrowserSession(session.refreshToken, SIGNING_SECRET, context.bindings, now + 1000);
  assert.ok(rotated?.accessToken);
  assert.notEqual(rotated.refreshToken, session.refreshToken);

  // The old, now-superseded refresh token must be a dead end (single use).
  assert.equal(await identity.refreshNativeBrowserSession(session.refreshToken, SIGNING_SECRET, context.bindings, now + 2000), null);

  // The account being soft-deleted must block a refresh even with an
  // otherwise perfectly live, unexpired, unrevoked session row.
  context.database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?").run("2026-08-29T01:00:00.000000000Z", owner);
  assert.equal(await identity.refreshNativeBrowserSession(rotated.refreshToken, SIGNING_SECRET, context.bindings, now + 3000), null);
});

test("refreshNativeBrowserSession accepts a refresh token at exactly the 512-character ceiling", async () => {
  // 512 is a length boundary check only — a real 512-char token will simply
  // not be found in D1, but it must reach that lookup rather than being
  // rejected by the length guard itself.
  const context = fixture();
  const before = await identity.refreshNativeBrowserSession("r".repeat(512), SIGNING_SECRET, context.bindings, Date.UTC(2026, 7, 28));
  assert.equal(before, null, "not found, but for lack of a match — not for its length");
});

test("refreshNativeBrowserSession detects a concurrent double-use of the same refresh token", async () => {
  // A racing db whose UPDATE always reports zero matched rows simulates a
  // second, concurrent refresh already having rotated the token away.
  const context = fixture();
  const owner = insertUser(context.database, uid("refresh-race", 1), { email: "refresh-race1@example.test" });
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const session = await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "refresh-race1@example.test", createdAt: null }, SIGNING_SECRET, context.bindings, now,
  );
  const realDb = context.bindings.db;
  const racing = {
    ...context.bindings,
    db: {
      ...realDb,
      prepare(sql) {
        if (!sql.includes("SET refresh_token_sha256 = ?")) return realDb.prepare(sql);
        return { bind: () => ({ async run() { return { success: true, meta: { changes: 0 } }; } }) };
      },
    },
  };
  assert.equal(await identity.refreshNativeBrowserSession(session.refreshToken, SIGNING_SECRET, racing, now + 1000), null);
});

test("refreshNativeBrowserSession's over-512 length guard trips before any database access", async () => {
  const spy = { db: { prepare() { throw new Error("must not reach the database for an over-length token"); } } };
  assert.equal(await identity.refreshNativeBrowserSession("r".repeat(513), SIGNING_SECRET, spy, Date.now()), null);
});

test("refreshNativeBrowserSession lets a refresh token of exactly 512 characters reach the database", async () => {
  // The length guard must pass a 512-char token through to the lookup rather
  // than reject it — what happens after (not found) is a different test.
  const spy = { db: { prepare() { throw new Error("reached the database, as the length guard should allow at exactly 512"); } } };
  await assert.rejects(
    () => identity.refreshNativeBrowserSession("r".repeat(512), SIGNING_SECRET, spy, Date.now()),
    /reached the database, as the length guard should allow at exactly 512/,
  );
});

test("resolveAppleIdentity keeps the account's original email in its own return value when the tolerated-conflict update itself fails", async () => {
  const context = fixture();
  const subject = "apple-subject-updatefail-1";
  const first = await identity.resolveAppleIdentity({ subject, email: "original@example.test", emailVerified: true }, null, context.bindings);
  const realDb = context.bindings.db;
  const failing = {
    ...context.bindings,
    db: {
      ...realDb,
      prepare(sql) {
        if (sql.includes("identity_authority = 'cloudflare', updated_at") && sql.includes("SET email = ?")) {
          return { bind: () => ({ async run() { return { success: false, meta: { changes: 0 } }; } }) };
        }
        return realDb.prepare(sql);
      },
    },
  };
  const second = await identity.resolveAppleIdentity({ subject, email: "changed@example.test", emailVerified: true }, null, failing);
  assert.equal(second.id, first.id);
  assert.equal(second.email, "original@example.test", "a failed tolerated-conflict update must not be reflected in the returned identity");
  assert.equal(
    context.database.prepare("SELECT email FROM app_users WHERE id = ?").get(first.id).email,
    "original@example.test",
  );
});

test("resolveAppleIdentity throws when the emailless identity-authority update itself fails, rather than silently continuing", async () => {
  const context = fixture();
  const subject = "apple-subject-elseupdatefail-1";
  await identity.resolveAppleIdentity({ subject, email: "seed@example.test", emailVerified: true }, null, context.bindings);
  const realDb = context.bindings.db;
  const failing = {
    ...context.bindings,
    db: {
      ...realDb,
      prepare(sql) {
        if (sql.trim().startsWith("UPDATE app_users") && !sql.includes("SET email = ?")) {
          return { bind: () => ({ async run() { return { success: false, meta: { changes: 0 } }; } }) };
        }
        return realDb.prepare(sql);
      },
    },
  };
  await assert.rejects(
    identity.resolveAppleIdentity({ subject, email: null, emailVerified: false }, null, failing),
    /native identity could not be updated/,
  );
});

test("userFromNativeBrowserSessionToken refuses a row that reports itself deleted, independent of the query's own WHERE clause", async () => {
  // The join's WHERE already filters u.deleted_at IS NULL, so a genuinely
  // dead account never reaches this point through real D1 — the isLiveUser
  // recheck is a second, independent guard against a row that claims
  // liveness incorrectly. A fake row is the only way to exercise it.
  const context = fixture();
  const owner = insertUser(context.database, uid("session-liveguard", 1), { email: "liveguard1@example.test" });
  const now = Date.UTC(2026, 7, 28, 0, 0, 0);
  const session = await identity.createNativeBrowserSessionForUser(
    { id: owner, email: "liveguard1@example.test", createdAt: null }, SIGNING_SECRET, context.bindings, now,
  );
  const realDb = context.bindings.db;
  const spoofed = {
    ...context.bindings,
    db: {
      ...realDb,
      prepare(sql) {
        if (sql.includes("FROM app_auth_sessions")) {
          return {
            bind: () => ({
              async first() {
                return { id: owner, email: "liveguard1@example.test", created_at: "x", deleted_at: "2026-01-01T00:00:00.000000000Z" };
              },
            }),
          };
        }
        return realDb.prepare(sql);
      },
    },
  };
  assert.equal(await identity.userFromNativeBrowserSessionToken(session.accessToken, SIGNING_SECRET, spoofed, now + 1000), null);
});

/* ==========================================================================
   native-identity-audit.ts — the private, aggregate-only migration readiness
   report
   ========================================================================== */

async function withEnv(values, run) {
  const keys = Object.keys(values);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Cloudflare-ready envs, so `configured.dataAuthority.ready` is true and does
 *  not add its own blocker to every test's expectations. */
function withDataAuthorityReady(run) {
  return withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare", ORGANIZATION_DATA_MODE: "cloudflare" }, run);
}

function sourceIdentity(overrides = {}) {
  return {
    authUserId: uid("aud-user", 1),
    identityUserId: uid("aud-user", 1),
    providerSubject: "aud-subject-1",
    email: "learner@example.test",
    emailVerified: true,
    ...overrides,
  };
}

function providerSummary(overrides = {}) {
  return { google: 0, apple: 0, email: 0, unsupported: 0, invalid: 0, ...overrides };
}

function readinessOptions({ source = [], accounts, summary } = {}) {
  return {
    readSource: async () => source,
    readAccounts: accounts !== undefined ? async () => accounts : undefined,
    readProviderSummary: summary !== undefined ? async () => summary : undefined,
  };
}

test("nativeIdentityReadinessReport reads a missing D1 identity schema as 'missing', not 'unavailable'", async () => {
  const context = fixture();
  context.database.exec("DROP TABLE app_user_identities");
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions());
  assert.equal(report.target.schema, "missing");
  assert.ok(report.blockers.includes("D1 identity migration 0015 has not been applied"));
  assert.equal(report.passwords.status, "missing");
  assert.equal(report.readyForBackfill, false);
  assert.equal(report.readyForGoogleCutover, false);
  assert.equal(report.readyForNativeAuthCutover, false);
});

test("nativeIdentityReadinessReport reads 'unavailable' when the schema check itself fails", async () => {
  const bindings = {
    files: {},
    db: { prepare() { throw new Error("D1 unreachable"); } },
  };
  const report = await identityAudit.nativeIdentityReadinessReport(bindings, readinessOptions());
  assert.equal(report.target.schema, "unavailable");
  assert.ok(report.blockers.includes("D1 identity schema could not be checked"));
  assert.equal(report.passwords.status, "unavailable");
  assert.equal(report.readyForBackfill, false);
  assert.equal(report.readyForGoogleCutover, false);
  assert.equal(report.readyForNativeAuthCutover, false);
});

test("nativeIdentityReadinessReport reads 'ready' only once the identity_authority column can actually be read", async () => {
  const context = fixture();
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions());
  assert.equal(report.target.schema, "ready");
});

test("nativeIdentityReadinessReport's chunk() slices 81 rows as 80-then-1, not as a mis-sliced remainder", async () => {
  const context = fixture();
  const source = [];
  for (let i = 0; i < 81; i += 1) {
    const id = uid("chunkaudit", i);
    insertUser(context.database, id);
    source.push(sourceIdentity({ authUserId: id, identityUserId: id, providerSubject: `chunkaudit-subject-${i}` }));
  }
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source }));
  // A `slice(start, start - size)` mutant on the second chunk turns 81 real,
  // live rows into "0 or 1 found live" — both the identity-side D1 lookup
  // (target.sourceUsersMissing) and the account-side one
  // (accounts.liveD1UsersPresent) run through this same chunk() helper.
  assert.equal(report.target.sourceUsersMissing, 0);
  assert.equal(report.target.sourceUsersPresent, 81);
  assert.equal(report.accounts.liveD1UsersPresent, 81);
  assert.equal(report.accounts.liveD1UsersMissing, 0);
  assert.equal(report.mappings.missing, 81, "no mappings exist yet, independent of the chunk bug");
});

test("normaliseSourceIdentity enforces both id-length boundaries and requires the two user ids to actually match", async () => {
  const context = fixture();
  const id = insertUser(context.database, uid("normid", 1));
  const cases = [
    [{ authUserId: "u".repeat(15), identityUserId: "u".repeat(15) }, false, "authUserId one under 16"],
    [{ authUserId: id.padEnd(16, "0").slice(0, 16), identityUserId: id.padEnd(16, "0").slice(0, 16) }, null, "not a live user, but structurally fine"],
    [{ authUserId: "u".repeat(81), identityUserId: "u".repeat(81) }, false, "authUserId one over 80"],
    [{ authUserId: "u".repeat(80), identityUserId: "u".repeat(80) }, null, "authUserId exactly 80 is valid"],
    [{ authUserId: id, identityUserId: "a-different-id-entirely" }, false, "authUserId and identityUserId must match"],
    [{ providerSubject: "" }, false, "subject one under length 1"],
    [{ providerSubject: "s" }, null, "subject exactly length 1 is valid"],
    [{ providerSubject: "s".repeat(256) }, false, "subject one over length 255"],
    [{ providerSubject: "s".repeat(255) }, null, "subject exactly length 255 is valid"],
  ];
  for (const [overrides, expectValidCountsAsSource, why] of cases) {
    const identity = sourceIdentity({ authUserId: id, identityUserId: id, providerSubject: "normid-subject", ...overrides });
    const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source: [identity] }));
    if (expectValidCountsAsSource === false) {
      assert.equal(report.source.invalidIdentities, 1, why);
      assert.equal(report.source.googleIdentities, 1, why);
    } else {
      assert.equal(report.source.invalidIdentities, 0, why);
    }
  }
});

test("normaliseSourceAccount enforces both id-length boundaries", async () => {
  const context = fixture();
  const cases = [
    ["u".repeat(15), true, "one under 16"],
    ["u".repeat(16), false, "exactly 16"],
    ["u".repeat(80), false, "exactly 80"],
    ["u".repeat(81), true, "one over 80"],
  ];
  for (const [accountId, expectInvalid, why] of cases) {
    const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
      source: [], accounts: [{ id: accountId }],
    }));
    assert.equal(report.accounts.invalidUsers, expectInvalid ? 1 : 0, why);
    assert.equal(report.accounts.supabaseAuthUsers, 1, why);
  }
});

test("nativeIdentityReadinessReport returns the exact unavailableReport shape when a supplied source resolver fails", async () => {
  const configuredBefore = await withDataAuthorityReady(async () => {
    const bindings = { db: {}, files: {} };
    const report = await identityAudit.nativeIdentityReadinessReport(bindings, {
      readSource: async () => { throw new Error("simulated Supabase outage"); },
    });
    assert.deepEqual(report, {
      generatedAt: report.generatedAt,
      configured: report.configured,
      source: { status: "unavailable", googleIdentities: 0, appleIdentities: 0, emailIdentities: 0, unsupportedProviderIdentities: 0, invalidProviderIdentities: 0, invalidIdentities: 0, duplicateSubjects: 0, usersWithMultipleGoogleIdentities: 0 },
      accounts: { status: "unavailable", supabaseAuthUsers: 0, invalidUsers: 0, duplicateUserIds: 0, liveD1UsersPresent: 0, liveD1UsersMissing: 0 },
      target: { schema: "unavailable", sourceUsersPresent: 0, sourceUsersMissing: 0 },
      mappings: { correct: 0, missing: 0, mismatched: 0 },
      passwords: { status: "unavailable", sourceRows: null, importedRows: null, verifiedAt: null },
      readyForBackfill: false,
      readyForGoogleCutover: false,
      readyForNativeAuthCutover: false,
      blockers: ["Supabase Auth Google-identity evidence is unavailable"],
    });
    return report.configured;
  });
  assert.equal(configuredBefore.dataAuthority.ready, true);
});

test("nativeIdentityReadinessReport, given only readSource, derives accounts and the provider summary from it", async () => {
  const context = fixture();
  const source = [sourceIdentity({ authUserId: uid("only-src", 1), identityUserId: uid("only-src", 1), providerSubject: "only-src-1" }), sourceIdentity({ authUserId: uid("only-src", 2), identityUserId: uid("only-src", 2), providerSubject: "only-src-2" })];
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, { readSource: async () => source });
  assert.equal(report.accounts.supabaseAuthUsers, 2, "accounts derived 1:1 from the source's authUserId");
  assert.equal(report.source.googleIdentities, 2);
});

test("nativeIdentityReadinessReport prefers an explicitly supplied readAccounts/readProviderSummary over the derived fallback", async () => {
  const context = fixture();
  const source = [sourceIdentity({ authUserId: uid("explicit", 1), identityUserId: uid("explicit", 1), providerSubject: "explicit-1" })];
  const reportWithAccounts = await identityAudit.nativeIdentityReadinessReport(context.bindings, {
    readSource: async () => source,
    readAccounts: async () => [{ id: uid("explicit", 1) }, { id: uid("explicit", 2) }, { id: uid("explicit", 3) }],
  });
  assert.equal(reportWithAccounts.accounts.supabaseAuthUsers, 3, "3 explicit accounts, not the 1 derived from source");

  const reportWithSummary = await identityAudit.nativeIdentityReadinessReport(context.bindings, {
    readSource: async () => source,
    readProviderSummary: async () => providerSummary({ google: 1, apple: 5 }),
  });
  assert.equal(reportWithSummary.source.appleIdentities, 5, "the explicit summary's apple count, not the derived {apple:0}");
});

test("nativeIdentityReadinessReport counts invalid and duplicate source records with the exact blocker text", async () => {
  const context = fixture();
  const id1 = uid("countsrc", 1);
  const id2 = uid("countsrc", 2);
  insertUser(context.database, id1);
  insertUser(context.database, id2);
  const source = [
    sourceIdentity({ authUserId: id1, identityUserId: id1, providerSubject: "shared-subject" }),
    // A second, different user claiming the exact same Google subject.
    sourceIdentity({ authUserId: id2, identityUserId: id2, providerSubject: "shared-subject" }),
    // A structurally malformed record (subject too short).
    sourceIdentity({ authUserId: id1, identityUserId: id1, providerSubject: "" }),
  ];
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source }));
  assert.equal(report.source.invalidIdentities, 1);
  assert.equal(report.source.status, "invalid");
  assert.equal(report.source.duplicateSubjects, 1);
  assert.ok(report.blockers.includes("1 Google identity record(s) are malformed or linked to the wrong Supabase user id"));
  assert.ok(report.blockers.includes("1 duplicate Google provider subject(s) appear in Supabase Auth"));
});

test("nativeIdentityReadinessReport flags a user with more than one Google identity with the exact blocker text", async () => {
  const context = fixture();
  const id = uid("multigoogle", 1);
  insertUser(context.database, id);
  const source = [
    sourceIdentity({ authUserId: id, identityUserId: id, providerSubject: "multigoogle-a" }),
    sourceIdentity({ authUserId: id, identityUserId: id, providerSubject: "multigoogle-b" }),
  ];
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source }));
  assert.equal(report.source.usersWithMultipleGoogleIdentities, 1);
  assert.ok(report.blockers.includes("1 user(s) have more than one Google identity"));
});

test("nativeIdentityReadinessReport counts invalid and duplicate Supabase Auth accounts with the exact blocker text", async () => {
  const context = fixture();
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: [],
    accounts: [{ id: uid("dupacct", 1) }, { id: uid("dupacct", 1) }, { id: "too-short" }],
  }));
  assert.equal(report.accounts.duplicateUserIds, 1);
  assert.equal(report.accounts.invalidUsers, 1);
  assert.equal(report.accounts.status, "invalid");
  assert.ok(report.blockers.includes("1 Supabase Auth account record(s) have an invalid stable id"));
  assert.ok(report.blockers.includes("1 duplicate Supabase Auth user id(s) were returned by the source"));
});

test("nativeIdentityReadinessReport surfaces every legacy-provider-summary blocker with its exact text and boundary", async () => {
  const context = fixture();
  const cases = [
    [providerSummary({ apple: 1 }), "1 Apple identity record(s) still need a subject-audited backfill into D1 (migration 0022 provides the destination; the mapping itself does not exist yet)"],
    [providerSummary({ unsupported: 2 }), "2 legacy identity provider record(s) use an unsupported provider"],
    [providerSummary({ invalid: 3 }), "3 legacy identity provider record(s) are invalid"],
  ];
  for (const [summary, message] of cases) {
    const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source: [], summary }));
    assert.ok(report.blockers.includes(message), message);
  }
  // Zero of each must add none of these blockers.
  const clean = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source: [], summary: providerSummary() }));
  assert.equal(clean.blockers.some((b) => /Apple identity record|unsupported provider|are invalid/.test(b)), false);
});

test("nativeIdentityReadinessReport skips the password-migration audit entirely when there are zero legacy email accounts", async () => {
  const context = fixture();
  const throwsIfQueried = {
    ...context.bindings,
    db: {
      ...context.bindings.db,
      prepare(sql) {
        if (sql.includes("native_password_migration_proofs") || sql.includes("app_password_credentials")) {
          throw new Error("password migration audit must not run when providerSummary.email === 0");
        }
        return context.bindings.db.prepare(sql);
      },
    },
  };
  const report = await identityAudit.nativeIdentityReadinessReport(throwsIfQueried, readinessOptions({ source: [], summary: providerSummary({ email: 0 }) }));
  assert.deepEqual(report.passwords, { status: "verified", sourceRows: 0, importedRows: 0, verifiedAt: null });

  // With even one legacy email account, the audit must actually run — this
  // fake makes that show up as a clean "unavailable" (nativePasswordMigrationEvidence
  // catches its own errors), which still proves the query was attempted at
  // all, unlike the hardcoded "verified" shortcut above.
  const ranAudit = await identityAudit.nativeIdentityReadinessReport(throwsIfQueried, readinessOptions({ source: [], summary: providerSummary({ email: 1 }) }));
  assert.equal(ranAudit.passwords.status, "unavailable");
});

test("nativeIdentityReadinessReport blocks native cutover on an unverified legacy password migration", async () => {
  const context = fixture();
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source: [], summary: providerSummary({ email: 3 }) }));
  assert.notEqual(report.passwords.status, "verified");
  assert.ok(report.blockers.includes("Legacy email/password credentials do not yet have an exact source-to-D1 migration certificate"));
  assert.equal(report.readyForNativeAuthCutover, false);
});

test("nativeIdentityReadinessReport does not add the password-migration blocker once the certificate is genuinely verified", async () => {
  // email > 0 bypasses the zero-legacy-accounts shortcut, so this only
  // proves the blocker's own condition (not merely the shortcut) — the
  // migration proof written here comes from real, matching D1 rows, not a
  // fake resolver.
  const context = fixture();
  const owner = insertUser(context.database, uid("pwverified", 1));
  context.database.prepare(`
    INSERT INTO app_password_credentials (user_id, scheme, verifier, source_updated_at, imported_at, updated_at, migration_source)
    VALUES (?, 'bcrypt', ?, ?, ?, ?, 'supabase_import')
  `).run(owner, VALID_BCRYPT, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
  const realManifest = await passwordProof.passwordProofManifest([{ userId: owner, sourceUpdatedAt: "2026-08-28T00:00:00.000Z", verifier: VALID_BCRYPT }]);
  await passwordMigrationAudit.certifyNativePasswordMigration(1, realManifest, context.bindings, Date.UTC(2026, 7, 28, 3));

  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source: [], summary: providerSummary({ email: 1 }) }));
  assert.equal(report.passwords.status, "verified");
  assert.equal(
    report.blockers.includes("Legacy email/password credentials do not yet have an exact source-to-D1 migration certificate"),
    false,
  );
});

test("nativeIdentityReadinessReport reads 'D1 identity or account records could not be checked' from a mid-check D1 failure", async () => {
  const context = fixture();
  const id = uid("d1fail", 1);
  insertUser(context.database, id);
  const source = [sourceIdentity({ authUserId: id, identityUserId: id, providerSubject: "d1fail-1" })];
  const failingAfterSchema = {
    ...context.bindings,
    db: {
      ...context.bindings.db,
      prepare(sql) {
        if (sql.includes("app_user_identities") && sql.includes("provider_subject IN")) {
          throw new Error("simulated D1 outage mid-check");
        }
        return context.bindings.db.prepare(sql);
      },
    },
  };
  const report = await identityAudit.nativeIdentityReadinessReport(failingAfterSchema, readinessOptions({ source }));
  assert.equal(report.target.schema, "unavailable");
  assert.ok(report.blockers.includes("D1 identity or account records could not be checked"));
  assert.equal(report.readyForBackfill, false);
  assert.equal(report.readyForGoogleCutover, false);
  assert.equal(report.readyForNativeAuthCutover, false);
});

test("nativeIdentityReadinessReport counts correct, mismatched and missing mappings exactly, and the exact sourceUsersMissing arithmetic", async () => {
  const context = fixture();
  const correctId = uid("map-correct", 1);
  const mismatchId = uid("map-mismatch", 1);
  const mismatchOwner = uid("map-mismatch-owner", 1);
  const missingId = uid("map-missing", 1);
  const notLiveId = uid("map-notlive", 1);
  for (const id of [correctId, mismatchId, mismatchOwner, missingId]) insertUser(context.database, id);
  // notLiveId is deliberately never inserted into app_users.

  const now = "2026-08-29T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'map-subject-correct', ?, NULL, 0, ?, ?)
  `).run(correctId, now, now);
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'map-subject-mismatch', ?, NULL, 0, ?, ?)
  `).run(mismatchOwner, now, now);

  const source = [
    sourceIdentity({ authUserId: correctId, identityUserId: correctId, providerSubject: "map-subject-correct" }),
    sourceIdentity({ authUserId: mismatchId, identityUserId: mismatchId, providerSubject: "map-subject-mismatch" }),
    sourceIdentity({ authUserId: missingId, identityUserId: missingId, providerSubject: "map-subject-missing" }),
    sourceIdentity({ authUserId: notLiveId, identityUserId: notLiveId, providerSubject: "map-subject-notlive" }),
  ];
  const report = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({ source }));

  assert.deepEqual(report.mappings, { correct: 1, missing: 2, mismatched: 1 });
  assert.equal(report.target.sourceUsersMissing, 1);
  assert.equal(report.target.sourceUsersPresent, 3, "4 distinct source users minus the 1 not live in D1");
  assert.ok(report.blockers.includes("1 existing D1 mapping(s) point to a different user id"));
  assert.ok(report.blockers.includes("2 Google identity mapping(s) still need an approved backfill"));
  assert.ok(report.blockers.includes("1 Supabase Google account(s) are missing a live D1 app_users record"));
  assert.equal(report.readyForBackfill, false, "a mismatch alone must block the backfill");
});

test("nativeIdentityReadinessReport's readiness flags each require their own specific condition, from an all-clean baseline", async () => {
  const context = fixture();
  const idX = uid("clean-x", 1);
  const idY = uid("clean-y", 1);
  insertUser(context.database, idX);
  insertUser(context.database, idY);
  const now = "2026-08-29T00:00:00.000000000Z";
  for (const [id, subject] of [[idX, "clean-subject-x"], [idY, "clean-subject-y"]]) {
    context.database.prepare(`
      INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
      VALUES ('google', ?, ?, NULL, 0, ?, ?)
    `).run(subject, id, now, now);
  }
  const source = [
    sourceIdentity({ authUserId: idX, identityUserId: idX, providerSubject: "clean-subject-x" }),
    sourceIdentity({ authUserId: idY, identityUserId: idY, providerSubject: "clean-subject-y" }),
  ];

  async function reportWith({ accounts, summary, dataAuthorityReady = true }) {
    const options = readinessOptions({ source, accounts, summary: summary ?? providerSummary({ google: 2 }) });
    return dataAuthorityReady ? withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, options)) : identityAudit.nativeIdentityReadinessReport(context.bindings, options);
  }

  const clean = await reportWith({ accounts: [{ id: idX }, { id: idY }] });
  assert.equal(clean.readyForBackfill, true);
  assert.equal(clean.readyForGoogleCutover, true);
  assert.equal(clean.readyForNativeAuthCutover, true);
  assert.equal(clean.accounts.liveD1UsersPresent, 2);
  assert.equal(clean.accounts.liveD1UsersMissing, 0);

  // One Supabase account with no live D1 counterpart taints accountsClean —
  // blocking the Google cutover — without touching readyForBackfill at all.
  const missingAccount = await reportWith({ accounts: [{ id: idX }, { id: idY }, { id: uid("clean-ghost", 1) }] });
  assert.equal(missingAccount.readyForBackfill, true, "readyForBackfill does not depend on the account roster");
  assert.equal(missingAccount.readyForGoogleCutover, false);
  assert.equal(missingAccount.accounts.liveD1UsersMissing, 1);
  assert.equal(missingAccount.accounts.liveD1UsersPresent, 2, "3 accounts minus the 1 missing");
  assert.ok(missingAccount.blockers.includes("1 current Supabase Auth account(s) are missing a live D1 app_users record"));

  // An Apple identity still needing backfill blocks only the *native auth*
  // cutover, one step past the Google-only one.
  const withApple = await reportWith({ accounts: [{ id: idX }, { id: idY }], summary: providerSummary({ google: 2, apple: 1 }) });
  assert.equal(withApple.readyForGoogleCutover, true);
  assert.equal(withApple.readyForNativeAuthCutover, false);

  // Without both application data authorities on Cloudflare, the Google
  // cutover itself must not read ready, even though everything else is clean.
  const notReady = await reportWith({ accounts: [{ id: idX }, { id: idY }], dataAuthorityReady: false });
  assert.equal(notReady.readyForGoogleCutover, false);
  assert.ok(notReady.blockers.includes("learner and organization data must both be Cloudflare-authoritative before native sign-in can serve users"));
});

test("nativeIdentityReadinessReport's readyForBackfill also requires no duplicate subjects and no user with multiple Google identities, independent of any mismatch", async () => {
  const context = fixture();
  const idA = uid("dupsub-a", 1);
  const idB = uid("dupsub-b", 1);
  insertUser(context.database, idA);
  insertUser(context.database, idB);
  // Two different, live D1 users sharing one still-unmapped Google subject:
  // both simply count as "missing" (never "mismatched", since neither has an
  // existing D1 mapping to disagree with) - so only duplicateSubjects taints
  // sourceClean here, not mismatched and not usersWithMultipleGoogleIdentities.
  const dupSubjectSource = [
    sourceIdentity({ authUserId: idA, identityUserId: idA, providerSubject: "shared-not-yet-mapped" }),
    sourceIdentity({ authUserId: idB, identityUserId: idB, providerSubject: "shared-not-yet-mapped" }),
  ];
  const dupSubjectReport = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: dupSubjectSource, accounts: [{ id: idA }, { id: idB }],
  }));
  assert.equal(dupSubjectReport.source.duplicateSubjects, 1);
  assert.equal(dupSubjectReport.source.usersWithMultipleGoogleIdentities, 0);
  assert.equal(dupSubjectReport.mappings.mismatched, 0);
  assert.equal(dupSubjectReport.target.sourceUsersMissing, 0);
  assert.equal(dupSubjectReport.readyForBackfill, false, "a duplicate subject alone must block the backfill even with zero mismatches");

  // One user with two distinct (each individually unique) Google identities:
  // taints sourceClean through usersWithMultipleGoogleIdentities alone,
  // since neither subject is itself duplicated.
  const idC = uid("multi-c", 1);
  insertUser(context.database, idC);
  const multiIdentitySource = [
    sourceIdentity({ authUserId: idC, identityUserId: idC, providerSubject: "multi-subject-one" }),
    sourceIdentity({ authUserId: idC, identityUserId: idC, providerSubject: "multi-subject-two" }),
  ];
  const multiReport = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: multiIdentitySource, accounts: [{ id: idC }],
  }));
  assert.equal(multiReport.source.usersWithMultipleGoogleIdentities, 1);
  assert.equal(multiReport.source.duplicateSubjects, 0);
  assert.equal(multiReport.mappings.mismatched, 0);
  assert.equal(multiReport.readyForBackfill, false, "a user with two Google identities alone must block the backfill");

  // One clean, correctly-mapped identity plus one structurally malformed
  // record (filtered out of `valid` entirely, so it touches neither the
  // mapping counts nor duplicateSubjects/usersWithMultipleGoogleIdentities):
  // sourceStatus alone must still block the backfill.
  const idD = uid("invalidsrc-d", 1);
  insertUser(context.database, idD);
  const now2 = "2026-08-29T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'invalidsrc-subject', ?, NULL, 0, ?, ?)
  `).run(idD, now2, now2);
  const invalidSourceMix = [
    sourceIdentity({ authUserId: idD, identityUserId: idD, providerSubject: "invalidsrc-subject" }),
    sourceIdentity({ providerSubject: "" }),
  ];
  const invalidSourceReport = await withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: invalidSourceMix, accounts: [{ id: idD }],
  })));
  assert.equal(invalidSourceReport.source.status, "invalid");
  assert.equal(invalidSourceReport.source.duplicateSubjects, 0);
  assert.equal(invalidSourceReport.source.usersWithMultipleGoogleIdentities, 0);
  assert.equal(invalidSourceReport.mappings.mismatched, 0);
  assert.equal(invalidSourceReport.mappings.missing, 0);
  assert.equal(invalidSourceReport.mappings.correct, 1);
  assert.equal(invalidSourceReport.target.sourceUsersMissing, 0);
  assert.equal(invalidSourceReport.readyForBackfill, false, "an invalid source record alone must block the backfill");
  // The mapping side is otherwise perfect (missing:0, correct:valid.length) -
  // only sourceClean (via source.status) stands between this and a clean
  // cutover, so readyForGoogleCutover must still read false.
  assert.equal(invalidSourceReport.readyForGoogleCutover, false, "an invalid source record alone must also block the Google cutover");
});

test("nativeIdentityReadinessReport's readyForBackfill treats a live-D1-missing user and a mismatched mapping as independent blockers", async () => {
  const context = fixture();
  // Isolated sourceUsersMissing: a valid, structurally clean source record
  // whose user was never created in D1 at all - not yet mapped either, so it
  // counts as "missing" (not mismatched) in the per-subject loop.
  const ghostId = uid("ghostuser", 1);
  const missingLiveSource = [sourceIdentity({ authUserId: ghostId, identityUserId: ghostId, providerSubject: "ghostuser-subject" })];
  const missingLiveReport = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: missingLiveSource, accounts: [],
  }));
  assert.equal(missingLiveReport.target.sourceUsersMissing, 1);
  assert.equal(missingLiveReport.mappings.mismatched, 0);
  assert.equal(missingLiveReport.readyForBackfill, false, "a live-D1-missing source user alone must block the backfill");

  // Isolated mismatched: the source's own user IS live in D1, but the
  // subject is already mapped (in app_user_identities) to a *different*
  // live user - no live-D1-missing user anywhere in this scenario.
  const claimant = uid("mismatch-claimant", 1);
  const owner = uid("mismatch-owner", 1);
  insertUser(context.database, claimant);
  insertUser(context.database, owner);
  const now = "2026-08-29T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'isolated-mismatch-subject', ?, NULL, 0, ?, ?)
  `).run(owner, now, now);
  const mismatchSource = [sourceIdentity({ authUserId: claimant, identityUserId: claimant, providerSubject: "isolated-mismatch-subject" })];
  const mismatchReport = await identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: mismatchSource, accounts: [{ id: claimant }],
  }));
  assert.equal(mismatchReport.target.sourceUsersMissing, 0);
  assert.equal(mismatchReport.mappings.mismatched, 1);
  assert.equal(mismatchReport.readyForBackfill, false, "a mismatched mapping alone must block the backfill even with zero live-D1-missing users");
});

test("nativeIdentityReadinessReport's readyForNativeAuthCutover requires zero unsupported and zero invalid legacy identities on their own", async () => {
  const context = fixture();
  const idU = uid("unsupported-clean", 1);
  insertUser(context.database, idU);
  const now = "2026-08-29T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'unsupported-clean-subject', ?, NULL, 0, ?, ?)
  `).run(idU, now, now);
  const cleanSource = [sourceIdentity({ authUserId: idU, identityUserId: idU, providerSubject: "unsupported-clean-subject" })];

  const unsupportedReport = await withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: cleanSource, accounts: [{ id: idU }], summary: providerSummary({ google: 1, unsupported: 2 }),
  })));
  assert.equal(unsupportedReport.readyForGoogleCutover, true, "an unsupported legacy provider does not block the Google-only cutover");
  assert.equal(unsupportedReport.readyForNativeAuthCutover, false, "an unsupported legacy provider alone must block the full native-auth cutover");

  const invalidProviderReport = await withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: cleanSource, accounts: [{ id: idU }], summary: providerSummary({ google: 1, invalid: 3 }),
  })));
  assert.equal(invalidProviderReport.readyForGoogleCutover, true, "an invalid legacy identity record does not block the Google-only cutover");
  assert.equal(invalidProviderReport.readyForNativeAuthCutover, false, "an invalid legacy identity record alone must block the full native-auth cutover");
});

test("nativeIdentityReadinessReport's readyForNativeAuthCutover reads true once a real (not shortcut) password-migration certificate verifies, with email > 0", async () => {
  const context = fixture();
  const idV = uid("pwverified-cutover", 1);
  insertUser(context.database, idV);
  const now = "2026-08-29T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'pwverified-cutover-subject', ?, NULL, 0, ?, ?)
  `).run(idV, now, now);
  const cleanSource = [sourceIdentity({ authUserId: idV, identityUserId: idV, providerSubject: "pwverified-cutover-subject" })];

  context.database.prepare(`
    INSERT INTO app_password_credentials (user_id, scheme, verifier, source_updated_at, imported_at, updated_at, migration_source)
    VALUES (?, 'bcrypt', ?, ?, ?, ?, 'supabase_import')
  `).run(idV, VALID_BCRYPT, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
  const realManifest = await passwordProof.passwordProofManifest([{ userId: idV, sourceUpdatedAt: "2026-08-28T00:00:00.000Z", verifier: VALID_BCRYPT }]);
  await passwordMigrationAudit.certifyNativePasswordMigration(1, realManifest, context.bindings, Date.UTC(2026, 7, 28, 3));

  const report = await withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: cleanSource, accounts: [{ id: idV }], summary: providerSummary({ google: 1, email: 1 }),
  })));
  assert.equal(report.passwords.status, "verified");
  assert.equal(report.readyForGoogleCutover, true);
  assert.equal(report.readyForNativeAuthCutover, true, "a genuinely verified legacy-password migration must not hold back the native-auth cutover");
});

test("nativeIdentityReadinessReport's readyForGoogleCutover also requires a clean account roster, independent of the mapping state", async () => {
  const context = fixture();
  const idM = uid("acctclean-m", 1);
  insertUser(context.database, idM);
  const now = "2026-08-29T00:00:00.000000000Z";
  context.database.prepare(`
    INSERT INTO app_user_identities (provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at)
    VALUES ('google', 'acctclean-subject', ?, NULL, 0, ?, ?)
  `).run(idM, now, now);
  const cleanMappingSource = [sourceIdentity({ authUserId: idM, identityUserId: idM, providerSubject: "acctclean-subject" })];

  const invalidAccountReport = await withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: cleanMappingSource, accounts: [{ id: idM }, { id: "too-short" }],
  })));
  assert.equal(invalidAccountReport.readyForBackfill, true, "the mapping side is fully clean");
  assert.equal(invalidAccountReport.accounts.status, "invalid");
  assert.equal(invalidAccountReport.readyForGoogleCutover, false, "an invalid account record alone must block the Google cutover");

  const duplicateAccountReport = await withDataAuthorityReady(() => identityAudit.nativeIdentityReadinessReport(context.bindings, readinessOptions({
    source: cleanMappingSource, accounts: [{ id: idM }, { id: idM }],
  })));
  assert.equal(duplicateAccountReport.readyForBackfill, true);
  assert.equal(duplicateAccountReport.accounts.duplicateUserIds, 1);
  assert.equal(duplicateAccountReport.readyForGoogleCutover, false, "a duplicate account id alone must block the Google cutover");
});
