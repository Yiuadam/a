/*
  Giving the free AI trial up.

  The feature is one paragraph to describe and three ways to get wrong, and all
  three fail silently — nobody would see a stack trace, they would just find the
  wrong thing on their account:

    a release that writes 'canceled' is indistinguishable from the owner
    withdrawing the trial, so either every released account is offered it again
    (undoing the owner's decision) or none of them can ever take it again;

    a release that reaches a row belonging to any other provider would cancel a
    subscription somebody is paying for;

    a release offered to somebody who does not hold the grant — a paying
    subscriber, the owner — would draw a button that either lies or breaks.

  So the writes are exercised against a fake PostgREST rather than asserted from
  the source: what is checked is the request that would reach the database, and
  the WHERE clause is where the whole reversibility rule lives.

  Every assertion against source text runs with comments stripped first. An
  earlier test in this repository passed against a comment quoting the code it
  was meant to be checking.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const root = process.cwd();
const promo = await import(pathToFileURL(join(root, "lib", "billing", "promo.ts")).href);

/** The file's code, without comments to match by accident. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(...parts) {
  return readFileSync(join(root, ...parts), "utf8");
}

const CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

const USER = "50000000-0000-4000-8000-000000000099";
const EMAIL = "trialist@example.test";

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** What PostgREST returns when a constraint refuses the row. */
function refusal(code_, message) {
  return jsonResponse({ code: code_, message }, 400);
}

/**
 * A fake PostgREST holding one account's promo rows.
 *
 * `statuses` is the account's promo rows, by status. `entitlement` is what
 * resolve_entitlement answers — the real function reads the rows, and here the
 * two are set independently on purpose, so a test can pin what happens when
 * they disagree (the owner's sweep landing mid-request).
 */
function fakeSupabase({ statuses = [], entitlement, providerAllowed = true, resolveAfter }) {
  const calls = [];
  let resolves = 0;
  const rows = [...statuses];

  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(CONFIG.SUPABASE_URL, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });

    if (path.startsWith("/rest/v1/rpc/resolve_entitlement")) {
      resolves += 1;
      const answer = resolves > 1 && resolveAfter ? resolveAfter : entitlement;
      return jsonResponse(answer);
    }

    if (path.startsWith("/rest/v1/subscriptions")) {
      if (method === "POST") {
        // The capability probe inserts a row naming a user that cannot exist.
        if (body?.user_id === "00000000-0000-0000-0000-000000000000") {
          return providerAllowed
            ? refusal("23503", 'violates foreign key constraint "subscriptions_user_id_fkey"')
            : refusal("23514", 'violates check constraint "subscriptions_provider_check"');
        }
        if (!providerAllowed) {
          return refusal("23514", 'violates check constraint "subscriptions_provider_check"');
        }
        rows.push(String(body?.status));
        return new Response(null, { status: 201 });
      }
      if (method === "GET") {
        return jsonResponse(rows.map((status) => ({ status })));
      }
      if (method === "PATCH") {
        if (!providerAllowed) {
          return refusal("23514", 'violates check constraint "subscriptions_provider_check"');
        }
        const list = /[?&]status=in\.\(([^)]*)\)/.exec(path);
        const single = /[?&]status=eq\.([a-z_]+)/.exec(path);
        const wanted = list ? list[1].split(",") : single ? [single[1]] : [];
        const hit = rows.filter((status) => wanted.includes(status));
        for (let i = 0; i < rows.length; i += 1) {
          if (wanted.includes(rows[i])) rows[i] = String(body?.status);
        }
        return jsonResponse(hit.map((status) => ({ status })));
      }
    }

    throw new Error(`unexpected ${method} ${path}`);
  };

  return {
    calls,
    fetch,
    rows,
    /** Every write that reached the subscriptions table. */
    writes() {
      return calls.filter((c) => c.method !== "GET" && c.path.startsWith("/rest/v1/subscriptions"));
    },
  };
}

function entitlementOf(tier, source) {
  return { role: "user", tier, source, expires_at: null };
}

/** Runs `fn` against a fake Supabase, with the capability cache cleared. */
function against(fixture, fn) {
  return withEnv(CONFIG, async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = fixture.fetch;
    promo.forgetPromoCapability();
    try {
      return await fn();
    } finally {
      globalThis.fetch = saved;
      promo.forgetPromoCapability();
    }
  });
}

/*
  ---------------------------------------------------------------------------
  A real (in-memory) D1, for the one decision this file's fake PostgREST
  cannot stand in for: whether a write goes to Supabase at all, or to D1
  directly through the native promo writer. That choice
  (`nativePromoAuthority()` in lib/billing/promo.ts) is proved by actually
  routing a call into a migrated D1 and showing no Supabase request was made,
  the same D1-over-SQLite adapter tests/native-promo-write.test.mjs uses.
*/
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
  for (const file of readdirSync(join(root, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(root, "cloudflare", "migrations", file), "utf8"));
  }
  return database;
}

/** Runs `fn` with a live (empty, migrated) Cloudflare context; always tears it down. */
async function withCloudflareContext(fn) {
  const database = freshD1();
  const bindings = { db: runtimeD1(database), files: fakeR2() };
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files } };
  try {
    return await fn(database);
  } finally {
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  }
}

