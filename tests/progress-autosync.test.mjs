/*
  The automatic half of cross-device progress sync.

  The merge itself is covered in progress-merge.test.mjs and the browser/account
  round trip in progress-sync-storage.test.mjs. These checks pin the part a
  learner actually relies on when the manual button is absent: changes are
  queued, bursts are coalesced, a temporary network failure leaves another
  trigger able to retry, and a write made during an upload earns a second pass.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const PROFILE_KEY = "ielts-prep-v1";

const durable = new Map();
const perTab = new Map([
  [
    PROFILE_KEY,
    JSON.stringify({
      results: [],
      genTests: [],
      visited: ["reading"],
    }),
  ],
]);

const shelf = (map) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
});

let nextTimer = 0;
const timers = new Map();

globalThis.window = {
  localStorage: shelf(durable),
  sessionStorage: shelf(perTab),
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  dispatchEvent() {
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { onLine: true },
});
globalThis.document = { hidden: false };

globalThis.StorageEvent = class StorageEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.key = init.key ?? null;
  }
};

let offline = false;
let requestCount = 0;
let getCount = 0;
let putCount = 0;
let blockNextGet = null;

globalThis.fetch = async (_input, init = {}) => {
  requestCount += 1;
  if (offline) throw new TypeError("offline");

  const method = init.method ?? "GET";
  const authorization = new Headers(init.headers).get("Authorization");
  assert.equal(authorization, "Bearer autosync-test-token");

  if (method === "GET") {
    getCount += 1;
    if (blockNextGet) {
      const blocker = blockNextGet;
      blockNextGet = null;
      await blocker.promise;
    }
    return Response.json({ snapshots: [] });
  }

  assert.equal(method, "PUT");
  putCount += 1;
  return Response.json({ at: "2026-08-13T12:00:00.000Z" });
};

const account = await import(pathToFileURL(join(process.cwd(), "lib", "account.ts")).href);
const autosync = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "autosync.ts")).href
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fireOnlyTimer() {
  assert.equal(timers.size, 1, "exactly one coalesced sync should be pending");
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  timer.callback();
  return timer.delay;
}

function onlyTimerDelay() {
  assert.equal(timers.size, 1, "exactly one coalesced sync should be pending");
  return timers.values().next().value.delay;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function signIn() {
  account.saveSession({
    accessToken: "autosync-test-token",
    refreshToken: null,
    expiresAt: null,
    email: "learner@example.com",
  });
}

test("automatic progress scheduling is resilient", async (t) => {
  await t.test("signed-out work never starts an account request", () => {
    account.clearSession();
    timers.clear();

    autosync.scheduleSync(25);

    assert.equal(timers.size, 0);
    assert.equal(getCount, 0);
    assert.equal(putCount, 0);
  });

  await t.test("a signed-in burst is coalesced into the newest schedule", async () => {
    signIn();
    timers.clear();

    autosync.scheduleSync(4_000);
    autosync.scheduleSync(1_000);

    assert.equal(fireOnlyTimer(), 1_000);
    await settle();
    assert.equal(getCount, 1);
    assert.equal(putCount, 1);
    assert.equal(durable.get("bandup.sync.v1"), "2026-08-13T12:00:00.000Z");
  });

  await t.test("temporary failures retry with bounded backoff and reset after success", async () => {
    timers.clear();
    const beforeRequests = requestCount;
    const beforeGets = getCount;
    const beforePuts = putCount;
    offline = true;
    autosync.scheduleSync(0);
    assert.equal(fireOnlyTimer(), 0);
    await settle();

    assert.equal(requestCount, beforeRequests + 1);
    assert.equal(getCount, beforeGets, "a failed fetch does not pretend to have reached the account");
    assert.equal(putCount, beforePuts);
    assert.match(perTab.get(PROFILE_KEY), /"reading"/, "the browser copy survives offline");
    assert.equal(onlyTimerDelay(), 10_000);

    assert.equal(fireOnlyTimer(), 10_000);
    await settle();
    assert.equal(onlyTimerDelay(), 30_000);

    assert.equal(fireOnlyTimer(), 30_000);
    await settle();
    assert.equal(onlyTimerDelay(), 120_000);

    assert.equal(fireOnlyTimer(), 120_000);
    await settle();
    assert.equal(onlyTimerDelay(), 300_000);

    assert.equal(fireOnlyTimer(), 300_000);
    await settle();
    assert.equal(onlyTimerDelay(), 300_000, "the retry delay is capped at five minutes");

    offline = false;
    assert.equal(fireOnlyTimer(), 300_000);
    await settle();

    assert.equal(getCount, beforeGets + 1);
    assert.equal(putCount, beforePuts + 1);
    assert.equal(timers.size, 0);

    // A later outage starts at the first delay again rather than inheriting
    // the previous five-minute cap.
    offline = true;
    autosync.scheduleSync(0);
    fireOnlyTimer();
    await settle();
    assert.equal(onlyTimerDelay(), 10_000);
    autosync.cancelScheduledSync();
    offline = false;
  });

  await t.test("a change during an upload earns a complete second pass", async () => {
    timers.clear();
    const beforeGets = getCount;
    const beforePuts = putCount;
    const blocker = deferred();
    blockNextGet = blocker;

    autosync.scheduleSync(0);
    fireOnlyTimer();
    await settle();
    assert.equal(getCount, beforeGets + 1);

    // This represents the debounced progress-write trigger firing while the
    // previous GET/merge/PUT cycle is still in flight.
    autosync.scheduleSync(0);
    fireOnlyTimer();
    await settle();

    blocker.resolve();
    await settle();

    // runAgain does not recurse directly; it queues one ordinary pass so a
    // subsequent write can still coalesce with it.
    assert.equal(fireOnlyTimer(), 0);
    await settle();
    assert.equal(getCount, beforeGets + 2);
    assert.equal(putCount, beforePuts + 2);
  });
});
