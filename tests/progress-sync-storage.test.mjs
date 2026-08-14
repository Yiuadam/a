/*
  The account sync and the UI must read the same shelf.

  Learner data moved from localStorage to sessionStorage for privacy, but the
  sync originally kept reading localStorage. The UI therefore remembered a
  card visit for the current tab while the account uploaded an empty profile;
  a new tab, browser, or sign-in showed every "New" badge again.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const PROFILE_KEY = "ielts-prep-v1";
const SESSION_KEY = "bandup.session.v1";
const PROFILE_UPDATED_KEY = `bandup.progress-updated.v1:${PROFILE_KEY}`;

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
  [PROFILE_UPDATED_KEY, "2026-08-11T07:45:00.000Z"],
]);
const dispatchedStorageKeys = [];
const windowListeners = new Map();

function listenersFor(type) {
  let listeners = windowListeners.get(type);
  if (!listeners) {
    listeners = new Set();
    windowListeners.set(type, listeners);
  }
  return listeners;
}

const shelf = (map) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
});

globalThis.window = {
  localStorage: shelf(durable),
  sessionStorage: shelf(perTab),
  dispatchEvent: (event) => {
    if (event.type === "storage") dispatchedStorageKeys.push(event.key);
    for (const listener of listenersFor(event.type)) listener(event);
    return true;
  },
  addEventListener: (type, listener) => listenersFor(type).add(listener),
  removeEventListener: (type, listener) => windowListeners.get(type)?.delete(listener),
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
let duringPut = null;
let fetchFailure = null;
let historyProtected = false;

globalThis.fetch = async (input, init = {}) => {
  assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-access-token");
  if (fetchFailure === "unauthorised") {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if ((init.method ?? "GET") === "GET") {
    if (fetchFailure === "get") {
      return Response.json({ error: "Account unavailable." }, { status: 503 });
    }
    return Response.json({ snapshots: remoteSnapshots });
  }
  if (fetchFailure === "put") {
    return Response.json({ error: "Account unavailable." }, { status: 503 });
  }
  uploadedSnapshots = JSON.parse(String(init.body)).snapshots;
  remoteSnapshots = uploadedSnapshots.map((snapshot) => ({
    ...snapshot,
    clientUpdatedAt: "2026-08-11T08:00:00.000Z",
  }));
  if (duringPut) {
    const mutate = duringPut;
    duringPut = null;
    mutate();
  }
  return Response.json({
    at: "2026-08-11T08:00:00.000Z",
    historyProtected,
  });
};

const { clearSyncedProgress, syncProgress } = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "sync.ts")).href
);
const profileStore = await import(
  pathToFileURL(join(process.cwd(), "lib", "store.ts")).href
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

test("a deletion made while sync is in flight is not rolled back", async () => {
  const id = "generated-reading-1";
  const generated = {
    kind: "reading",
    createdAt: "2026-08-11T07:00:00.000Z",
    test: { id, title: "A generated paper" },
  };
  const beforeDelete = { results: [], genTests: [generated] };
  perTab.set(PROFILE_KEY, JSON.stringify(beforeDelete));
  remoteSnapshots = [
    {
      storeKey: PROFILE_KEY,
      payload: beforeDelete,
      clientUpdatedAt: "2026-08-11T07:30:00.000Z",
    },
  ];

  duringPut = () => {
    perTab.set(
      PROFILE_KEY,
      JSON.stringify({
        results: [],
        genTests: [],
        deletedGenTests: { [id]: "2026-08-11T08:00:00.000Z" },
      }),
    );
  };

  const outcome = await syncProgress();
  assert.equal(outcome.status, "done");

  const afterSync = JSON.parse(perTab.get(PROFILE_KEY));
  assert.deepEqual(afterSync.genTests, []);
  assert.equal(afterSync.deletedGenTests[id], "2026-08-11T08:00:00.000Z");
});

test("a history-clear tombstone is uploaded and stale sittings stay deleted", async () => {
  const clearedAt = "2026-08-12T12:00:00.000Z";
  const staleResult = {
    module: "reading",
    testId: "reading-before-clear",
    testTitle: "Old reading sitting",
    band: 6,
    date: "2026-08-10T12:00:00.000Z",
  };

  perTab.set(
    PROFILE_KEY,
    JSON.stringify({
      results: [],
      mockReports: [],
      genTests: [],
      historyClearedAt: clearedAt,
    }),
  );
  remoteSnapshots = [
    {
      storeKey: PROFILE_KEY,
      payload: { results: [staleResult], genTests: [] },
      clientUpdatedAt: "2026-08-10T13:00:00.000Z",
    },
  ];

  const outcome = await syncProgress();
  assert.equal(outcome.status, "done");

  const uploadedProfile = uploadedSnapshots.find((snapshot) => snapshot.storeKey === PROFILE_KEY)
    .payload;
  assert.equal(uploadedProfile.historyClearedAt, clearedAt);
  assert.deepEqual(uploadedProfile.results, []);

  const afterSync = JSON.parse(perTab.get(PROFILE_KEY));
  assert.equal(afterSync.historyClearedAt, clearedAt);
  assert.deepEqual(afterSync.results, []);
});

test("an older local scalar does not overwrite a newer account choice", async () => {
  perTab.set(PROFILE_KEY, JSON.stringify({
    targetBand: 6.5,
    results: [],
    genTests: [],
  }));
  perTab.set(PROFILE_UPDATED_KEY, "2026-08-11T06:00:00.000Z");
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { targetBand: 8, results: [], genTests: [] },
    clientUpdatedAt: "2026-08-11T07:00:00.000Z",
  }];

  const outcome = await syncProgress();
  assert.equal(outcome.status, "done");
  const uploadedProfile = uploadedSnapshots.find((snapshot) => snapshot.storeKey === PROFILE_KEY)
    .payload;
  assert.equal(uploadedProfile.targetBand, 8);
  assert.equal(
    uploadedSnapshots.find((snapshot) => snapshot.storeKey === PROFILE_KEY).clientUpdatedAt,
    "2026-08-11T07:00:00.000Z",
  );
  assert.equal(JSON.parse(perTab.get(PROFILE_KEY)).targetBand, 8);
});

test("autosync restores a newer placement and emits the profile refresh event", async () => {
  const stalePlacement = { band: 5.5, date: "2026-08-01T10:00:00.000Z" };
  const newerPlacement = { band: 7, date: "2026-08-12T10:00:00.000Z" };
  perTab.set(PROFILE_KEY, JSON.stringify({
    placement: stalePlacement,
    targetBand: 8,
    results: [],
    genTests: [],
  }));
  // This stamp belongs to a later target-band change, not to the placement.
  perTab.set(PROFILE_UPDATED_KEY, "2026-08-14T10:00:00.000Z");
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: {
      placement: newerPlacement,
      targetBand: 6,
      results: [],
      genTests: [],
    },
    clientUpdatedAt: "2026-08-12T11:00:00.000Z",
  }];
  dispatchedStorageKeys.length = 0;
  assert.equal(profileStore.getSnapshot().placement.band, 5.5);
  let refreshes = 0;
  const unsubscribe = profileStore.subscribe(() => {
    refreshes += 1;
  });

  try {
    const outcome = await syncProgress();

    assert.equal(outcome.status, "done");
    const uploadedProfile = uploadedSnapshots.find((snapshot) => snapshot.storeKey === PROFILE_KEY)
      .payload;
    assert.equal(uploadedProfile.placement.band, 7);
    assert.equal(uploadedProfile.targetBand, 8);

    const refreshedProfile = JSON.parse(perTab.get(PROFILE_KEY));
    assert.equal(refreshedProfile.placement.band, 7);
    assert.equal(refreshedProfile.targetBand, 8);
    assert.ok(
      dispatchedStorageKeys.includes(PROFILE_KEY),
      "the profile storage event keeps useSyncExternalStore views fresh after autosync",
    );
    assert.ok(refreshes > 0, "the profile store listener is notified after autosync");
    assert.equal(profileStore.getSnapshot().placement.band, 7);
  } finally {
    unsubscribe();
  }
});

test("a failed account clear leaves the browser's working copy byte-for-byte intact", async () => {
  const before = JSON.stringify({
    targetBand: 7.5,
    results: [{
      module: "reading",
      testId: "reading-kept-after-outage",
      testTitle: "A sitting that must remain",
      band: 7,
      date: "2026-08-13T12:00:00.000Z",
    }],
    genTests: [],
  });
  perTab.set(PROFILE_KEY, before);
  perTab.set(PROFILE_UPDATED_KEY, "2026-08-13T12:01:00.000Z");
  fetchFailure = "get";

  const outcome = await clearSyncedProgress("2026-08-13T12:02:00.000Z");

  fetchFailure = null;
  assert.equal(outcome.status, "unavailable");
  assert.equal(perTab.get(PROFILE_KEY), before);
  assert.equal(perTab.get(PROFILE_UPDATED_KEY), "2026-08-13T12:01:00.000Z");
});

test("an expired account session cannot turn a device clear into a temporary clear", async () => {
  const before = JSON.stringify({
    results: [{
      module: "listening",
      testId: "listening-kept-after-401",
      testTitle: "Another sitting that must remain",
      band: 6.5,
      date: "2026-08-13T12:00:00.000Z",
    }],
    genTests: [],
  });
  perTab.set(PROFILE_KEY, before);
  fetchFailure = "unauthorised";

  const outcome = await clearSyncedProgress("2026-08-13T12:03:00.000Z");

  fetchFailure = null;
  assert.equal(outcome.status, "signed-out");
  assert.equal(perTab.get(PROFILE_KEY), before);
});

test("a newly restricted organisation policy leaves the browser history in place", async () => {
  const before = JSON.stringify({
    results: [{
      module: "writing",
      testId: "writing-protected-by-organisation",
      testTitle: "Protected sitting",
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
  historyProtected = true;

  const outcome = await clearSyncedProgress("2026-08-13T12:04:00.000Z");

  historyProtected = false;
  assert.equal(outcome.status, "restricted");
  assert.equal(perTab.get(PROFILE_KEY), before);
});

test("an accepted account clear writes the tombstone locally only after the PUT", async () => {
  const result = {
    module: "speaking",
    testId: "speaking-cleared",
    testTitle: "Cleared sitting",
    band: 7.5,
    date: "2026-08-13T12:00:00.000Z",
  };
  perTab.set(PROFILE_KEY, JSON.stringify({ results: [result], genTests: [] }));
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { results: [result], genTests: [] },
    clientUpdatedAt: "2026-08-13T12:00:00.000Z",
  }];
  const clearedAt = "2026-08-13T12:05:00.000Z";

  const outcome = await clearSyncedProgress(clearedAt);

  assert.equal(outcome.status, "done");
  const uploadedProfile = uploadedSnapshots.find((snapshot) => snapshot.storeKey === PROFILE_KEY)
    .payload;
  assert.equal(uploadedProfile.historyClearedAt, clearedAt);
  assert.deepEqual(uploadedProfile.results, []);
  const localProfile = JSON.parse(perTab.get(PROFILE_KEY));
  assert.equal(localProfile.historyClearedAt, clearedAt);
  assert.deepEqual(localProfile.results, []);
});

test("the device-clear UI never clears history before account confirmation", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "account", "ClearDeviceSection.tsx"),
    "utf8",
  );
  assert.doesNotMatch(source, /import[^\n]*clearHistory/);
  assert.ok(source.indexOf("await clearSyncedProgress()") < source.indexOf("window.localStorage.clear()"));
  assert.match(source, /sync\.status === "signed-out"/);
  assert.match(source, /sync\.status === "restricted"/);
  assert.match(source, /This browser has kept its copy for now/);
});