/** Captures console.error calls made during `fn`, restoring it afterward. */
async function captureConsoleError(fn) {
  const messages = [];
  const saved = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = saved;
  }
  return messages;
}

/* ------------------------------------------------------------------------- */
/* What the release writes                                                    */

test("giving it up pauses the grant — it does not write the owner's 'canceled'", async () => {
  const fixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("ai", "promo"),
    resolveAfter: entitlementOf("free", "default"),
  });
  const result = await against(fixture, () => promo.releasePromo(USER, EMAIL));

  assert.deepEqual(result, { outcome: "released", tier: "free" });

  const patches = fixture.writes().filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1, "exactly one write");
  assert.equal(
    patches[0].body.status,
    "paused",
    "a released trial must be distinguishable from one the owner withdrew",
  );
  assert.notEqual(patches[0].body.status, "canceled");
});

test("the release can only ever touch this account's promo rows", async () => {
  const fixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("ai", "promo"),
    resolveAfter: entitlementOf("free", "default"),
  });
  await against(fixture, () => promo.releasePromo(USER, EMAIL));

  const [patch] = fixture.writes().filter((c) => c.method === "PATCH");
  assert.match(patch.path, /provider=eq\.promo/, "a paid subscription must be unreachable");
  assert.match(patch.path, new RegExp(`user_id=eq\\.${USER}`));
  assert.match(patch.path, /status=in\.\(active,trialing\)/, "only a live grant is released");
  // Nothing about the row's tier, provider or account is taken from a caller.
  assert.deepEqual(Object.keys(patch.body), ["status"]);
});

test("the status a release writes is one the existing CHECK already allows", async () => {
  const fixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("ai", "promo"),
    resolveAfter: entitlementOf("free", "default"),
  });
  await against(fixture, () => promo.releasePromo(USER, EMAIL));
  const [patch] = fixture.writes().filter((c) => c.method === "PATCH");

  /*
    The point of the whole design: no migration. supabase/migrations/0001 fixes
    the permitted statuses, and the one chosen here has to be in that list or the
    owner would need a second hand-run ALTER.
  */
  const migration = read("supabase", "migrations", "0001_accounts_core.sql");
  const allowed = /constraint subscriptions_status_check check \(\s*status in \(([^)]*)\)/
    .exec(migration)[1]
    .split(",")
    .map((value) => value.trim().replace(/'/g, ""));
  assert.ok(
    allowed.includes(patch.body.status),
    `${patch.body.status} is not permitted by subscriptions_status_check`,
  );
});

/* ------------------------------------------------------------------------- */
/* Who may release anything                                                   */

for (const [tier, source, who] of [
  ["ai", "stripe", "a Stripe subscriber"],
  ["ai", "apple", "an App Store subscriber"],
  ["admin", "role", "the owner"],
  ["free", "default", "an account with no trial"],
]) {
  test(`${who} cannot release anything, and no write is attempted`, async () => {
    const fixture = fakeSupabase({ statuses: ["active"], entitlement: entitlementOf(tier, source) });
    const result = await against(fixture, () => promo.releasePromo(USER, EMAIL));
    assert.deepEqual(result, { outcome: "not-held", tier: null });
    assert.deepEqual(fixture.writes(), []);
  });
}

test("a signed-out caller releases nothing without reaching the database", async () => {
  const fixture = fakeSupabase({ entitlement: entitlementOf("free", "default") });
  const result = await against(fixture, () => promo.releasePromo(null, null));
  assert.deepEqual(result, { outcome: "not-held", tier: null });
  assert.deepEqual(fixture.calls, []);
});

test("an account still paying underneath the grant is told what it is actually on", async () => {
  /*
    Rare, and the reason the route sends a tier at all: a promo grant is the more
    generous row, so it is the one answering while a paid Tracking subscription
    sits underneath it. "You are on the free plan now" would be false for the one
    person in the exchange who is paying us.
  */
  const fixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("ai", "promo"),
    resolveAfter: entitlementOf("tracking", "stripe"),
  });
  const result = await against(fixture, () => promo.releasePromo(USER, EMAIL));
  assert.deepEqual(result, { outcome: "released", tier: "tracking" });
});

/* ------------------------------------------------------------------------- */
/* Reversible for the learner, final for the owner                            */

test("a trial the learner gave up is offered again", async () => {
  const fixture = fakeSupabase({ statuses: ["paused"], entitlement: entitlementOf("free", "default") });
  const offer = await against(fixture, () => promo.promoOfferFor(USER, EMAIL));
  assert.equal(offer.offered, true);
  assert.equal(offer.reason, "offered");
});

test("a trial the owner ended is never offered again", async () => {
  const fixture = fakeSupabase({ statuses: ["canceled"], entitlement: entitlementOf("free", "default") });
  const offer = await against(fixture, () => promo.promoOfferFor(USER, EMAIL));
  assert.equal(offer.offered, false);
  assert.equal(offer.reason, "already-decided");
  // Nothing is granting AI here either — the row is dead, not standing.
  assert.equal(offer.grantHeld, false);
});

