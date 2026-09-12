/*
  lib/billing/subscriptions.ts, behaviourally.

  billing-webhook.test.mjs already drives applyStripeSubscription's Supabase
  RPC contract end to end. What is missing there, and pinned here instead, is
  everything that decides *which* backend a write goes to and *whether* a
  Cloudflare replica is attempted alongside it:

    - cloudflareBillingReplicaEnabled(): a pure function of two env-mode
      switches, proved by counting the fetch calls a webhook delivery makes
      (one when neither switch has moved off Supabase, two — the RPC and the
      replica read — the moment either one has).
    - the native-vs-legacy selection every one of the three Stripe writers
      makes before ever touching Supabase, proved by actually routing a
      delivery into a real (in-memory) D1 and showing no Supabase request was
      made.
    - the outcome contract (isOutcome / isPrepaidOutcome): every value the
      database is allowed to answer with, and that an unrecognised one is a
      thrown failure rather than a silently accepted success.
    - which outcomes are worth a best-effort Cloudflare replica at all — the
      three writers do not agree (a stale prepaid purchase is not replicated;
      a stale prepaid refund is), so each is proved on its own.
    - the exact RPC name and argument object each writer sends, and
      stripeCustomerFor's own backend selection.

  D1 is faked the same way tests/native-stripe-billing.test.mjs and
  tests/entitlement-cloudflare-cutover.test.mjs already do: a real in-memory
  SQLite database with the actual cloudflare/migrations applied, wrapped in a
  minimal adapter that matches D1's prepare/bind/run/first/all/batch shape.
  Supabase is faked the same way tests/billing-webhook.test.mjs does: a
  `globalThis.fetch` stub that answers by URL and records every call.
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

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);
const subscriptions = await load("lib", "billing", "subscriptions.ts");

/* ------------------------------------------------------------------------- */
/* Shared fixtures: env vars, D1-over-SQLite, and a URL-routed fetch stub.    */

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

const SUPABASE_CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

/** The same D1-over-SQLite adapter every other Cloudflare-fixture test file uses. */
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
    prepare(sql) {
      return { bind: (...values) => bound(sql, values), ...bound(sql, []) };
    },
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

function fakeR2() {
  const objects = new Map();
  return {
    async put(key, value) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { async arrayBuffer() { return value.buffer; } } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

function freshD1() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(ROOT, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", file), "utf8"));
  }
  return database;
}

function cfFixture() {
  const database = freshD1();
  return { database, bindings: { db: runtimeD1(database), files: fakeR2() } };
}

function insertUser(database, userId) {
  database.prepare(`
    INSERT INTO app_users (id, identity_provider, email, role, created_at, updated_at)
    VALUES (?, 'supabase', ?, 'user', '2026-08-29T00:00:00.000000000Z', '2026-08-29T00:00:00.000000000Z')
  `).run(userId, `${userId}@example.test`);
}

/** Runs `fn` with a live Cloudflare context; always tears it back down. */
async function withCloudflareContext(bindings, fn) {
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files } };
  try {
    return await fn();
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A URL-routed Supabase fetch stub.
 *
 * `rpc` maps a Postgres function name to either a fixed value or a
 * `(body, callNumber) => value` responder. `replica` is what
 * stripeSubscriptionReplica's GET should answer (an authoritative row, or
 * null/undefined for "nothing found"). Anything else is a loud failure rather
 * than a silent wrong answer, so a test that reaches an un-modelled call finds
 * out immediately instead of asserting against a stub that quietly guessed.
 */
function fakeSupabaseFetch({ rpc = {}, replica = undefined } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = String(url).replace(SUPABASE_CONFIG.SUPABASE_URL, "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });

    const rpcMatch = /^\/rest\/v1\/rpc\/([a-zA-Z_]+)$/.exec(path);
    if (rpcMatch && Object.hasOwn(rpc, rpcMatch[1])) {
      const responder = rpc[rpcMatch[1]];
      const outcome = typeof responder === "function" ? responder(body, calls.length) : responder;
      return jsonResponse(outcome);
    }
    if (method === "GET" && path.startsWith("/rest/v1/subscriptions") && path.includes("provider=eq.stripe")) {
      return jsonResponse(replica ? [replica] : []);
    }
    throw new Error(`fakeSupabaseFetch: unmodelled request ${method} ${path}`);
  };
  return { fn, calls };
}

