/*
  "Clear everything" has to actually mean everything.

  Two clears reach a learner's own work — "Clear all history"
  (components/history/ClearHistoryButton.tsx) and "clear this device"
  (components/account/ClearDeviceSection.tsx) — and until this change each of
  them left something standing:

    drill scores and saved words were emptied locally and then downloaded
      straight back on the next sync, because neither had a tombstone and both
      the browser's merge and the account's second merge dutifully unioned the
      emptied copy with the surviving one;
    the in-progress mock exam survived both clears and a sign-out, so the next
      person at a shared browser could resume the previous one's paper;
    the account's drills and lookups rows were emptied rather than deleted, so
      what remained was a blank record that this learner had had them.

  What the checks below hold in place, in the order the data moves:

    1. the merges drop what a tombstone covers, and keep what postdates it;
    2. the account's own second merge is given the same tombstones, or it
       hands back exactly what the browser just cleared;
    3. the browser's PUT carries all four tombstones and asks for the rows;
    4. the account's answer is applied without the local copy sneaking back;
    5. a clear the account did not accept changes nothing at all — whether it
       was refused on organisation policy or simply never confirmed;
    6. the mock exam goes on an accepted clear and on a sign-out, and stays
       on a clear that failed.

  Three constraints run underneath all of it and are asserted directly:
  organisation-shared history is never deleted by a student, nothing is
  deleted before the account has accepted the clear, and a delete that fails
  degrades to the emptied-row behaviour instead of reporting success.
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
const DRILLS_KEY = "bandup.drills.v1";
const LOOKUPS_KEY = "bandup.lookups.v1";
const MOCK_KEY = "bandup-mock-exam-v1";
const SESSION_KEY = "bandup.session.v1";
const CLEAR_AT = "2026-08-14T12:00:00.000Z";

const src = (...parts) => readFileSync(join(root, ...parts), "utf8");
const load = (...parts) => import(pathToFileURL(join(root, ...parts)).href);

// ---------------------------------------------------------------------------
// 1. The merges themselves
// ---------------------------------------------------------------------------

const { mergeDrillScores, mergeLookups } = await load("lib", "progress", "merge.ts");

test("a drill score from before the clear is dropped and a later re-attempt is kept", () => {
  const cleared = Date.parse(CLEAR_AT);
  const merged = mergeDrillScores(
    {},
    {
      articles: { correct: 7, total: 8, at: "2026-08-14T09:00:00.000Z" },
      modals: { correct: 5, total: 8, at: "2026-08-14T13:00:00.000Z" },
    },
    cleared,
  );

  // The point of the tombstone: an emptied local copy unioned with an account
  // that never heard about the clear used to restore every score in it.
  assert.deepEqual(Object.keys(merged), ["modals"]);

  // And with no clear in effect nothing changes, so an ordinary sync is
  // untouched by any of this.
  assert.deepEqual(
    Object.keys(mergeDrillScores({}, { articles: { correct: 7, total: 8, at: "x" } })).sort(),
    ["articles"],
  );
});

test("an undated drill score cannot outlive a clear by having no date to judge", () => {
  const merged = mergeDrillScores(
    {},
    { articles: { correct: 7, total: 8 } },
    Date.parse(CLEAR_AT),
  );
  assert.deepEqual(Object.keys(merged), [], "an item that cannot prove it is newer is not newer");
});

test("a saved word is judged on when it was looked up, not on when it was pinned", () => {
  const merged = mergeLookups(
    {},
    {
      cohort: {
        definition: "a group",
        at: "2026-08-14T09:00:00.000Z",
        favourite: true,
        favouriteUpdatedAt: "2026-08-14T18:00:00.000Z",
      },
      mitigate: { definition: "to soften", at: "2026-08-14T13:00:00.000Z" },
    },
    300,
    Date.parse(CLEAR_AT),
  );

  // A pin recorded after the clear is not a reason to keep a word looked up
  // before it — otherwise "clear my saved words" would spare exactly the
  // words a learner had marked as the ones they cared about most.
  assert.deepEqual(Object.keys(merged), ["mitigate"]);
});

// ---------------------------------------------------------------------------
// 2. The account's second merge
// ---------------------------------------------------------------------------

const { mergeProgressSnapshotPayload, progressClearTombstones } = await load(
  "lib", "progress", "server-snapshots.ts",
);

test("the account's merge is given the tombstones, or it hands the cleared scores back", () => {
  const submittedProfile = { results: [], genTests: [], drillsClearedAt: CLEAR_AT };
  const storedProfile = { results: [], genTests: [] };
  const mergedProfile = mergeProgressSnapshotPayload(
    PROFILE_KEY,
    submittedProfile,
    storedProfile,
    Date.parse(CLEAR_AT),
    Date.parse("2026-08-14T09:00:00.000Z"),
    false,
  );
  assert.equal(mergedProfile.drillsClearedAt, CLEAR_AT);

  const tombstones = progressClearTombstones(mergedProfile);
  const drills = mergeProgressSnapshotPayload(
    DRILLS_KEY,
    {},
    { articles: { correct: 7, total: 8, at: "2026-08-14T09:00:00.000Z" } },
    Date.parse(CLEAR_AT),
    Date.parse("2026-08-14T09:00:00.000Z"),
    false,
    tombstones,
  );

  // This is the bug the browser's tombstone alone could not fix: the browser
  // submits {}, the account still holds the score, and without the tombstone
  // the server's own merge unions them and returns the score to the device
  // that just deleted it.
  assert.deepEqual(Object.keys(drills), []);
});

test("a protected organisation student's tombstones are refused, not applied by the back door", () => {
  const storedProfile = {
    results: [{
      module: "reading",
      testId: "organisation-sitting",
      testTitle: "A sitting the organisation keeps",
      band: 7,
      date: "2026-08-14T09:00:00.000Z",
    }],
    genTests: [],
  };
  const bypassingClient = {
    results: [],
    genTests: [],
    historyClearedAt: CLEAR_AT,
    placementClearedAt: CLEAR_AT,
    drillsClearedAt: CLEAR_AT,
    lookupsClearedAt: CLEAR_AT,
  };

  const mergedProfile = mergeProgressSnapshotPayload(
    PROFILE_KEY,
    bypassingClient,
    storedProfile,
    Date.parse(CLEAR_AT),
    Date.parse("2026-08-14T09:00:00.000Z"),
    true,
  );

  assert.equal(mergedProfile.results.length, 1, "the sitting the organisation keeps must survive");
  assert.equal(mergedProfile.drillsClearedAt, undefined);
  assert.equal(mergedProfile.lookupsClearedAt, undefined);

  // And the tombstones the route derives from that merge are empty, so the
  // drills and lookups merges it runs next cannot empty what the profile
  // merge just refused to clear.
  assert.deepEqual(
    progressClearTombstones(mergedProfile),
    { drillsClearedAt: null, lookupsClearedAt: null },
  );

  const drills = mergeProgressSnapshotPayload(
    DRILLS_KEY,
    {},
    { articles: { correct: 7, total: 8, at: "2026-08-14T09:00:00.000Z" } },
    Date.parse(CLEAR_AT),
    Date.parse("2026-08-14T09:00:00.000Z"),
    true,
    progressClearTombstones(mergedProfile),
  );
  assert.deepEqual(Object.keys(drills), ["articles"], "a student cannot delete protected work");
});

// ---------------------------------------------------------------------------
// 3-6. The browser end to end, against a stubbed account
// ---------------------------------------------------------------------------

const durable = new Map([
  [
    SESSION_KEY,
    JSON.stringify({
      accessToken: "clear-extension-token",
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
let putShouldFail = false;
let historyProtected = false;
let rowsDeleted = true;
let lastPutBody = null;

globalThis.fetch = async (_input, init = {}) => {
  const method = init.method ?? "GET";
  if (method === "GET") return Response.json({ snapshots: remoteSnapshots });
  assert.equal(method, "PUT");
  lastPutBody = JSON.parse(init.body);
  if (putShouldFail) {
    return Response.json({ error: "unavailable", reason: "write-unavailable" }, { status: 503 });
  }
  /*
    Shaped like the real route's answer: it echoes back what it accepted. The
    stub deliberately does not re-merge against `remoteSnapshots` — that
    second merge is the account's job and is checked directly above, and
    simulating it here would only be testing the simulation. What it does do
    is what any accepting account does, which is hand the submitted payloads
    back as accepted, and that is precisely the input the browser's own last
    merge has to survive.
  */
  return Response.json({
    at: "2026-08-14T12:00:01.000Z",
    snapshots: lastPutBody.snapshots.map((snapshot) => ({
      storeKey: snapshot.storeKey,
      payload: snapshot.payload,
      clientUpdatedAt: snapshot.clientUpdatedAt,
    })),
    historyProtected,
    rowsDeleted: lastPutBody.deleteRows === true ? rowsDeleted : false,
  });
};