test("the owner's sweep still ends it for an account that had given it up", async () => {
  /*
    The consequence the pull request has to spell out: the sweep must reach
    paused rows as well as live ones. Once it has, this account is in the same
    place as everybody else — over, and never offered again.
  */
  const swept = fakeSupabase({ statuses: ["canceled"], entitlement: entitlementOf("free", "default") });
  const offer = await against(swept, () => promo.promoOfferFor(USER, EMAIL));
  assert.equal(offer.offered, false);
  assert.equal(await against(swept, () => promo.acceptPromo(USER, EMAIL)), "ended");
  assert.deepEqual(swept.writes().filter((c) => c.method !== "POST" || c.body?.user_id === USER), []);
});

test("one canceled row anywhere on the account settles it, whatever else is there", async () => {
  const fixture = fakeSupabase({
    statuses: ["paused", "canceled"],
    entitlement: entitlementOf("free", "default"),
  });
  const offer = await against(fixture, () => promo.promoOfferFor(USER, EMAIL));
  assert.equal(offer.offered, false, "a duplicate row must not resurrect a withdrawn trial");
});

test("starting it again revives the paused row instead of writing a second grant", async () => {
  const fixture = fakeSupabase({ statuses: ["paused"], entitlement: entitlementOf("free", "default") });
  const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
  assert.equal(outcome, "granted");

  const writes = fixture.writes().filter((c) => c.body?.user_id !== "00000000-0000-0000-0000-000000000000");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PATCH", "a second row would leave two grants on one account");
  assert.match(writes[0].path, /status=eq\.paused/, "only a released row may be revived");
  assert.equal(writes[0].body.status, "active");
});

test("the owner's sweep landing mid-request wins over a restart", async () => {
  /*
    The learner read an offer that was true when it was drawn. Between the read
    and the write the sweep set their row to 'canceled', so the conditional
    UPDATE matches nothing — and that has to answer "ended" rather than fall
    through to an insert.
  */
  const fixture = fakeSupabase({ statuses: ["canceled"], entitlement: entitlementOf("free", "default") });
  const outcome = await against(fixture, () =>
    // The read that would have said "released" is skipped; this is the write.
    import(pathToFileURL(join(root, "lib", "auth", "supabase.ts")).href).then((supabase) =>
      supabase.resumePromoSubscription(USER),
    ),
  );
  assert.equal(outcome, "no-match");
});

test("a first-time accept still inserts, and still says paused rows are different", async () => {
  const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default") });
  const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
  assert.equal(outcome, "granted");
  const inserts = fixture.writes().filter((c) => c.method === "POST" && c.body?.user_id === USER);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].body.status, "active");
  assert.equal(inserts[0].body.tier, "ai");
});

/* ------------------------------------------------------------------------- */
/* Degrading when the widening ALTER has not been run                         */

test("with the provider check still narrow, nothing is offered and no release is claimed", async () => {
  const offerFixture = fakeSupabase({
    statuses: [],
    entitlement: entitlementOf("free", "default"),
    providerAllowed: false,
  });
  const offer = await against(offerFixture, () => promo.promoOfferFor(USER, EMAIL));
  assert.equal(offer.offered, false);
  assert.equal(offer.reason, "not-open");
  assert.equal(offer.grantHeld, false);

  /*
    And if the widening is rolled back under a grant that is still standing, the
    learner is told we could not do it rather than told it worked. Postgres
    re-checks the row's constraints on update, provider included.
  */
  const releaseFixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("ai", "promo"),
    providerAllowed: false,
  });
  const result = await against(releaseFixture, () => promo.releasePromo(USER, EMAIL));
  assert.deepEqual(result, { outcome: "not-open", tier: null });
});

test("the trial itself granting AI is what the give-up control is drawn from", async () => {
  const held = fakeSupabase({ statuses: ["active"], entitlement: entitlementOf("ai", "promo") });
  assert.equal((await against(held, () => promo.promoOfferFor(USER, EMAIL))).grantHeld, true);

  for (const source of ["stripe", "apple", "role"]) {
    const paid = fakeSupabase({
      statuses: [],
      entitlement: entitlementOf(source === "role" ? "admin" : "ai", source),
    });
    const offer = await against(paid, () => promo.promoOfferFor(USER, EMAIL));
    assert.equal(offer.grantHeld, false, `${source} must not be offered a way to give up a trial`);
    // Already having it by a paid subscription or by role reads the same way
    // to the poster as an AI subscriber does: nothing to offer, and said so.
    assert.equal(offer.offered, false);
    assert.equal(offer.reason, "already-ai");
  }
});

/* ------------------------------------------------------------------------- */
/* The route, and where the button is                                         */

const route = code(read("app", "api", "billing", "promo", "route.ts"));
const section = read("components", "billing", "GiveUpFreeProSection.tsx");
const panel = code(read("components", "AccountPanel.tsx"));

test("giving up is a method on the trial's own route, wrapped in CORS", () => {
  assert.match(route, /export const DELETE = withCors\(handleDELETE\)/);
  // The preflight already lists DELETE; a method missing from it is rejected by
  // the browser in the iOS WebView before it reaches BandUp.
  assert.match(code(read("lib", "http", "cors.ts")), /Allow-Methods.*DELETE|DELETE, OPTIONS/s);
});