/** Runs `fn` with SUPABASE_CONFIG set and `stub.fn` as `globalThis.fetch`. */
function against(stub, fn) {
  return withEnv(SUPABASE_CONFIG, async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = stub.fn;
    try {
      return await fn();
    } finally {
      globalThis.fetch = saved;
    }
  });
}

function captureConsoleError() {
  const messages = [];
  const saved = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  return { messages, restore: () => { console.error = saved; } };
}

const USER_ID = "70000000-0000-4000-8000-000000000010";

function subscriptionEvent(overrides = {}) {
  return {
    eventId: "evt_sub_1",
    eventAt: "2026-08-29T12:00:00.000Z",
    userId: USER_ID,
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

function prepaidPurchaseEvent(overrides = {}) {
  return {
    eventId: "evt_wallet_1",
    eventAt: "2026-08-29T12:00:00.000Z",
    userId: USER_ID,
    tier: "tracking",
    planId: "tracking-monthly",
    interval: "month",
    customerId: "cus_wallet",
    paymentIntentId: "pi_1",
    ...overrides,
  };
}

function prepaidRefundEvent(overrides = {}) {
  return {
    eventId: "evt_refund_1",
    eventAt: "2026-08-30T12:00:00.000Z",
    paymentIntentId: "pi_1",
    amountMinor: 499,
    fullRefundConfirmed: true,
    ...overrides,
  };
}

function authoritativeRow(overrides = {}) {
  const now = "2026-08-29T12:00:00.000000Z";
  return {
    id: "sub-row-1",
    user_id: USER_ID,
    status: "active",
    tier: "ai",
    external_customer_id: "cus_1",
    external_subscription_id: "sub_1",
    external_price_id: "price_ai",
    current_period_end: null,
    cancel_at_period_end: false,
    provider_event_at: now,
    verified_at: now,
    raw: { note: "authoritative" },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- */
/* assertServerOnly(MODULE): every entry point refuses a browser context.    */

/*
  assertServerOnly only throws once `window` exists, which node:test's global
  scope never does — so calling these functions here never exercises that
  guard at all, and a dropped `assertServerOnly(MODULE)` call is invisible to
  every other test in this file. Forcing `window` to exist for one test proves
  both that the call still runs and that MODULE still names this file, since
  the thrown message is `${MODULE} is server-only...`.
*/
test("every export refuses to run once a window exists, naming this exact module", async () => {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(
      () => subscriptions.applyStripeSubscription(subscriptionEvent(), {}),
      /lib\/billing\/subscriptions\.ts is server-only and must not be imported from a client component\./,
    );
    await assert.rejects(
      () => subscriptions.applyStripePrepaidPurchase(prepaidPurchaseEvent(), {}),
      /lib\/billing\/subscriptions\.ts is server-only/,
    );
    await assert.rejects(
      () => subscriptions.applyStripePrepaidRefund(prepaidRefundEvent(), {}),
      /lib\/billing\/subscriptions\.ts is server-only/,
    );
    await assert.rejects(
      () => subscriptions.stripeCustomerFor(USER_ID),
      /lib\/billing\/subscriptions\.ts is server-only/,
    );
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

/* ------------------------------------------------------------------------- */
/* cloudflareBillingReplicaEnabled(): purely a function of the two env modes. */

test("a Cloudflare replica is attempted only once either data mode has moved off Supabase", async () => {
  const event = subscriptionEvent();

  // Both modes on Supabase (the default: both env vars unset): one call, the
  // RPC alone. No replica read is even attempted.
  await withEnv({ CLOUDFLARE_DATA_MODE: undefined, ORGANIZATION_DATA_MODE: undefined }, async () => {
    const stub = fakeSupabaseFetch({ rpc: { apply_provider_subscription_event: "applied" } });
    await against(stub, () => subscriptions.applyStripeSubscription(event, {}));
    assert.equal(stub.calls.length, 1, "no replica read when both domains are on Supabase");
  });

  // The learner switch alone moves it: proves the left operand genuinely
  // participates (a mutant that hard-codes it false, or flips !== to ===,
  // would keep this at one call).
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual", ORGANIZATION_DATA_MODE: undefined }, async () => {
    const stub = fakeSupabaseFetch({
      rpc: { apply_provider_subscription_event: "applied" },
      replica: null,
    });
    await against(stub, () => subscriptions.applyStripeSubscription(event, {}));
    assert.equal(stub.calls.length, 2, "CLOUDFLARE_DATA_MODE=dual alone must enable the replica read");
    assert.match(stub.calls[1].path, /^\/rest\/v1\/subscriptions\?provider=eq\.stripe/);
  });

  // The organization switch alone also moves it (the `||`, not just the first
  // operand): proves the mutant that hard-codes the *whole* expression false
  // is distinguishable from proper `||` behaviour on the right operand too.
  await withEnv({ CLOUDFLARE_DATA_MODE: undefined, ORGANIZATION_DATA_MODE: "dual" }, async () => {
    const stub = fakeSupabaseFetch({
      rpc: { apply_provider_subscription_event: "duplicate" },
      replica: null,
    });
    await against(stub, () => subscriptions.applyStripeSubscription(event, {}));
    assert.equal(stub.calls.length, 2, "ORGANIZATION_DATA_MODE=dual alone must also enable the replica read");
  });
});

/* ------------------------------------------------------------------------- */
/* The outcome contract: every value each writer accepts, and the rest.      */

test("applyStripePrepaidPurchase accepts every value isPrepaidOutcome names and nothing else", async () => {
  const event = prepaidPurchaseEvent();
  for (const outcome of ["applied", "duplicate", "stale", "unknown_user", "unknown_purchase", "partial_refund"]) {
    const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_purchase_event: outcome } });
    const result = await against(stub, () => subscriptions.applyStripePrepaidPurchase(event, {}));
    assert.equal(result, outcome, `${outcome} must be returned as-is, not rejected as unrecognised`);
  }

  const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_purchase_event: "not_a_real_outcome" } });
  await assert.rejects(
    () => against(stub, () => subscriptions.applyStripePrepaidPurchase(event, {})),
    /unrecognised outcome from apply_stripe_prepaid_purchase_event/,
  );
});