const { clearSyncedProgress } = await load("lib", "progress", "sync.ts");
const { clearProgressStore } = await load("lib", "progress", "storage.ts");

const OLD_DRILLS = { articles: { correct: 7, total: 8, at: "2026-08-14T09:00:00.000Z" } };
const OLD_LOOKUPS = { cohort: { definition: "a group", at: "2026-08-14T09:00:00.000Z" } };

function seedDevice() {
  perTab.clear();
  perTab.set(PROFILE_KEY, JSON.stringify({
    results: [{
      module: "reading",
      testId: "before-the-clear",
      testTitle: "A sitting from before the clear",
      band: 7,
      date: "2026-08-14T09:00:00.000Z",
    }],
    placement: { band: 6.5, date: "2026-08-14T08:00:00.000Z" },
    genTests: [],
  }));
  perTab.set(DRILLS_KEY, JSON.stringify(OLD_DRILLS));
  perTab.set(LOOKUPS_KEY, JSON.stringify(OLD_LOOKUPS));
  perTab.set(MOCK_KEY, JSON.stringify({ version: 1, id: "mock-in-progress", paper: {} }));
  remoteSnapshots = [
    { storeKey: PROFILE_KEY, payload: JSON.parse(perTab.get(PROFILE_KEY)), clientUpdatedAt: "2026-08-14T09:00:00.000Z" },
    { storeKey: DRILLS_KEY, payload: OLD_DRILLS, clientUpdatedAt: "2026-08-14T09:00:00.000Z" },
    { storeKey: LOOKUPS_KEY, payload: OLD_LOOKUPS, clientUpdatedAt: "2026-08-14T09:00:00.000Z" },
  ];
  putShouldFail = false;
  historyProtected = false;
  rowsDeleted = true;
  lastPutBody = null;
}