test("the client chooses nothing but the verb", () => {
  // No body is read on any method of this route: not the tier, not the account.
  assert.doesNotMatch(route, /req\.json\(\)/);
  assert.match(route, /releasePromo\(user\.id, user\.email \?\? null\)/);
});

test("no raw database or provider text can reach the caller", () => {
  /*
    ACCOUNTS.md, threat 7. Every failure exit of DELETE is one of the fixed
    sentences, and the detail goes to the log instead.
  */
  const deleteBody = /async function handleDELETE[\s\S]*?\n}/.exec(route)[0];
  const errors = deleteBody.match(/safeJsonError\([^)]*\)/g) ?? [];
  assert.ok(errors.length >= 3, `expected the failure paths to answer, saw ${errors.length}`);
  for (const call of errors) assert.match(call, /PROMO_MESSAGES\./);
  assert.match(deleteBody, /logInternal\("billing\/promo\/release", err\)/);
});

test("the way out is mounted where the way in can reach it", () => {
  assert.match(panel, /import GiveUpFreeProSection from "@\/components\/billing\/GiveUpFreeProSection"/);
  assert.match(panel, /<GiveUpFreeProSection onChanged=\{onPlanChanged\} \/>/);
  /*
    app/account ships in the iOS bundle and app/billing does not, so the account
    page is the only place the exit can sit and still be reachable by somebody
    who accepted the trial in the app. If that list ever grows to include the
    account page, this mount has to move.
  */
  const mobile = read("scripts", "build-mobile.mjs");
  assert.doesNotMatch(mobile, /join\("app", "account"\)/);
});

