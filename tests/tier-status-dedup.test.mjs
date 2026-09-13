/*
  lib/billing/useTier.ts used to hold its own useState/useEffect per hook
  instance, so N components calling useTier() — directly, or transitively
  through useSessionAccess() — fired N identical GET /api/account/status
  requests on the same mount. app/practice/writing/page.tsx alone mounts
  three (its own useTier(), and one useSessionAccess() each in SkillGate and
  TestChooser). BandUp runs on the Cloudflare Workers Free plan — 100,000
  requests per day for the whole site — and that cap has already taken
  bandup.life offline twice, so a 3-4x multiplier on one of the app's most
  commonly-mounted requests is not free.

  This is the behavioural half of that fix: lib/billing/useTier.ts's fetch,
  cache and in-flight tracking now live once at module scope (see the big WHY
  comment above `statusCache` there) rather than once per hook instance.
  tests/account-status-resilience.test.mjs still pins the source text for the
  pieces that did not move (the timeout, the window/document listeners); this
  file instead imports the store's exported pieces directly and drives them —
  same style as tests/progress-autosync.test.mjs, which exercises a different
  module-level store the same way, because neither has a rendered tree for a
  test to mount.

  useTier() itself is not called here — it is a hook, and calling one outside
  a component throws. What it does on mount is exactly
  `ensureStatus(session)`, and what its retry button and its two automatic
  triggers do is exactly `retryStatus()`; driving those directly proves the
  same dedup a real render would get, without needing a DOM.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const durable = new Map();
const shelf = (map) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
});

globalThis.window = {
  localStorage: shelf(durable),
  addEventListener: () => {},
  removeEventListener: () => {},
};

let fetchCalls = 0;
/** Every fetch this test issues waits here until the test explicitly settles
 * it — the same `deferred()` shape tests/progress-autosync.test.mjs uses —
 * so "two mounts at once" is not a race against how fast a real network
 * would answer, and a "stale request superseded by a sign-out" scenario can
 * be resolved deliberately out of order. */
const pending = [];

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function popPending() {
  const d = pending.shift();
  assert.ok(d, "expected a fetch to have been issued");
  return d;
}

globalThis.fetch = async () => {
  fetchCalls += 1;
  const d = deferred();
  pending.push(d);
  return d.promise;
};

/** Flushes the microtask queue enough times for a resolved fetch's
 * `.then().then()...finally()` chain to actually run, matching the same
 * two-`setImmediate` flush tests/progress-autosync.test.mjs already uses for
 * exactly this reason. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function statusBody(overrides = {}) {
  return {
    enabled: true,
    signedIn: true,
    tier: "ai",
    usage: { windowSeconds: 2_592_000, oldestAt: null, routes: [] },
    expiresAt: null,
    renews: null,
    ...overrides,
  };
}

const account = await import(pathToFileURL(join(process.cwd(), "lib", "account.ts")).href);
const tierStore = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "useTier.ts")).href);

function signIn(token) {
  account.saveSession({ accessToken: token, refreshToken: null, expiresAt: null, email: "learner@example.com" });
}

test("shared account-status store", async (t) => {
  await t.test("two consumers mounting together share one in-flight request, and a third mount later reuses the cache", async () => {
    signIn("dedup-token-1");
    const before = fetchCalls;

    // Two components mounting on the same render: each hook instance's own
    // effect calls ensureStatus with the same session.
    tierStore.ensureStatus(account.getSnapshot());
    tierStore.ensureStatus(account.getSnapshot());

    assert.equal(fetchCalls, before + 1, "the second mount must join the first's request, not start its own");
    assert.equal(tierStore.getStatusSnapshot().phase, "loading");

    popPending().resolve(Response.json(statusBody({ tier: "ai" })));
    await settle();

    assert.equal(tierStore.getStatusSnapshot().phase, "ready");
    assert.equal(tierStore.getStatusSnapshot().tier, "ai");

    // A third, later mount of the same session must not re-ask at all.
    tierStore.ensureStatus(account.getSnapshot());
    assert.equal(fetchCalls, before + 1, "a mount with an already-cached answer must not refetch");
  });

  await t.test("signing out mid-request invalidates the cache, and the stale in-flight answer is dropped rather than shown", async () => {
    signIn("dedup-token-2");
    const before = fetchCalls;

    tierStore.ensureStatus(account.getSnapshot());
    assert.equal(fetchCalls, before + 1);
    const staleRequest = popPending();

    // The session changes while that request is still in flight.
    account.clearSession();
    tierStore.ensureStatus(account.getSnapshot());
    assert.equal(fetchCalls, before + 2, "a session change must always start a fresh request");
    assert.equal(tierStore.getStatusSnapshot().phase, "loading", "the cache resets the moment the session changes");

    // The old request for the signed-in account answers late. It must not be
    // allowed to paint the now-signed-out screen as signed in.
    staleRequest.resolve(Response.json(statusBody({ signedIn: true, tier: "ai" })));
    await settle();
    assert.equal(tierStore.getStatusSnapshot().phase, "loading", "the stale response must be discarded, not applied");

    // The fresh request for the signed-out session lands.
    popPending().resolve(Response.json(statusBody({ signedIn: false, tier: null })));
    await settle();
    assert.equal(tierStore.getStatusSnapshot().phase, "ready");
    assert.equal(
      tierStore.getStatusSnapshot().signedIn,
      false,
      "a stale signed-in answer must never be shown after sign-out",
    );
  });

  await t.test("retry joins an already-in-flight request instead of starting a second one", async () => {
    signIn("dedup-token-3");
    const before = fetchCalls;

    tierStore.ensureStatus(account.getSnapshot());
    assert.equal(fetchCalls, before + 1);

    // Two of "the browser is back online" listeners firing at once — one per
    // mounted consumer — must not become two requests.
    tierStore.retryStatus();
    tierStore.retryStatus();
    assert.equal(fetchCalls, before + 1, "retry must join the request already in flight");

    popPending().resolve(Response.json(statusBody()));
    await settle();
    assert.equal(tierStore.getStatusSnapshot().phase, "ready");
  });

  await t.test("retry still forces a fresh request when the cache already holds a ready answer", async () => {
    // Continues from the previous case's now-"ready" cache for the same
    // session — retry's whole job is to override "the cache already answers
    // this", which is the one case an ordinary mount must NOT override.
    const before = fetchCalls;

    tierStore.retryStatus();
    assert.equal(fetchCalls, before + 1, "retry must re-ask even though a cached answer already exists");
    assert.equal(tierStore.getStatusSnapshot().phase, "loading");

    popPending().resolve(Response.json(statusBody()));
    await settle();
    assert.equal(tierStore.getStatusSnapshot().phase, "ready");
  });

  await t.test("a failed request carries accountsEnabled forward instead of resetting it to false", async () => {
    signIn("dedup-token-5");
    const before = fetchCalls;

    tierStore.ensureStatus(account.getSnapshot());
    popPending().resolve(Response.json(statusBody({ tier: "tracking" })));
    await settle();
    assert.equal(tierStore.getStatusSnapshot().accountsEnabled, true);

    tierStore.retryStatus();
    assert.equal(fetchCalls, before + 2);
    popPending().resolve(new Response(null, { status: 500 }));
    await settle();

    const state = tierStore.getStatusSnapshot();
    assert.equal(state.phase, "unavailable");
    assert.equal(
      state.accountsEnabled,
      true,
      "a failure must not report accountsEnabled: false when this deployment actually has accounts",
    );
    assert.equal(state.tier, null, "every other field still resets to INITIAL on a failure");
  });
});