test("a device clear submits all four tombstones and asks for the rows themselves", async () => {
  seedDevice();

  const outcome = await clearSyncedProgress(CLEAR_AT);

  assert.equal(outcome.status, "done");
  const submitted = lastPutBody.snapshots.find((s) => s.storeKey === PROFILE_KEY).payload;
  // All four ride up on the profile, which is where they live — see the doc
  // comments on Profile in lib/types.ts. A clear that carried only the two
  // older ones is the bug this whole change exists to close.
  assert.equal(submitted.historyClearedAt, CLEAR_AT);
  assert.equal(submitted.placementClearedAt, CLEAR_AT);
  assert.equal(submitted.drillsClearedAt, CLEAR_AT);
  assert.equal(submitted.lookupsClearedAt, CLEAR_AT);
  assert.equal(submitted.placement, undefined);
  assert.deepEqual(submitted.results, []);

  // The emptied records go up with them, and the request asks the account to
  // drop the rows rather than keep them as blank shells.
  assert.deepEqual(lastPutBody.snapshots.find((s) => s.storeKey === DRILLS_KEY).payload, {});
  assert.deepEqual(lastPutBody.snapshots.find((s) => s.storeKey === LOOKUPS_KEY).payload, {});
  assert.equal(lastPutBody.deleteRows, true);
  assert.equal(outcome.rowsDeleted, true);
});

test("an accepted clear does not let this device hand its own scores and words back", async () => {
  seedDevice();

  const outcome = await clearSyncedProgress(CLEAR_AT);

  assert.equal(outcome.status, "done");
  /*
    THE REGRESSION. Step 4 of sync.ts merges the account's accepted answer
    with this tab's *current* copy, so that a score finished during the round
    trip is not rolled back. Without the accepted tombstone feeding that last
    merge, the copy it re-reads is the one the clear was about: the emptied
    payload the account just accepted gets unioned with the drills and lookups
    still sitting in sessionStorage, and every one of them is written straight
    back — the device undoing its own clear, one line after the account agreed
    to it.
  */
  assert.deepEqual(JSON.parse(perTab.get(DRILLS_KEY)), {});
  assert.deepEqual(JSON.parse(perTab.get(LOOKUPS_KEY)), {});

  const profile = JSON.parse(perTab.get(PROFILE_KEY));
  assert.deepEqual(profile.results, []);
  assert.equal(profile.placement, undefined);
  assert.equal(profile.drillsClearedAt, CLEAR_AT);
  assert.equal(profile.lookupsClearedAt, CLEAR_AT);
});