test("the card says what happens, and does not argue with the reader", () => {
  /*
    Comments stripped first, and not as ceremony: the file's header says in prose
    that the card has no "are you sure", and the first draft of this test passed
    the header and failed the pressure check on the sentence promising there was
    no pressure. Whitespace-normalised too, because JSX wraps a sentence wherever
    the line runs long.
  */
  const words = code(section).replace(/\s+/g, " ");
  assert.match(words, /give the trial up here/);
  assert.match(words, /Everything you have written or practised stays exactly where it is/);
  assert.match(words, /start the trial again/i);
  assert.match(words, /Give up my free AI trial/, "the owner's phrasing");

  for (const pattern of [
    /are you sure/i,
    /\byou will lose\b/i,
    /\bmiss out\b/i,
    /\bdowngrade\b/i,
    /\blast chance\b/i,
    /\bwe['’]re sad\b/i,
    /\binstead[,]? why not\b/i,
  ]) {
    assert.doesNotMatch(words, pattern, `the exit pressures the reader: ${pattern}`);
  }
});

test("the release forgets the dismissal, or the offer could never be taken again", () => {
  /*
    The poster hides itself on a device once it has been answered there. Leaving
    that flag set after a release would leave the account offered a trial with
    nowhere to accept it.
  */
  const source = code(section);
  assert.match(source, /forgetDecision\(\)/);
  const dismissal = code(read("lib", "billing", "free-pro-dismissal.ts"));
  assert.match(dismissal, /removeItem\(DISMISSED_KEY\)/);
  // One definition of the key, read by both files.
  assert.doesNotMatch(code(read("components", "billing", "FreeProPoster.tsx")), /bandup\.promo/);
});

/* ------------------------------------------------------------------------- */
/* assertServerOnly(MODULE): every entry point refuses a browser context.     */

/*
  assertServerOnly only throws once `window` exists, which node:test's global
  scope never does — so every call above to promoOfferFor, acceptPromo and
  releasePromo has run past that guard without ever exercising it, and a
  dropped `assertServerOnly(MODULE)` call would be invisible to all of them.
  Forcing `window` to exist here proves both that the call still runs and
  that MODULE still names this file, since the thrown message is
  `${MODULE} is server-only...`.
*/
test("every export refuses to run once a window exists, naming this exact module", async () => {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    const refusesInBrowser = /lib\/billing\/promo\.ts is server-only and must not be imported from a client component\./;
    assert.throws(() => promo.promoOffersOpen(), refusesInBrowser);
    await assert.rejects(() => promo.promoWriteSupported(), refusesInBrowser);
    await assert.rejects(() => promo.promoOfferFor(USER, EMAIL), refusesInBrowser);
    await assert.rejects(() => promo.payingWhileFree(USER, EMAIL), refusesInBrowser);
    await assert.rejects(() => promo.acceptPromo(USER, EMAIL), refusesInBrowser);
    await assert.rejects(() => promo.releasePromo(USER, EMAIL), refusesInBrowser);
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

/* ------------------------------------------------------------------------- */
/* nativePromoAuthority(): the domain override alone is not enough.          */

/*
  promoWriteSupported is used rather than promoOfferFor/acceptPromo here on
  purpose: it is the one exported function whose own logic never calls
  resolveEntitlement, so setting the billing_entitlement_runtime domain to
  'cloudflare' for this test cannot also silently move entitlement reads onto
  D1 and confuse what is actually being proved.
*/
test("nativePromoAuthority needs both the domain override and the explicit native switch, not either alone", async () => {
  // The domain is ready but the native Stripe-billing switch is not: the
  // probe must still go to Supabase.
  await withEnv(
    { CLOUDFLARE_DATA_MODE_BILLING_ENTITLEMENT_RUNTIME: "cloudflare", CLOUDFLARE_NATIVE_STRIPE_BILLING: undefined },
    async () => {
      const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: true });
      const result = await against(fixture, () => promo.promoWriteSupported());
      assert.equal(result, true);
      assert.ok(fixture.calls.length > 0, "the capability probe must still ask Supabase");
    },
  );

  // Both switches set: the probe must reach D1 instead, and Supabase must
  // never be asked anything at all.
  await withEnv(
    { CLOUDFLARE_DATA_MODE_BILLING_ENTITLEMENT_RUNTIME: "cloudflare", CLOUDFLARE_NATIVE_STRIPE_BILLING: "1" },
    () => withCloudflareContext(async () => {
      const saved = globalThis.fetch;
      globalThis.fetch = async (url) => { throw new Error(`must not call Supabase natively: ${url}`); };
      promo.forgetPromoCapability();
      try {
        assert.equal(await promo.promoWriteSupported(), true, "an empty D1 must still answer the probe without throwing");
      } finally {
        globalThis.fetch = saved;
        promo.forgetPromoCapability();
      }
    }),
  );
});

test("promoWriteSupported's native probe reports the D1 answer honestly, success and failure alike", async () => {
  await withEnv(
    { CLOUDFLARE_DATA_MODE_BILLING_ENTITLEMENT_RUNTIME: "cloudflare", CLOUDFLARE_NATIVE_STRIPE_BILLING: "1" },
    async () => {
      // No Cloudflare context at all: the probe itself throws, and that must
      // report "no" — not the throw itself, and not a stray "yes".
      promo.forgetPromoCapability();
      delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
      assert.equal(await promo.promoWriteSupported(0), false);

      // A live (empty) D1: the probe resolves cleanly, and that must report
      // "yes" — the capability describes the schema, not this one account.
      promo.forgetPromoCapability();
      await withCloudflareContext(async () => {
        assert.equal(await promo.promoWriteSupported(100_000), true);
      });
    },
  );
});

/* ------------------------------------------------------------------------- */
/* Whether the trial is offered at all, and to whom.                         */

test("promoOffersOpen reads FREE_PRO_TRIAL_OPEN, closed only when it is exactly \"0\"", async () => {
  await withEnv({ FREE_PRO_TRIAL_OPEN: undefined }, () => {
    assert.equal(promo.promoOffersOpen(), true, "unset must default to open");
  });
  await withEnv({ FREE_PRO_TRIAL_OPEN: "0" }, () => {
    assert.equal(promo.promoOffersOpen(), false);
  });
  await withEnv({ FREE_PRO_TRIAL_OPEN: "1" }, () => {
    assert.equal(promo.promoOffersOpen(), true, "any value other than the literal \"0\" leaves it open");
  });
  await withEnv({ FREE_PRO_TRIAL_OPEN: "" }, () => {
    assert.equal(promo.promoOffersOpen(), true, "an empty string is not the literal \"0\" either");
  });
});

test("promoWriteSupported is false immediately once the trial is switched off, with no probe attempted", async () => {
  await withEnv({ FREE_PRO_TRIAL_OPEN: "0" }, async () => {
    const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: true });
    const result = await against(fixture, () => promo.promoWriteSupported());
    assert.equal(result, false);
    assert.deepEqual(fixture.calls, [], "no probe when the trial is switched off");
  });
});

test("the capability probe caches a refusal for exactly NEGATIVE_TTL_MS and a yes forever", async () => {
  const notAllowed = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: false });
  const allowed = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: true });
  await withEnv(CONFIG, async () => {
    const saved = globalThis.fetch;
    promo.forgetPromoCapability();
    try {
      globalThis.fetch = notAllowed.fetch;
      assert.equal(await promo.promoWriteSupported(1_000_000), false);
      const afterFirstProbe = notAllowed.calls.length;
      assert.ok(afterFirstProbe >= 1, "the first call must actually probe");

      // Still inside the negative TTL: the cached refusal is reused.
      assert.equal(await promo.promoWriteSupported(1_000_000 + 59_999), false);
      assert.equal(notAllowed.calls.length, afterFirstProbe, "cached refusal reused, no new probe");

      // Swap the backend before crossing the boundary: only a genuine
      // re-probe, not a stale cache, would ever see this answer change.
      globalThis.fetch = allowed.fetch;
      assert.equal(
        await promo.promoWriteSupported(1_000_000 + 60_000),
        true,
        "the TTL elapsed at exactly NEGATIVE_TTL_MS: the comparison must be strict",
      );
      assert.equal(allowed.calls.length, 1, "the re-probe reached the (now allowing) backend");

      // From here on a yes is cached forever — even a backend that would now
      // refuse must not be asked again.
      globalThis.fetch = notAllowed.fetch;
      const beforeFinal = notAllowed.calls.length;
      assert.equal(await promo.promoWriteSupported(999_999_999_999), true);
      assert.equal(notAllowed.calls.length, beforeFinal, "a cached yes never re-probes");
    } finally {
      globalThis.fetch = saved;
      promo.forgetPromoCapability();
    }
  });
});