test("applyStripePrepaidRefund accepts every value isPrepaidOutcome names and nothing else", async () => {
  const event = prepaidRefundEvent();
  for (const outcome of ["applied", "duplicate", "stale", "unknown_user", "unknown_purchase", "partial_refund"]) {
    const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_refund_event: outcome } });
    const result = await against(stub, () => subscriptions.applyStripePrepaidRefund(event, {}));
    assert.equal(result, outcome);
  }

  const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_refund_event: "not_a_real_outcome" } });
  await assert.rejects(
    () => against(stub, () => subscriptions.applyStripePrepaidRefund(event, {})),
    /unrecognised outcome from apply_stripe_prepaid_refund_event/,
  );
});

test("applyStripeSubscription rejects an outcome the database function was never written to return", async () => {
  const event = subscriptionEvent();
  const stub = fakeSupabaseFetch({ rpc: { apply_provider_subscription_event: "not_a_real_outcome" } });
  await assert.rejects(
    () => against(stub, () => subscriptions.applyStripeSubscription(event, {})),
    /unrecognised outcome from apply_provider_subscription_event/,
  );
});

/* ------------------------------------------------------------------------- */
/* Which outcomes earn a best-effort replica: the three writers disagree.    */

test("a subscription event replicates for applied, duplicate and stale, never for unknown_user", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    for (const outcome of ["applied", "stale"]) {
      const stub = fakeSupabaseFetch({
        rpc: { apply_provider_subscription_event: outcome },
        replica: null,
      });
      await against(stub, () => subscriptions.applyStripeSubscription(subscriptionEvent(), {}));
      assert.equal(stub.calls.length, 2, `${outcome} must attempt a replica read`);
    }
    const stub = fakeSupabaseFetch({
      rpc: { apply_provider_subscription_event: "unknown_user" },
    });
    await against(stub, () => subscriptions.applyStripeSubscription(subscriptionEvent(), {}));
    assert.equal(stub.calls.length, 1, "unknown_user must never attempt a replica read");
  });
});