test("a drill attempted after the clear is kept, so a clear is not a lock", async () => {
  seedDevice();
  remoteSnapshots = remoteSnapshots.map((snapshot) => (
    snapshot.storeKey === DRILLS_KEY
      ? {
          ...snapshot,
          payload: {
            ...OLD_DRILLS,
            modals: { correct: 6, total: 8, at: "2026-08-14T18:00:00.000Z" },
          },
          clientUpdatedAt: "2026-08-14T18:00:00.000Z",
        }
      : snapshot
  ));

  await clearSyncedProgress(CLEAR_AT);

  assert.deepEqual(
    Object.keys(JSON.parse(perTab.get(DRILLS_KEY))),
    ["modals"],
    "work done after the clear belongs to the learner and must survive it",
  );
});

test("an accepted clear takes the mock exam with it", async () => {
  seedDevice();

  await clearSyncedProgress(CLEAR_AT);

  assert.equal(
    perTab.get(MOCK_KEY),
    undefined,
    "a paper left resumable is the next person at this browser resuming yours",
  );
  assert.ok(
    dispatchedStorageKeys.includes(MOCK_KEY),
    "lib/exam/mock.ts caches the sitting, so the removal has to be announced",
  );
});

test("a clear the account never confirmed changes nothing at all", async () => {
  seedDevice();
  const before = {
    profile: perTab.get(PROFILE_KEY),
    drills: perTab.get(DRILLS_KEY),
    lookups: perTab.get(LOOKUPS_KEY),
    mock: perTab.get(MOCK_KEY),
  };
  putShouldFail = true;

  const outcome = await clearSyncedProgress(CLEAR_AT);

  assert.equal(outcome.status, "unavailable");
  // Byte for byte. The hypothetical cleared payloads exist at this point and
  // must not reach storage, or a network outage becomes a deletion.
  assert.equal(perTab.get(PROFILE_KEY), before.profile);
  assert.equal(perTab.get(DRILLS_KEY), before.drills);
  assert.equal(perTab.get(LOOKUPS_KEY), before.lookups);
  assert.equal(perTab.get(MOCK_KEY), before.mock, "an unconfirmed clear must not take the paper");
});

test("an organisation-protected clear removes nothing, on any of the four records", async () => {
  seedDevice();
  const before = {
    profile: perTab.get(PROFILE_KEY),
    drills: perTab.get(DRILLS_KEY),
    lookups: perTab.get(LOOKUPS_KEY),
    mock: perTab.get(MOCK_KEY),
  };
  historyProtected = true;

  const outcome = await clearSyncedProgress(CLEAR_AT);

  assert.equal(outcome.status, "restricted");
  assert.equal(perTab.get(PROFILE_KEY), before.profile);
  assert.equal(perTab.get(DRILLS_KEY), before.drills);
  assert.equal(perTab.get(LOOKUPS_KEY), before.lookups);
  assert.equal(perTab.get(MOCK_KEY), before.mock);
});

test("an account that accepted the clear but could not delete the rows still reports done", async () => {
  seedDevice();
  rowsDeleted = false;

  const outcome = await clearSyncedProgress(CLEAR_AT);

  /*
    The degradation this change is allowed to make, and the only one. The rows
    are empty and tombstoned, which is exactly what shipped before deletion
    existed, so the clear genuinely happened; turning a failed row delete into
    "nothing was cleared" would be the false half of a true story. The flag
    says which of the two happened without either of them being a lie.
  */
  assert.equal(outcome.status, "done");
  assert.equal(outcome.rowsDeleted, false);
  assert.deepEqual(JSON.parse(perTab.get(DRILLS_KEY)), {});
  assert.equal(perTab.get(MOCK_KEY), undefined);
});

test("signing out takes the mock exam along with the progress keys", async () => {
  seedDevice();

  clearProgressStore();

  assert.equal(perTab.get(PROFILE_KEY), undefined);
  assert.equal(perTab.get(DRILLS_KEY), undefined);
  assert.equal(perTab.get(LOOKUPS_KEY), undefined);
  assert.equal(
    perTab.get(MOCK_KEY),
    undefined,
    "signing out is the clearest statement that the next person here is not you",
  );
});

// ---------------------------------------------------------------------------
// The rules that live in the route, and one shared literal
// ---------------------------------------------------------------------------