test("a signed-out reader gets a fixed, fully-false offer, without reaching the database", async () => {
  const fixture = fakeSupabase({ entitlement: entitlementOf("free", "default") });
  const offer = await against(fixture, () => promo.promoOfferFor(null, null));
  assert.deepEqual(offer, { offered: false, reason: "signed-out", grantHeld: false });
  assert.deepEqual(fixture.calls, [], "a signed-out caller must never reach the database");
});

test("an account that has never touched the trial is offered it", async () => {
  const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default") });
  const offer = await against(fixture, () => promo.promoOfferFor(USER, EMAIL));
  assert.deepEqual(offer, { offered: true, reason: "offered", grantHeld: false });
});

/* ------------------------------------------------------------------------- */
/* payingWhileFree: fires for a real payer, never for a role, a grant, or a   */
/* signed-out caller.                                                        */

test("payingWhileFree only ever short-circuits for a signed-out caller, never for a real account", async () => {
  const fixture = fakeSupabase({ entitlement: entitlementOf("ai", "stripe") });
  const result = await against(fixture, () => promo.payingWhileFree(USER, EMAIL));
  assert.equal(result, true, "a real paying account must reach the actual check, not a hard-coded false");
});

test("payingWhileFree fires only for an actual paying provider, not a role or a grant", async () => {
  for (const [tier, source, expected] of [
    ["admin", "role", false],
    ["ai", "promo", false],
    ["free", "default", false],
    ["ai", "stripe", true],
    ["tracking", "apple", true],
  ]) {
    const fixture = fakeSupabase({ entitlement: entitlementOf(tier, source) });
    const result = await against(fixture, () => promo.payingWhileFree(USER, EMAIL));
    assert.equal(result, expected, `source=${source} tier=${tier}`);
  }
});

/* ------------------------------------------------------------------------- */
/* acceptPromo: every branch of the state machine, not only the happy path.  */

test("acceptPromo short-circuits to 'already-ai' for a tier that already has it, asking nothing further", async () => {
  for (const [tier, source] of [["ai", "stripe"], ["admin", "role"]]) {
    const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf(tier, source) });
    const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
    assert.equal(outcome, "already-ai");
    const beyondEntitlement = fixture.calls.filter((c) => !c.path.startsWith("/rest/v1/rpc/resolve_entitlement"));
    assert.deepEqual(beyondEntitlement, [], "nothing beyond the entitlement check should be asked");
  }
});

test("acceptPromo refuses immediately as 'not-open' when the trial cannot be written at all, without reading any promo row", async () => {
  const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: false });
  const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
  assert.equal(outcome, "not-open");
  const stateReads = fixture.calls.filter((c) => c.method === "GET" && c.path.startsWith("/rest/v1/subscriptions"));
  assert.deepEqual(stateReads, [], "must not read the promo row when writing is not possible at all");
});

test("acceptPromo answers 'already-ai' for a still-holding grant, even reached by an inconsistent read", async () => {
  /*
    entitlement and statuses are set independently on purpose (see
    fakeSupabase above). This is the one combination promo.ts's own comment on
    the "holding" branch calls unreachable "while the entitlement above is
    authoritative" — worth proving anyway, since a defensive branch nobody
    can reach is also a branch nobody would notice breaking.
  */
  const fixture = fakeSupabase({ statuses: ["active"], entitlement: entitlementOf("tracking", "stripe") });
  const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
  assert.equal(outcome, "already-ai");
});

test("acceptPromo reports 'ended' when the owner's sweep wins the race with a resume", async () => {
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(CONFIG.SUPABASE_URL, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (path.startsWith("/rest/v1/rpc/resolve_entitlement")) {
      return jsonResponse(entitlementOf("free", "default"));
    }
    // The capability probe: the impossible all-zero uuid, answered "allowed"
    // so the test is about the resume race, not about this probe.
    if (method === "POST" && body?.user_id === "00000000-0000-0000-0000-000000000000") {
      return refusal("23503", 'violates foreign key constraint "subscriptions_user_id_fkey"');
    }
    if (path.startsWith("/rest/v1/subscriptions") && method === "GET") {
      // promoState() sees a released row: as far as the read goes, the
      // account may take the trial again.
      return jsonResponse([{ status: "paused" }]);
    }
    if (path.startsWith("/rest/v1/subscriptions") && method === "PATCH") {
      // The owner's sweep already flipped it to 'canceled' by the time this
      // conditional UPDATE runs, so nothing matches its WHERE clause.
      return jsonResponse([]);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const outcome = await against({ fetch: fetchStub, calls }, () => promo.acceptPromo(USER, EMAIL));
  assert.equal(outcome, "ended");
});

test("resuming forgets a stale capability cache when its own write hits the provider check", async () => {
  const primer = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: true });
  const resumeUnsupported = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(CONFIG.SUPABASE_URL, "");
    if (path.startsWith("/rest/v1/rpc/resolve_entitlement")) return jsonResponse(entitlementOf("free", "default"));
    if (path.startsWith("/rest/v1/subscriptions") && method === "GET") return jsonResponse([{ status: "paused" }]);
    if (path.startsWith("/rest/v1/subscriptions") && method === "PATCH") {
      return refusal("23514", 'violates check constraint "subscriptions_provider_check"');
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const stale = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: false });

  await withEnv(CONFIG, async () => {
    const saved = globalThis.fetch;
    promo.forgetPromoCapability();
    try {
      globalThis.fetch = primer.fetch;
      assert.equal(await promo.promoWriteSupported(), true, "primed: cached yes");

      globalThis.fetch = resumeUnsupported;
      assert.equal(await promo.acceptPromo(USER, EMAIL), "not-open");

      globalThis.fetch = stale.fetch;
      assert.equal(
        await promo.promoWriteSupported(),
        false,
        "a resume's own provider-check failure must drop the stale cached yes",
      );
    } finally {
      globalThis.fetch = saved;
      promo.forgetPromoCapability();
    }
  });
});

