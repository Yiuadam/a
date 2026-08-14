/*
  Cross-device sync in production goes through a Postgres function that, if a
  migration has not been applied, PostgREST 404s and lib/auth/supabase.ts
  turns into { status: "unavailable" }. The route then 503s every PUT while
  GET keeps working fine. These checks guard the three changes that make that
  survivable and visible rather than silent and total:

    1. A failed upload must not discard the successful download — sync.ts
       used to return before writing the merge it had just computed, so a
       device that could read the account but not write to it showed nothing
       at all.
    2. That one exception is a history clear: a clear the server never
       confirmed must keep leaving the browser's real history untouched,
       exactly as it did before.
    3. The route's several 503/413s must carry a machine-readable `reason` a
       client can act on, without leaking any upstream error text through it.
    4. `lastSyncedAt` must actually be read somewhere a learner can see it, or
       a permanently failing sync stays as invisible as the one that shipped.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const PROFILE_KEY = "ielts-prep-v1";
const SESSION_KEY = "bandup.session.v1";

const durable = new Map([
  [
    SESSION_KEY,
    JSON.stringify({
      accessToken: "resilience-test-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    }),
  ],
]);
const perTab = new Map();

const shelf = (map) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
});

const dispatchedStorageKeys = [];

globalThis.window = {
  localStorage: shelf(durable),
  sessionStorage: shelf(perTab),
  dispatchEvent: (event) => {
    if (event.type === "storage") dispatchedStorageKeys.push(event.key);
    return true;
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.StorageEvent = class StorageEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.key = init.key ?? null;
  }
};

let remoteSnapshots = [];
// Controls the stubbed server for the PUT half of a sync round trip. GET
// always succeeds here — the real bug this guards leaves GET untouched and
// fails only the write, which is exactly the shape that used to lose data.
let putShouldFail = false;

globalThis.fetch = async (_input, init = {}) => {
  assert.equal(new Headers(init.headers).get("Authorization"), "Bearer resilience-test-token");
  const method = init.method ?? "GET";
  if (method === "GET") {
    return Response.json({ snapshots: remoteSnapshots });
  }
  assert.equal(method, "PUT");
  if (putShouldFail) {
    // Shaped like the route's real write-unavailable response (see FIX 2
    // below) — a 503 with no body the client should ever need to parse to
    // know the write did not land.
    return Response.json(
      { error: "Account details aren't available right now. Please try again in a minute.", reason: "write-unavailable" },
      { status: 503 },
    );
  }
  return Response.json({ at: "2026-08-14T09:00:00.000Z" });
};

const { syncProgress, clearSyncedProgress, lastSyncedAt, lastSyncFailed } = await import(
  pathToFileURL(join(root, "lib", "progress", "sync.ts")).href
);

test("a failed PUT still writes the merged download locally instead of discarding it", async () => {
  perTab.set(PROFILE_KEY, JSON.stringify({ visited: ["reading"], results: [], genTests: [] }));
  remoteSnapshots = [
    {
      storeKey: PROFILE_KEY,
      payload: { visited: ["listening"], results: [], genTests: [] },
      clientUpdatedAt: "2026-08-13T10:00:00.000Z",
    },
  ];
  putShouldFail = true;
  const dispatchedBefore = dispatchedStorageKeys.length;

  const outcome = await syncProgress();

  putShouldFail = false;
  assert.equal(outcome.status, "unavailable");

  // The merge is a superset of local state: everything the GET fetched from
  // the account must now be on this device even though the PUT never
  // confirmed. Before this fix, the local copy would still only say
  // ["reading"] — the account's "listening" would have been thrown away.
  const local = JSON.parse(perTab.get(PROFILE_KEY));
  assert.deepEqual([...local.visited].sort(), ["listening", "reading"]);

  // "the usual storage events dispatched" — useSyncExternalStore consumers
  // (the plan, the saved words) must still repaint from a failed sync.
  assert.ok(
    dispatchedStorageKeys.slice(dispatchedBefore).includes(PROFILE_KEY),
    "a failed PUT must still announce the local write like a successful one does",
  );

  // A merge sitting only in this browser is not a confirmed sync: it must not
  // be reported as one, and the failure must be recorded so the account page
  // can say so.
  assert.equal(lastSyncedAt(), null, "an unconfirmed write must not claim a sync time");
  assert.equal(lastSyncFailed(), true, "the failed attempt must be recorded for the account page");
});

test("a subsequent successful sync clears the recorded failure", async () => {
  perTab.set(PROFILE_KEY, JSON.stringify({ visited: ["reading"], results: [], genTests: [] }));
  remoteSnapshots = [
    {
      storeKey: PROFILE_KEY,
      payload: { visited: ["reading"], results: [], genTests: [] },
      clientUpdatedAt: "2026-08-13T10:00:00.000Z",
    },
  ];
  assert.equal(lastSyncFailed(), true, "starts from the failure recorded by the previous test");

  const outcome = await syncProgress();

  assert.equal(outcome.status, "done");
  assert.equal(lastSyncFailed(), false, "a confirmed sync must clear a previously recorded failure");
  assert.equal(lastSyncedAt(), "2026-08-14T09:00:00.000Z");
});

test("a failed clear-history PUT leaves the browser's working copy untouched", async () => {
  const before = JSON.stringify({
    results: [{
      module: "reading",
      testId: "kept-after-put-outage",
      testTitle: "A sitting that must survive a failed clear",
      band: 7,
      date: "2026-08-13T12:00:00.000Z",
    }],
    genTests: [],
  });
  perTab.set(PROFILE_KEY, before);
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: JSON.parse(before),
    clientUpdatedAt: "2026-08-13T12:00:00.000Z",
  }];
  putShouldFail = true;
  const dispatchedBefore = dispatchedStorageKeys.length;

  const outcome = await clearSyncedProgress("2026-08-14T09:05:00.000Z");

  putShouldFail = false;
  assert.equal(outcome.status, "unavailable");
  // This is the one case FIX 1 must not touch: `accepted` at this point holds
  // only the *hypothetical* cleared profile from step 2, and writing that
  // locally on a failed PUT would erase real history the account never agreed
  // to clear. Byte-for-byte, not just deep-equal, to catch any restamping too.
  assert.equal(
    perTab.get(PROFILE_KEY),
    before,
    "a clear the server never confirmed must not remove local history",
  );
  // The guard is about the *profile data*, not about whether this failed
  // attempt gets recorded for FIX 3 — rememberSyncHealth legitimately still
  // marks the device unsynced and announces that. What must not happen is any
  // of the three progress keys being written or announced, which is what
  // would mean the hypothetical cleared profile reached local storage.
  assert.ok(
    !dispatchedStorageKeys.slice(dispatchedBefore).includes(PROFILE_KEY),
    "a guarded clear failure must not write or announce the profile key locally",
  );
  assert.equal(lastSyncFailed(), true, "a guarded clear failure is still a failed attempt");
});

test("the PUT route gives its three failure branches a distinct, upstream-free reason", () => {
  const route = readFileSync(join(root, "app", "api", "account", "progress", "route.ts"), "utf8");

  // Each of the three branches named in the task pairs its unchanged human
  // message and unchanged status code with a new, fixed reason string.
  assert.match(
    route,
    /"That's more progress than we can store\. Please contact support\.",\s*\n?\s*413,\s*\n?\s*"too-large"/,
  );
  assert.match(
    route,
    /"History permissions could not be checked\. Nothing was changed\.",\s*\n?\s*503,\s*\n?\s*"history-policy-unavailable"/,
  );
  assert.match(
    route,
    /progressFailure\(MESSAGES\.accountUnavailable,\s*503,\s*"write-unavailable"\)/,
  );

  // The three reasons must be distinct from one another, not the same string
  // reused three times, which would put the client right back where it
  // started.
  const reasonType = route.match(/type ProgressFailureReason\s*=\s*([^;]+);/);
  assert.ok(reasonType, "the reason must be a fixed union type, not a bare string");
  const reasons = [...reasonType[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(reasons).size, reasons.length, "reasons must be distinct");
  assert.deepEqual(
    [...reasons].sort(),
    ["history-policy-unavailable", "too-large", "write-unavailable"],
  );

  // Never an upstream message forwarded through the field: a reason is built
  // only from the fixed union above, never from a caught error or a variable
  // sourced from Supabase/Cloudflare.
  assert.doesNotMatch(route, /reason:\s*[a-z][\w.?]*(?<!Reason)\b/);
});

test("lastSyncedAt now has a real consumer outside lib/, or a permanently failing sync is invisible again", () => {
  function walk(directory) {
    return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  }

  const consumers = [...walk("app"), ...walk("components")]
    .filter((path) => /\.tsx?$/.test(path))
    .filter((path) => readFileSync(join(root, path), "utf8").includes("lastSyncedAt"));

  assert.ok(
    consumers.length > 0,
    "lastSyncedAt must be read from app/ or components/ — grep -rn \"lastSyncedAt\" app/ components/ lib/ to confirm",
  );
});
