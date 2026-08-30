/*
  Giving the free Pro trial up.

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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

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

/* ------------------------------------------------------------------------- */
/* What the release writes                                                    */

test("giving it up pauses the grant — it does not write the owner's 'canceled'", async () => {
  const fixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("pro", "promo"),
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
    entitlement: entitlementOf("pro", "promo"),
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
    entitlement: entitlementOf("pro", "promo"),
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
  ["pro", "stripe", "a Stripe subscriber"],
  ["pro", "apple", "an App Store subscriber"],
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
    generous row, so it is the one answering while a paid Plus subscription sits
    underneath it. "You are on the free plan now" would be false for the one
    person in the exchange who is paying us.
  */
  const fixture = fakeSupabase({
    statuses: ["active"],
    entitlement: entitlementOf("pro", "promo"),
    resolveAfter: entitlementOf("plus", "stripe"),
  });
  const result = await against(fixture, () => promo.releasePromo(USER, EMAIL));
  assert.deepEqual(result, { outcome: "released", tier: "plus" });
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
  assert.equal(inserts[0].body.tier, "pro");
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
    entitlement: entitlementOf("pro", "promo"),
    providerAllowed: false,
  });
  const result = await against(releaseFixture, () => promo.releasePromo(USER, EMAIL));
  assert.deepEqual(result, { outcome: "not-open", tier: null });
});

test("the trial itself granting Pro is what the give-up control is drawn from", async () => {
  const held = fakeSupabase({ statuses: ["active"], entitlement: entitlementOf("pro", "promo") });
  assert.equal((await against(held, () => promo.promoOfferFor(USER, EMAIL))).grantHeld, true);

  for (const source of ["stripe", "apple", "role"]) {
    const paid = fakeSupabase({
      statuses: [],
      entitlement: entitlementOf(source === "role" ? "admin" : "pro", source),
    });
    const offer = await against(paid, () => promo.promoOfferFor(USER, EMAIL));
    assert.equal(offer.grantHeld, false, `${source} must not be offered a way to give up a trial`);
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
  assert.match(words, /Give up my free Pro trial/, "the owner's phrasing");

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
