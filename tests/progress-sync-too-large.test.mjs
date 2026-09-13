/*
  A device whose saved practice is over the account's 2MB sync cap
  (app/api/account/progress/route.ts's MAX_BYTES) used to be told exactly what
  a device that merely could not reach the account was told: "unavailable",
  and — on the account page — "it will try again automatically". Both are
  false for this specific failure. Retrying uploads the exact same payload and
  earns the exact same 413 every single time; nothing about waiting, or
  regaining a connection, changes that. The only thing that fixes it is a
  learner clearing some history.

  This pins the new, distinct "too-large" outcome lib/progress/sync.ts now
  reports for a 413 on the PUT, and the sentence components/AccountPanel.tsx
  now shows for it. It mirrors tests/progress-sync-resilience.test.mjs's own
  fake window/fetch harness — deliberately: this is the same file, the same
  step 3, one more status code to distinguish.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
      accessToken: "too-large-test-token",
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

globalThis.window = {
  localStorage: shelf(durable),
  sessionStorage: shelf(perTab),
  dispatchEvent: () => true,
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
/** 200 for an ordinary confirmed write, 413 for over the size cap, anything
 *  else for the generic outage progress-sync-resilience.test.mjs already
 *  covers. */
let putStatus = 200;

globalThis.fetch = async (_input, init = {}) => {
  const method = init.method ?? "GET";
  if (method === "GET") return Response.json({ snapshots: remoteSnapshots });
  assert.equal(method, "PUT");
  if (putStatus === 413) {
    // Shaped like the route's real response — see
    // app/api/account/progress/route.ts's progressFailure(..., 413, "too-large").
    return Response.json(
      { error: "That's more progress than we can store. Please contact support.", reason: "too-large" },
      { status: 413 },
    );
  }
  if (putStatus !== 200) {
    return Response.json({ error: "down", reason: "write-unavailable" }, { status: putStatus });
  }
  return Response.json({ at: "2026-09-12T09:00:00.000Z" });
};

const { syncProgress, clearSyncedProgress, lastSyncedAt, lastSyncFailed, lastSyncTooLarge } = await import(
  pathToFileURL(join(root, "lib", "progress", "sync.ts")).href
);

test("a 413 on an ordinary sync reports \"too-large\", not the generic \"unavailable\"", async () => {
  perTab.set(PROFILE_KEY, JSON.stringify({ visited: ["reading"], results: [], genTests: [] }));
  remoteSnapshots = [
    {
      storeKey: PROFILE_KEY,
      payload: { visited: ["listening"], results: [], genTests: [] },
      clientUpdatedAt: "2026-09-11T10:00:00.000Z",
    },
  ];
  putStatus = 413;

  const outcome = await syncProgress();

  assert.equal(outcome.status, "too-large");
});

test("the download is still written locally on a 413 — an ordinary sync keeps falling through to step 4", () => {
  // Same invariant progress-sync-resilience.test.mjs pins for the generic
  // failure: `merged` is a superset of what this device already had, so a
  // 413 on the upload must not throw away what the download just brought in.
  const local = JSON.parse(perTab.get(PROFILE_KEY));
  assert.deepEqual([...local.visited].sort(), ["listening", "reading"]);
});

test("a 413 is recorded as too-large, and specifically not as the ordinary failure", () => {
  assert.equal(lastSyncTooLarge(), true);
  assert.equal(lastSyncFailed(), false, "the two must not both be set — see rememberSyncHealth's WHY comment");
  assert.equal(lastSyncedAt(), null, "an unconfirmed write must not claim a sync time");
});

test("a subsequent confirmed sync clears the too-large flag", async () => {
  perTab.set(PROFILE_KEY, JSON.stringify({ visited: ["reading"], results: [], genTests: [] }));
  remoteSnapshots = [
    { storeKey: PROFILE_KEY, payload: { visited: ["reading"], results: [], genTests: [] }, clientUpdatedAt: "2026-09-11T10:00:00.000Z" },
  ];
  putStatus = 200;

  const outcome = await syncProgress();

  assert.equal(outcome.status, "done");
  assert.equal(lastSyncTooLarge(), false);
  assert.equal(lastSyncedAt(), "2026-09-12T09:00:00.000Z");
});

test("the ordinary failure and too-large flags stay mutually exclusive in both directions", async () => {
  putStatus = 413;
  await syncProgress();
  assert.equal(lastSyncTooLarge(), true);
  assert.equal(lastSyncFailed(), false);

  // An ordinary outage after a too-large device frees up space, say, must
  // replace that flag rather than merely add to it — the account page reads
  // them as one state, not two independent booleans that could both be true.
  putStatus = 503;
  await syncProgress();
  assert.equal(lastSyncFailed(), true);
  assert.equal(lastSyncTooLarge(), false, "a later, different failure must clear the stale too-large flag");

  putStatus = 200;
  await syncProgress();
  assert.equal(lastSyncFailed(), false);
  assert.equal(lastSyncTooLarge(), false);
});

test("a 413 during a history clear returns immediately, leaving local history untouched — same guard as any other clear failure", async () => {
  const before = JSON.stringify({
    results: [{
      module: "reading",
      testId: "kept-through-a-too-large-clear",
      testTitle: "A sitting that must survive a 413 on clear",
      band: 7,
      date: "2026-09-11T12:00:00.000Z",
    }],
    genTests: [],
  });
  perTab.set(PROFILE_KEY, before);
  remoteSnapshots = [{ storeKey: PROFILE_KEY, payload: JSON.parse(before), clientUpdatedAt: "2026-09-11T12:00:00.000Z" }];
  putStatus = 413;

  const outcome = await clearSyncedProgress("2026-09-12T09:05:00.000Z");

  assert.equal(outcome.status, "too-large");
  assert.equal(perTab.get(PROFILE_KEY), before, "a clear the account never accepted must not touch real local history");

  putStatus = 200;
});

test("the account page names the actual fix, not a promise that a retry cannot keep", () => {
  const panel = readFileSync(join(root, "components", "AccountPanel.tsx"), "utf8");
  assert.match(panel, /import \{ lastSyncedAt, lastSyncFailed, lastSyncTooLarge, subscribeSyncStatus \} from "@\/lib\/progress\/sync";/);
  assert.match(
    panel,
    /const tooLarge = useSyncExternalStore\(subscribeSyncStatus, lastSyncTooLarge, \(\) => false\);/,
  );
  assert.match(
    panel,
    /Your saved practice is too large to sync — clear some history and it will resume\./,
  );
  // The generic message must still exist for the ordinary failure, and the
  // two must be presented as alternatives (tooLarge checked first), not both
  // appended to one another.
  const line = panel.slice(panel.indexOf("function SyncStatusLine"));
  assert.match(
    line,
    /\{tooLarge\s*\n\s*\?\s*" Your saved practice is too large to sync[\s\S]*?:\s*failed\s*\n\s*\?\s*" It could not sync just now/,
  );
});

test("autosync does not schedule a retry for a too-large refusal", () => {
  const source = readFileSync(join(process.cwd(), "lib", "progress", "autosync.ts"), "utf8");
  const branch = source.slice(source.indexOf('outcome.status === "signed-out"'), source.indexOf("cancelScheduledSync();", source.indexOf('outcome.status === "signed-out"')));
  assert.match(branch, /"too-large"/);
});