test("the mock exam key has exactly one definition for its three clearers to share", () => {
  const storage = src("lib", "progress", "storage.ts");
  assert.match(storage, /export const MOCK_EXAM_KEY = "bandup-mock-exam-v1";/);

  // Nothing else may spell it. lib/store.ts and lib/exam/mock.ts each held
  // their own copy at some point, and a rename that updated one of them would
  // leave a clearer pointing at a key nothing writes any more.
  for (const path of [["lib", "store.ts"], ["lib", "exam", "mock.ts"], ["lib", "progress", "sync.ts"]]) {
    assert.doesNotMatch(
      src(...path),
      /"bandup-mock-exam-v1"/,
      `${path.join("/")} must import MOCK_EXAM_KEY rather than spell it again`,
    );
  }
});

test("both clear guards ask the one predicate, so a fifth tombstone cannot miss one", () => {
  const sync = src("lib", "progress", "sync.ts");

  /*
    Behaviour cannot separate these two from the pair they replace, because
    clearSyncedProgress is the only caller and it sets all four tombstones
    together — so today `clearHistoryAt || clearPlacementAt` and
    isClearRequest are true at exactly the same moments. What is being held
    here is the shape: a clear carrying only the two new tombstones must be
    guarded exactly as the two old ones are, and the day a fifth is added
    there must be one place that learns about it rather than three that could
    each learn about it differently.
  */
  // The disjunction may exist exactly once — inside isClearRequest, which is
  // where the four-way test is defined. Anywhere else it is a guard that has
  // been left behind knowing only two of the four tombstones.
  const disjunctions = [...sync.matchAll(/options\.clearHistoryAt \|\| options\.clearPlacementAt/g)];
  assert.equal(disjunctions.length, 1, "only isClearRequest may spell the tombstones out");
  const predicate = sync.slice(
    sync.indexOf("function isClearRequest"),
    sync.indexOf("function isClearRequest") + 400,
  );
  assert.ok(
    predicate.includes("options.clearHistoryAt || options.clearPlacementAt"),
    "the one remaining disjunction must be the predicate's own definition",
  );
  assert.match(predicate, /options\.clearDrillsAt \|\| options\.clearLookupsAt/);
  const guarded = [...sync.matchAll(/isClearRequest\(options\)/g)];
  assert.ok(
    guarded.length >= 3,
    "the hypothetical build and both guards — the failed PUT and the protected clear — use it",
  );
  assert.match(sync, /if \(isClearRequest\(options\)\) return \{ status: "unavailable" \};/);
  assert.match(sync, /if \(isClearRequest\(options\) && historyProtected\) \{/);
});

test("the route deletes rows only after acceptance, never for a protected student, never the profile", () => {
  const route = src("app", "api", "account", "progress", "route.ts");

  // Never a protected organisation student, and never without being asked.
  assert.match(route, /if \(deleteRows && !restrictedHistory\) \{/);

  // Only the two rows that carry no tombstone of their own. The profile row
  // holds all four tombstones, and deleting it would delete the very things
  // that stop an unsynced device re-uploading its stale copy.
  const deletable = route.match(/const deletableRows = \[([^\]]+)\]/);
  assert.ok(deletable, "the deletable rows must be a fixed list, not built from the request");
  const keys = [...deletable[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ["bandup.drills.v1", "bandup.lookups.v1"]);
  assert.ok(!keys.includes(PROFILE_KEY), "deleting the profile row would delete the tombstones");

  // After the commit loop, not before it: a delete that ran first could take
  // a row the write then failed to replace.
  assert.ok(
    route.indexOf("if (!acceptedSnapshots) {") < route.indexOf("if (deleteRows && !restrictedHistory)"),
    "the delete must sit below the compare-and-swap loop and its failure return",
  );

  // A failed delete is reported, never raised — the rows are already empty
  // and tombstoned, so a 503 here would claim nothing was cleared.
  assert.match(route, /deleteLearnerProgressRows\([\s\S]{0,120}?\.catch\(\(\) => false\)/);
  assert.match(route, /rowsDeleted,/);
});

test("the account's delete cannot be widened by a store key from a request body", () => {
  const supabase = src("lib", "auth", "supabase.ts");
  const deleteFn = supabase.slice(supabase.indexOf("export async function deleteProgressSnapshots"));
  assert.match(
    deleteFn.slice(0, 900),
    /storeKeys\.filter\(isProgressKey\)/,
    "the filter this builds must be checked here, not trusted from the caller",
  );
  assert.match(deleteFn.slice(0, 900), /if \(keys\.length !== storeKeys\.length\) return false;/);
});