test("a prepaid purchase replicates only for applied and duplicate — not stale, unlike a subscription event", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    for (const outcome of ["applied", "duplicate"]) {
      const stub = fakeSupabaseFetch({
        rpc: { apply_stripe_prepaid_purchase_event: outcome },
        replica: null,
      });
      await against(stub, () => subscriptions.applyStripePrepaidPurchase(prepaidPurchaseEvent(), {}));
      assert.equal(stub.calls.length, 2, `${outcome} must attempt a replica read`);
    }
    for (const outcome of ["stale", "unknown_user", "unknown_purchase"]) {
      const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_purchase_event: outcome } });
      await against(stub, () => subscriptions.applyStripePrepaidPurchase(prepaidPurchaseEvent(), {}));
      assert.equal(stub.calls.length, 1, `${outcome} must never attempt a replica read for a purchase`);
    }
  });
});

test("a prepaid refund replicates for applied, duplicate, stale and partial_refund — not unknown outcomes", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    for (const outcome of ["applied", "duplicate", "stale", "partial_refund"]) {
      const stub = fakeSupabaseFetch({
        rpc: { apply_stripe_prepaid_refund_event: outcome },
        replica: null,
      });
      await against(stub, () => subscriptions.applyStripePrepaidRefund(prepaidRefundEvent(), {}));
      assert.equal(stub.calls.length, 2, `${outcome} must attempt a replica read`);
    }
    for (const outcome of ["unknown_user", "unknown_purchase"]) {
      const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_refund_event: outcome } });
      await against(stub, () => subscriptions.applyStripePrepaidRefund(prepaidRefundEvent(), {}));
      assert.equal(stub.calls.length, 1, `${outcome} must never attempt a replica read for a refund`);
    }
  });
});

/*
  When the replica read comes back empty, the best-effort attempt has to say
  so plainly rather than silently pretend it worked or silently pretend it
  failed. Both prepaid writers turn "no authoritative row found" into `false`
  via a ternary; a mutant swapping that `false` for `true` would skip the log
  below and returns unnoticed.
*/
test("a prepaid write logs its replica failure plainly when nothing authoritative can be found to mirror", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const spy = captureConsoleError();
    try {
      const purchaseStub = fakeSupabaseFetch({
        rpc: { apply_stripe_prepaid_purchase_event: "applied" },
        replica: null,
      });
      await against(purchaseStub, () => subscriptions.applyStripePrepaidPurchase(prepaidPurchaseEvent(), {}));
      assert.ok(
        spy.messages.includes("[accounts] billing/prepaid purchase Cloudflare replica: replica write returned false"),
        `expected the purchase replica-failure log, saw: ${JSON.stringify(spy.messages)}`,
      );

      spy.messages.length = 0;
      const refundStub = fakeSupabaseFetch({
        rpc: { apply_stripe_prepaid_refund_event: "applied" },
        replica: null,
      });
      await against(refundStub, () => subscriptions.applyStripePrepaidRefund(prepaidRefundEvent(), {}));
      assert.ok(
        spy.messages.includes("[accounts] billing/prepaid refund Cloudflare replica: replica write returned false"),
        `expected the refund replica-failure log, saw: ${JSON.stringify(spy.messages)}`,
      );
    } finally {
      spy.restore();
    }
  });
});