/*
  acceptPromo checks resumed against "changed", then "no-match", then
  "unsupported", each an early return of its own — so a released row whose
  resume attempt fails for neither of the first two reasons is the only way
  to prove the third check actually gates on "unsupported" rather than
  answering the same way regardless of what resumed holds.
*/
test("a resume that fails plainly (neither a race nor an unsupported write) reports 'failed', not 'not-open'", async () => {
  const fixture = fakeSupabase({ statuses: ["paused"], entitlement: entitlementOf("free", "default") });
  const baseFetch = fixture.fetch;
  fixture.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(CONFIG.SUPABASE_URL, "");
    if (method === "PATCH" && path.startsWith("/rest/v1/subscriptions")) {
      throw new Error("network blip");
    }
    return baseFetch(url, init);
  };
  const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
  assert.equal(outcome, "failed");
});

test("a fresh accept reports every insert outcome honestly, and forgets a stale cache when unsupported", async () => {
  for (const [failure, expectedOutcome] of [
    [refusal("23505", "duplicate key value violates unique constraint"), "already-ai"],
    [refusal("22003", "numeric field overflow"), "failed"],
  ]) {
    const calls = [];
    const fetchStub = async (url, init = {}) => {
      const method = init.method ?? "GET";
      const path = String(url).replace(CONFIG.SUPABASE_URL, "");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path, body });
      if (path.startsWith("/rest/v1/rpc/resolve_entitlement")) return jsonResponse(entitlementOf("free", "default"));
      // The capability probe: the impossible all-zero uuid, answered
      // "allowed" so the loop below is only ever about the real insert.
      if (method === "POST" && body?.user_id === "00000000-0000-0000-0000-000000000000") {
        return refusal("23503", 'violates foreign key constraint "subscriptions_user_id_fkey"');
      }
      if (path.startsWith("/rest/v1/subscriptions") && method === "GET") return jsonResponse([]);
      if (path.startsWith("/rest/v1/subscriptions") && method === "POST") return failure;
      throw new Error(`unexpected ${method} ${path}`);
    };
    const outcome = await against({ fetch: fetchStub, calls }, () => promo.acceptPromo(USER, EMAIL));
    assert.equal(outcome, expectedOutcome);
  }

  // The unsupported case specifically must also drop a stale cached "yes" —
  // a schema that narrowed again between the probe and this very insert.
  const primer = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: true });
  const insertUnsupported = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(CONFIG.SUPABASE_URL, "");
    if (path.startsWith("/rest/v1/rpc/resolve_entitlement")) return jsonResponse(entitlementOf("free", "default"));
    if (path.startsWith("/rest/v1/subscriptions") && method === "GET") return jsonResponse([]);
    if (path.startsWith("/rest/v1/subscriptions") && method === "POST") {
      return refusal("23514", 'violates check constraint "subscriptions_provider_check"');
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const stale = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: false });

  await withEnv(CONFIG, async () => {
    const saved = globalThis.fetch;
    promo.forgetPromoCapability();
    try {
      globalThis.fetch = primer.fetch;
      assert.equal(await promo.promoWriteSupported(), true, "primed: cached yes");

      globalThis.fetch = insertUnsupported;
      assert.equal(await promo.acceptPromo(USER, EMAIL), "not-open");

      globalThis.fetch = stale.fetch;
      assert.equal(
        await promo.promoWriteSupported(),
        false,
        "a fresh insert's own provider-check failure must drop the stale cached yes",
      );
    } finally {
      globalThis.fetch = saved;
      promo.forgetPromoCapability();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* releasePromo: the failure exit, and the same stale-cache rule as accept.  */

test("releasePromo reports 'failed' plainly rather than continuing past a write failure", async () => {
  const fixture = fakeSupabase({ statuses: ["active"], entitlement: entitlementOf("ai", "promo") });
  const baseFetch = fixture.fetch;
  fixture.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(CONFIG.SUPABASE_URL, "");
    if (method === "PATCH" && path.startsWith("/rest/v1/subscriptions")) {
      throw new Error("network blip");
    }
    return baseFetch(url, init);
  };
  const result = await against(fixture, () => promo.releasePromo(USER, EMAIL));
  assert.deepEqual(result, { outcome: "failed", tier: null });
});

test("releasing forgets a stale capability cache when its own write hits the provider check", async () => {
  const primer = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: true });
  const releaseUnsupported = fakeSupabase({
    statuses: ["active"], entitlement: entitlementOf("ai", "promo"), providerAllowed: false,
  });
  const stale = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default"), providerAllowed: false });

  await withEnv(CONFIG, async () => {
    const saved = globalThis.fetch;
    promo.forgetPromoCapability();
    try {
      globalThis.fetch = primer.fetch;
      assert.equal(await promo.promoWriteSupported(), true, "primed: cached yes");

      globalThis.fetch = releaseUnsupported.fetch;
      const result = await promo.releasePromo(USER, EMAIL);
      assert.deepEqual(result, { outcome: "not-open", tier: null });

      globalThis.fetch = stale.fetch;
      assert.equal(
        await promo.promoWriteSupported(),
        false,
        "a release's own provider-check failure must drop the stale cached yes",
      );
    } finally {
      globalThis.fetch = saved;
      promo.forgetPromoCapability();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* mirrorPromoBestEffort: the Cloudflare side of a grant.                     */

test("mirroring to Cloudflare is skipped entirely when this deployment is not mirroring writes (the default)", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: undefined }, async () => {
    const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default") });
    const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
    assert.equal(outcome, "granted");
    const replicaReads = fixture.calls.filter((c) => c.method === "GET" && /order=created_at\.desc/.test(c.path));
    assert.deepEqual(replicaReads, [], "no D1 mirror read should be attempted when mirrorsWritesToCloudflare() is false");
  });
});

test("mirrorPromoBestEffort logs plainly when there is no row yet to mirror", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default") });
    const baseFetch = fixture.fetch;
    fixture.fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      const path = String(url).replace(CONFIG.SUPABASE_URL, "");
      if (method === "GET" && path.startsWith("/rest/v1/subscriptions") && path.includes("order=created_at.desc")) {
        return jsonResponse([]);
      }
      return baseFetch(url, init);
    };
    const messages = await captureConsoleError(async () => {
      const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
      assert.equal(outcome, "granted");
    });
    assert.ok(
      messages.includes("[accounts] billing/promo Cloudflare replica: no row to mirror after insert"),
      `expected the "no row to mirror" log, saw: ${JSON.stringify(messages)}`,
    );
  });
});

