/*
  The account sync and the UI must read the same shelf.

  Learner data moved from localStorage to sessionStorage for privacy, but the
  sync originally kept reading localStorage. The UI therefore remembered a
  card visit for the current tab while the account uploaded an empty profile;
  a new tab, browser, or sign-in showed every "New" badge again.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const PROFILE_KEY = "ielts-prep-v1";
const SESSION_KEY = "bandup.session.v1";

const durable = new Map([
  [
    SESSION_KEY,
    JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    }),
  ],
]);
const perTab = new Map([
  [PROFILE_KEY, JSON.stringify({ visited: ["reading"], results: [], genTests: [] })],
]);

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

let remoteSnapshots = [
  {
    storeKey: PROFILE_KEY,
    payload: { visited: ["listening"], results: [], genTests: [] },
    clientUpdatedAt: "2026-08-10T10:00:00.000Z",
  },
];
let uploadedSnapshots = null;

globalThis.fetch = async (input, init = {}) => {
  assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-access-token");
  if ((init.method ?? "GET") === "GET") {
    return Response.json({ snapshots: remoteSnapshots });
  }
  uploadedSnapshots = JSON.parse(String(init.body)).snapshots;
  remoteSnapshots = uploadedSnapshots.map((snapshot) => ({
    ...snapshot,
    clientUpdatedAt: "2026-08-11T08:00:00.000Z",
  }));
  return Response.json({ at: "2026-08-11T08:00:00.000Z" });
};

const { syncProgress } = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "sync.ts")).href
);

test("a visit in this tab is merged into the account snapshot", async () => {
  const outcome = await syncProgress();
  assert.equal(outcome.status, "done");

  const uploadedProfile = uploadedSnapshots.find((s) => s.storeKey === PROFILE_KEY).payload;
  assert.deepEqual([...uploadedProfile.visited].sort(), ["listening", "reading"]);
  assert.equal(durable.has(PROFILE_KEY), false, "learner work must not return to localStorage");
});

test("a fresh tab restores visited cards from the account", async () => {
  perTab.clear();

  const outcome = await syncProgress();
  assert.equal(outcome.status, "done");

  const restored = JSON.parse(perTab.get(PROFILE_KEY));
  assert.deepEqual([...restored.visited].sort(), ["listening", "reading"]);
});