/*
  The other side of that ternary: a real authoritative row, mirrored all the
  way into a live D1. This is the only way to make `replicate()` genuinely
  resolve `true` (a mutant forcing `await replicate()` to `false` would log
  "returned false" even here, where nothing actually failed), so it needs a
  full Cloudflare context rather than the call-counting stub above.
*/
test("a subscription event with a real authoritative row mirrors all the way into D1, logging nothing", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { database, bindings } = cfFixture();
    await withCloudflareContext(bindings, async () => {
      const spy = captureConsoleError();
      try {
        const stub = fakeSupabaseFetch({
          rpc: { apply_provider_subscription_event: "applied" },
          replica: authoritativeRow(),
        });
        const result = await against(stub, () => subscriptions.applyStripeSubscription(subscriptionEvent(), {}));
        assert.equal(result, "applied");
        assert.deepEqual(spy.messages, [], "a successful mirror must log nothing");

        const stored = database.prepare(
          "SELECT provider, status, tier, external_subscription_id FROM subscriptions WHERE external_subscription_id = ?",
        ).get("sub_1");
        assert.deepEqual(
          { ...stored },
          { provider: "stripe", status: "active", tier: "ai", external_subscription_id: "sub_1" },
        );
      } finally {
        spy.restore();
      }
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Native D1 selection: chosen before Supabase is ever touched.               */

test("every Stripe writer selects the native D1 path before Supabase is asked anything", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare", CLOUDFLARE_NATIVE_STRIPE_BILLING: "1" }, async () => {
    const { database, bindings } = cfFixture();
    insertUser(database, USER_ID);
    await withCloudflareContext(bindings, async () => {
      const saved = globalThis.fetch;
      // Any Supabase call at all is the bug this test exists to catch.
      globalThis.fetch = async (url) => { throw new Error(`must not call Supabase natively: ${url}`); };
      try {
        const subResult = await subscriptions.applyStripeSubscription(subscriptionEvent(), { id: "evt_sub_1" });
        assert.equal(subResult, "applied");

        const purchaseResult = await subscriptions.applyStripePrepaidPurchase(
          prepaidPurchaseEvent(),
          { data: { object: { amount_total: 499 } } },
        );
        assert.equal(purchaseResult, "applied");

        const refundResult = await subscriptions.applyStripePrepaidRefund(
          prepaidRefundEvent({ paymentIntentId: "pi_1", amountMinor: 499, fullRefundConfirmed: true }),
          { id: "evt_refund_1" },
        );
        assert.equal(refundResult, "applied");

        assert.equal(
          database.prepare("SELECT count(*) AS n FROM subscriptions WHERE provider = 'stripe'").get().n,
          2,
          "one row for the subscription, one for the prepaid purchase",
        );
      } finally {
        globalThis.fetch = saved;
      }
    });
  });
});

/*
  The mirror image: with the native switch off (the default everywhere in
  this file except the test above), the domain being ready for a Cloudflare
  cutover must never, by itself, be read as "native Stripe billing is active".
  The per-domain override is used here rather than the global
  CLOUDFLARE_DATA_MODE precisely so this stays a clean test of nativeStripeBillingActive()
  alone — the global switch would also flip cloudflareBillingReplicaEnabled()
  and change how many requests "applied" makes, which is a different fact,
  covered by its own test above.
*/
test("the domain override alone, without the explicit native switch, still leaves Supabase in charge", async () => {
  await withEnv(
    { CLOUDFLARE_DATA_MODE_BILLING_ENTITLEMENT_RUNTIME: "cloudflare", CLOUDFLARE_NATIVE_STRIPE_BILLING: undefined },
    async () => {
      const stub = fakeSupabaseFetch({ rpc: { apply_provider_subscription_event: "applied" } });
      const result = await against(stub, () => subscriptions.applyStripeSubscription(subscriptionEvent(), {}));
      assert.equal(result, "applied");
      assert.equal(stub.calls.length, 1);
      assert.match(stub.calls[0].path, /^\/rest\/v1\/rpc\/apply_provider_subscription_event$/);
    },
  );
});