test("mirrorPromoBestEffort logs plainly when the replica write itself fails", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const now = "2026-08-17T00:00:00.000Z";
    const fixture = fakeSupabase({ statuses: [], entitlement: entitlementOf("free", "default") });
    const baseFetch = fixture.fetch;
    fixture.fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      const path = String(url).replace(CONFIG.SUPABASE_URL, "");
      if (method === "GET" && path.startsWith("/rest/v1/subscriptions") && path.includes("order=created_at.desc")) {
        return jsonResponse([{
          id: "row-1",
          user_id: USER,
          status: "active",
          tier: "ai",
          current_period_end: null,
          raw: { kind: "free-ai-trial", acceptedAt: now },
          verified_at: now,
          created_at: now,
          updated_at: now,
        }]);
      }
      return baseFetch(url, init);
    };
    // No Cloudflare context: replicatePromoSubscriptionDurably resolves false
    // (bindings unavailable) without throwing, which is exactly the "found a
    // row but the D1 write itself failed" case this proves.
    delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    const messages = await captureConsoleError(async () => {
      const outcome = await against(fixture, () => promo.acceptPromo(USER, EMAIL));
      assert.equal(outcome, "granted");
    });
    assert.ok(
      messages.includes("[accounts] billing/promo Cloudflare replica: replica write returned false"),
      `expected the replica-write-failed log, saw: ${JSON.stringify(messages)}`,
    );
  });
});

/*
  ---------------------------------------------------------------------------
  Left alone, deliberately.

  A few surviving mutants over lib/billing/promo.ts are not exercised above
  because no input the exported functions can receive reaches them:

    - NATIVE_PROBE_USER's exact string (the all-zero uuid) only reaches
      nativePromoSubscriptionState() inside `.then(() => true).catch(() =>
      false)`, which maps *any* non-throwing resolution to `true` regardless
      of what the query answered. A SELECT against a non-existent id resolves
      rather than throws for both the real id and an empty string, so
      promoWriteSupported()'s result cannot depend on which one was used.
    - the `if (state === "holding")` branch's own reachability is proved
      above; forgetPromoCapability() not being called on that path has no
      mutant of its own to kill.
    - mirrorPromoBestEffort's `catch (error)` block (and both of its template
      strings): promoSubscriptionReplica and replicatePromoSubscriptionDurably
      both swallow every internal error and resolve to null/false rather than
      reject (the same shape lib/billing/subscriptions.ts's
      replicateBillingBestEffort uses), so nothing this function calls can
      make it throw.
    - promoWriteSupported's own `assertServerOnly(MODULE)` call: the very next
      line unconditionally calls promoOffersOpen(), which starts with the
      identical guard against the identical module name. Dropping the first
      call cannot be observed from outside — the second one throws exactly
      the same error either way.
*/
