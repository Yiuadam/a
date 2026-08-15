/*
  The account sync and the UI must read the same shelf.

  Learner data moved from localStorage to sessionStorage for privacy, but the
  sync originally kept reading localStorage. The UI therefore remembered a
  card visit for the current tab while the account uploaded an empty profile;
  a new tab, browser, or sign-in showed every "New" badge again.

  The tests near the bottom of this file are a second, later bug in the same
  neighbourhood: sessionStorage recorded no owner, so signing out of one
  account and into another in the same tab silently merged the first
  account's practice into the second. Those tests exercise the owner marker
  (lib/progress/storage.ts) and the refusal it enables in syncProgress below
  — adoption of genuinely signed-out work, refusal of a different account's
  leftovers, and that refusal never costing the new account its own data.
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
// Which bearer token this stub expects to see. Every existing test above
// signs in as "test-access-token" and never touches this, so the default
// keeps their behaviour unchanged; the owner-marker tests further down move
// it to a real-shaped fake token per account so currentAccountId() (which
// decodes the token itself, see lib/account.ts) has something to decode.
let expectedToken = "test-access-token";

/*
  A JWT this codebase's account.ts can read a "sub" claim out of, without
  needing a real signature — currentAccountId() never checks one, for exactly
  the reason explained on that function. Two segments would already make it
  fail the shape check there; this keeps the header/payload/signature shape a
  real Supabase token has.
*/
function fakeJwt(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

globalThis.fetch = async (input, init = {}) => {
  assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${expectedToken}`);
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
/*
  Imported directly, rather than reaching into `durable`/`perTab` by hand, so
  the owner-marker tests below exercise the real read/write/sign-in paths —
  the same modules lib/progress/sync.ts and lib/account.ts themselves use —
  instead of a parallel implementation of "what the key is called" that could
  drift from them and pass for the wrong reason.
*/
const { saveSession } = await import(
  pathToFileURL(join(process.cwd(), "lib", "account.ts")).href
);
const { progressOwner, setProgressOwner } = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "storage.ts")).href
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

test("an accepted account clear also uploads and locally writes the placement tombstone", async () => {
  const placement = { band: 6, date: "2026-08-13T11:00:00.000Z" };
  perTab.set(PROFILE_KEY, JSON.stringify({ placement, results: [], genTests: [] }));
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { placement, results: [], genTests: [] },
    clientUpdatedAt: "2026-08-13T11:00:00.000Z",
  }];
  const clearedAt = "2026-08-13T12:06:00.000Z";

  const outcome = await clearSyncedProgress(clearedAt);

  assert.equal(outcome.status, "done");
  const uploadedProfile = uploadedSnapshots.find((snapshot) => snapshot.storeKey === PROFILE_KEY)
    .payload;
  assert.equal(uploadedProfile.placement, undefined, "the placement must be part of what is uploaded as cleared");
  assert.equal(uploadedProfile.placementClearedAt, clearedAt);
  const localProfile = JSON.parse(perTab.get(PROFILE_KEY));
  assert.equal(localProfile.placement, undefined);
  assert.equal(localProfile.placementClearedAt, clearedAt);
});

test("a device clear is not resurrected by the next ordinary sync", async () => {
  /*
    The confirmed production bug, reproduced end to end: the owner used
    "clear everything saved on this device", and the dashboard still showed a
    placement band afterwards. clearSyncedProgress only ever promised to clear
    *history* (results, mock reports) — a genuine placement rode along
    unchanged into the account, so the very next ordinary sync (the one
    components/AutoSync.tsx fires "on load" after the reload this button
    triggers) downloaded it straight back into the freshly wiped tab.
  */
  const genuinePlacement = { band: 6.5, date: "2026-08-10T10:00:00.000Z" };
  const oldSitting = {
    module: "reading",
    testId: "reading-before-clear",
    testTitle: "A sitting that should be cleared",
    band: 6,
    date: "2026-08-11T12:00:00.000Z",
  };
  perTab.set(PROFILE_KEY, JSON.stringify({
    placement: genuinePlacement,
    results: [oldSitting],
    genTests: [],
  }));
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { placement: genuinePlacement, results: [oldSitting], genTests: [] },
    clientUpdatedAt: "2026-08-11T12:00:00.000Z",
  }];

  const clearedAt = "2026-08-14T09:00:00.000Z";
  const clearOutcome = await clearSyncedProgress(clearedAt);
  assert.equal(clearOutcome.status, "done");

  // What "Yes, clear it" actually does once the account confirms the clear:
  // components/account/ClearDeviceSection.tsx wipes this tab's storage
  // outright (window.sessionStorage.clear()), not a targeted key removal.
  perTab.clear();

  // The reload that follows fires an ordinary sync — no clear option
  // involved, exactly like any other device pulling the account down.
  const resyncOutcome = await syncProgress();
  assert.equal(resyncOutcome.status, "done");

  const afterResync = JSON.parse(perTab.get(PROFILE_KEY));
  assert.equal(
    afterResync.placement,
    undefined,
    "a cleared placement must not be resurrected by the very next ordinary sync",
  );
  assert.deepEqual(afterResync.results, []);
});

test("a genuine placement sat after a clear still reaches this device on the next sync", async () => {
  // Requirement 3, at the full sync level rather than the pure-merge level:
  // clearing is the only thing that may remove a placement, and the fix must
  // not cost a learner a real result taken on another device afterwards.
  const oldPlacement = { band: 6, date: "2026-08-01T10:00:00.000Z" };
  perTab.set(PROFILE_KEY, JSON.stringify({ placement: oldPlacement, results: [], genTests: [] }));
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { placement: oldPlacement, results: [], genTests: [] },
    clientUpdatedAt: "2026-08-01T10:00:00.000Z",
  }];

  const clearedAt = "2026-08-14T09:00:00.000Z";
  await clearSyncedProgress(clearedAt);
  perTab.clear();
  await syncProgress();
  assert.equal(
    JSON.parse(perTab.get(PROFILE_KEY)).placement,
    undefined,
    "sanity check: the clear took effect exactly as in the test above",
  );

  // A different device sits the test again, after the clear, and syncs first.
  const newPlacement = { band: 7, date: "2026-08-14T11:00:00.000Z" };
  remoteSnapshots = remoteSnapshots.map((snapshot) => (
    snapshot.storeKey === PROFILE_KEY
      ? {
          ...snapshot,
          payload: { ...snapshot.payload, placement: newPlacement },
          clientUpdatedAt: "2026-08-14T11:00:00.000Z",
        }
      : snapshot
  ));

  const finalOutcome = await syncProgress();
  assert.equal(finalOutcome.status, "done");
  assert.equal(
    JSON.parse(perTab.get(PROFILE_KEY)).placement.band,
    7,
    "a placement sat on another device after the clear must still arrive here",
  );
});

test("signed-out work is adopted by the first account that signs in, and the sync stamps the owner", async () => {
  // Nobody has claimed this tab's progress yet: the intended feature this fix
  // must not break is that it still gets adopted by whoever signs in first.
  setProgressOwner(null);
  perTab.set(PROFILE_KEY, JSON.stringify({
    visited: ["reading"],
    results: [{
      module: "reading",
      testId: "signed-out-practice",
      testTitle: "Practice done before making an account",
      band: 6,
      date: "2026-08-14T08:00:00.000Z",
    }],
    genTests: [],
  }));
  perTab.set(PROFILE_UPDATED_KEY, "2026-08-14T08:00:00.000Z");
  remoteSnapshots = []; // a brand-new account, nothing of its own yet
  saveSession({
    accessToken: fakeJwt("account-a"),
    refreshToken: null,
    expiresAt: null,
    email: null,
  });
  expectedToken = fakeJwt("account-a");

  try {
    const outcome = await syncProgress();

    assert.equal(outcome.status, "done");
    const uploadedProfile = uploadedSnapshots.find((s) => s.storeKey === PROFILE_KEY).payload;
    assert.deepEqual(
      uploadedProfile.results.map((r) => r.testId),
      ["signed-out-practice"],
      "the real feature: signed-out practice is still adopted by the first account that signs in",
    );
    assert.equal(
      progressOwner(),
      "account-a",
      "a successful sync stamps the owner, unprompted, so this account's own later syncs read as itself",
    );
  } finally {
    saveSession({
      accessToken: "test-access-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    expectedToken = "test-access-token";
  }
});

test("the owner a real sync stamps keeps a same-account resync ordinary, not adoptable", async () => {
  // First sync: signed-out work adopted by account A, exactly as above — the
  // point here is what the *sync itself* records, not a marker this test sets
  // by hand, which is what the next assertion depends on meaning anything.
  setProgressOwner(null);
  perTab.set(PROFILE_KEY, JSON.stringify({ visited: [], results: [], genTests: [] }));
  perTab.set(PROFILE_UPDATED_KEY, "2026-08-14T09:00:00.000Z");
  remoteSnapshots = [];
  saveSession({
    accessToken: fakeJwt("account-a"),
    refreshToken: null,
    expiresAt: null,
    email: null,
  });
  expectedToken = fakeJwt("account-a");

  try {
    const first = await syncProgress();
    assert.equal(first.status, "done");
    assert.equal(progressOwner(), "account-a", "the first sync stamped account A as owner, unprompted");

    // Second sync, still account A, with a fresh sitting recorded in this tab
    // since the first sync. Had the stamp above not really happened — the
    // marker still reading as signed-out — this would be indistinguishable
    // from adoption; with it, it must merge as this account's own newer work.
    const secondSitting = {
      module: "listening",
      testId: "account-a-second-sitting",
      testTitle: "A second sitting by the same, already-recognised account",
      band: 6,
      date: "2026-08-14T09:05:00.000Z",
    };
    const current = JSON.parse(perTab.get(PROFILE_KEY));
    perTab.set(PROFILE_KEY, JSON.stringify({ ...current, results: [secondSitting] }));
    perTab.set(PROFILE_UPDATED_KEY, "2026-08-14T09:05:00.000Z");

    const second = await syncProgress();
    assert.equal(second.status, "done");
    const uploadedProfile = uploadedSnapshots.find((s) => s.storeKey === PROFILE_KEY).payload;
    assert.ok(
      uploadedProfile.results.some((r) => r.testId === secondSitting.testId),
      "same owner: the second sync must merge this tab's newer work as usual, not discard it as foreign",
    );
    assert.equal(progressOwner(), "account-a");
  } finally {
    saveSession({
      accessToken: "test-access-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    expectedToken = "test-access-token";
  }
});

test("a different account's local leftovers are refused, and the newly signed-in account's own data still arrives", async () => {
  // This is the confirmed bug, reproduced: account A's practice is sitting in
  // this tab, marked as belonging to A, when account B signs in on the same
  // browser.
  const accountASecret = {
    module: "writing",
    testId: "account-a-private-essay",
    testTitle: "Account A's own essay",
    band: 7,
    date: "2026-08-14T08:00:00.000Z",
  };
  perTab.set(PROFILE_KEY, JSON.stringify({
    visited: ["writing"],
    results: [accountASecret],
    genTests: [],
  }));
  perTab.set(PROFILE_UPDATED_KEY, "2026-08-14T08:00:00.000Z");
  setProgressOwner("account-a");

  // Account B is a different, already-established account with its own
  // remote history — the fix must not cost B this on B's own sign-in.
  const accountBOwn = {
    module: "reading",
    testId: "account-b-own-result",
    testTitle: "Account B's own reading result",
    band: 6.5,
    date: "2026-08-13T09:00:00.000Z",
  };
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { visited: ["reading"], results: [accountBOwn], genTests: [] },
    clientUpdatedAt: "2026-08-13T09:00:00.000Z",
  }];
  saveSession({
    accessToken: fakeJwt("account-b"),
    refreshToken: null,
    expiresAt: null,
    email: null,
  });
  expectedToken = fakeJwt("account-b");

  try {
    const outcome = await syncProgress();

    assert.equal(outcome.status, "done");

    // The leak this fix closes: the request body actually sent to the
    // account, not merely what this tab ends up showing, must carry nothing
    // of account A's.
    const uploadedProfile = uploadedSnapshots.find((s) => s.storeKey === PROFILE_KEY).payload;
    assert.ok(
      !uploadedProfile.results.some((r) => r.testId === accountASecret.testId),
      "account A's local result must not appear in the payload PUT to account B's account",
    );
    assert.ok(
      !JSON.stringify(uploadedSnapshots).includes("account-a-private-essay"),
      "account A's data must not be uploaded under any field, not only the results array",
    );
    assert.ok(
      !uploadedProfile.visited.includes("writing"),
      "account A's 'writing' visit must not be unioned into what gets uploaded for account B",
    );

    // Discarding A's leftovers must not blank B's own legitimate history —
    // it is still pulled down and ends up in what this tab shows.
    assert.ok(
      uploadedProfile.results.some((r) => r.testId === accountBOwn.testId),
      "account B's own existing result must still be present after the sync",
    );
    const localProfile = JSON.parse(perTab.get(PROFILE_KEY));
    assert.ok(
      !localProfile.results.some((r) => r.testId === accountASecret.testId),
      "this tab must not go on showing account A's result once account B has signed in",
    );
    assert.ok(
      localProfile.results.some((r) => r.testId === accountBOwn.testId),
      "this tab must show account B's own result — the fix must not blank a legitimate account",
    );
    assert.deepEqual(
      [...localProfile.visited].sort(),
      ["reading"],
      "account A's 'writing' visit must not leak into what account B's tab shows either",
    );

    assert.equal(progressOwner(), "account-b", "the marker now records account B as this tab's owner");
  } finally {
    saveSession({
      accessToken: "test-access-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    expectedToken = "test-access-token";
  }
});

test("a history clear from a tab holding a foreign account's leftovers never uploads them", async () => {
  // The clearHistoryAt path builds its hypothetical cleared profile by
  // spreading this tab's local profile and then zeroing results/mockReports
  // — so a field the spread does not zero, like `visited`, is exactly where a
  // foreign owner's fingerprint could otherwise ride along into a clear.
  perTab.set(PROFILE_KEY, JSON.stringify({
    visited: ["account-a-only-marker"],
    results: [{
      module: "speaking",
      testId: "account-a-leftover-before-clear",
      testTitle: "Account A's leftover, sitting in this tab",
      band: 7,
      date: "2026-08-14T08:00:00.000Z",
    }],
    genTests: [],
  }));
  setProgressOwner("account-a");
  const accountBExisting = {
    module: "writing",
    testId: "account-b-existing-before-clear",
    testTitle: "Account B's own history before the clear",
    band: 6,
    date: "2026-08-13T08:00:00.000Z",
  };
  remoteSnapshots = [{
    storeKey: PROFILE_KEY,
    payload: { visited: ["writing"], results: [accountBExisting], genTests: [] },
    clientUpdatedAt: "2026-08-13T08:00:00.000Z",
  }];
  saveSession({
    accessToken: fakeJwt("account-b"),
    refreshToken: null,
    expiresAt: null,
    email: null,
  });
  expectedToken = fakeJwt("account-b");
  const clearedAt = "2026-08-14T08:05:00.000Z";

  try {
    const outcome = await clearSyncedProgress(clearedAt);

    assert.equal(outcome.status, "done");
    const uploadedProfile = uploadedSnapshots.find((s) => s.storeKey === PROFILE_KEY).payload;
    assert.equal(uploadedProfile.historyClearedAt, clearedAt);
    assert.deepEqual(uploadedProfile.results, [], "a history clear empties the results array as usual");
    assert.ok(
      !uploadedProfile.visited.includes("account-a-only-marker"),
      "a foreign owner's fields must not ride along into a clear via the local-profile spread",
    );
    assert.ok(
      !JSON.stringify(uploadedSnapshots).includes("account-a-leftover-before-clear"),
      "account A's leftover result must not ride along inside the cleared profile either",
    );
    assert.equal(progressOwner(), "account-b");
  } finally {
    saveSession({
      accessToken: "test-access-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    });
    expectedToken = "test-access-token";
  }
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