/* ------------------------------------------------------------------------- */
/* Exact RPC name and argument forwarding.                                    */

test("applyStripePrepaidPurchase sends every field the database needs, under its own RPC name", async () => {
  const event = prepaidPurchaseEvent();
  const payload = { raw: "wallet-purchase-payload" };
  const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_purchase_event: "applied" } });
  await against(stub, () => subscriptions.applyStripePrepaidPurchase(event, payload));

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].path, "/rest/v1/rpc/apply_stripe_prepaid_purchase_event");
  assert.deepEqual(stub.calls[0].body, {
    p_event_id: event.eventId,
    p_event_at: event.eventAt,
    p_payload: payload,
    p_user_id: event.userId,
    p_tier: event.tier,
    p_plan_id: event.planId,
    p_customer_id: event.customerId,
    p_payment_intent_id: event.paymentIntentId,
    p_interval: event.interval,
  });
});

test("applyStripePrepaidRefund sends every field the database needs, under its own RPC name", async () => {
  const event = prepaidRefundEvent();
  const payload = { raw: "wallet-refund-payload" };
  const stub = fakeSupabaseFetch({ rpc: { apply_stripe_prepaid_refund_event: "applied" } });
  await against(stub, () => subscriptions.applyStripePrepaidRefund(event, payload));

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].path, "/rest/v1/rpc/apply_stripe_prepaid_refund_event");
  assert.deepEqual(stub.calls[0].body, {
    p_event_id: event.eventId,
    p_event_at: event.eventAt,
    p_payload: payload,
    p_payment_intent_id: event.paymentIntentId,
    p_refund_amount: event.amountMinor,
    p_full_refund_confirmed: event.fullRefundConfirmed,
  });
});

/* ------------------------------------------------------------------------- */
/* stripeCustomerFor: backend selection, RPC forwarding, and the empty-string  */
/* boundary.                                                                  */

test("stripeCustomerFor asks Supabase by default, forwarding the exact RPC name and arguments", async () => {
  const stub = fakeSupabaseFetch({ rpc: { provider_customer_for_user: "cus_from_supabase" } });
  const result = await against(stub, () => subscriptions.stripeCustomerFor(USER_ID));
  assert.equal(result, "cus_from_supabase");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].path, "/rest/v1/rpc/provider_customer_for_user");
  assert.deepEqual(stub.calls[0].body, { p_user_id: USER_ID, p_provider: "stripe" });
});

test("stripeCustomerFor treats an empty string the same as no customer at all", async () => {
  const stub = fakeSupabaseFetch({ rpc: { provider_customer_for_user: "" } });
  const result = await against(stub, () => subscriptions.stripeCustomerFor(USER_ID));
  assert.equal(result, null, "an empty string is not a customer id");
});

test("stripeCustomerFor reads D1 directly once readsFromCloudflare() is true, never touching Supabase", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "cloudflare" }, async () => {
    const { database, bindings } = cfFixture();
    insertUser(database, USER_ID);
    const now = "2026-08-29T00:00:00.000000Z";
    database.prepare(`
      INSERT INTO subscriptions (
        id, user_id, provider, status, tier, external_customer_id,
        external_subscription_id, verified_at, created_at, updated_at
      ) VALUES ('sub-d1-1', ?, 'stripe', 'active', 'ai', 'cus_from_d1', 'sub_d1_1', ?, ?, ?)
    `).run(USER_ID, now, now, now);

    await withCloudflareContext(bindings, async () => {
      const saved = globalThis.fetch;
      globalThis.fetch = async (url) => { throw new Error(`must not call Supabase once reading from Cloudflare: ${url}`); };
      try {
        const result = await subscriptions.stripeCustomerFor(USER_ID);
        assert.equal(result, "cus_from_d1");
      } finally {
        globalThis.fetch = saved;
      }
    });
  });
});
