import assert from "node:assert/strict";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const LOOKUPS_KEY = "bandup.lookups.v1";
const LOOKUPS_UPDATED_KEY = `bandup.progress-updated.v1:${LOOKUPS_KEY}`;
const SESSION_KEY = "bandup.session.v1";

const durable = new Map([
  [
    SESSION_KEY,
    JSON.stringify({
      accessToken: "lookup-sync-access-token",
      refreshToken: null,
      expiresAt: null,
      email: "learner@example.com",
    }),
  ],
]);
const perTab = new Map([
  [
    LOOKUPS_KEY,
    JSON.stringify({
      estuary: {
        term: "estuary",
        short: "the tidal mouth of a river",
        source: "ai",
        at: "2026-08-14T09:00:00.000Z",
      },
      cohort: {
        term: "cohort",
        short: "a group with a shared characteristic",
        source: "ai",
        at: "2026-08-14T09:30:00.000Z",
        favourite: false,
        favouriteUpdatedAt: "2026-08-14T11:00:00.000Z",
      },
    }),
  ],
  [LOOKUPS_UPDATED_KEY, "2026-08-14T11:00:00.000Z"],
]);

const shelf = (map) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
});

const dispatched = [];
globalThis.window = {
  localStorage: shelf(durable),
  sessionStorage: shelf(perTab),
  dispatchEvent: (event) => {
    dispatched.push(event.type);
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

let uploadedSnapshots = null;
let remoteSnapshots = [
  {
    storeKey: LOOKUPS_KEY,
    payload: {
      cohort: {
        term: "cohort",
        short: "the definition saved on another device",
        source: "ai",
        at: "2026-08-14T08:30:00.000Z",
        favourite: true,
        favouriteUpdatedAt: "2026-08-14T10:00:00.000Z",
      },
      rubric: {
        term: "rubric",
        short: "a set of assessment criteria",
        source: "ai",
        at: "2026-08-14T10:30:00.000Z",
        favourite: true,
        favouriteUpdatedAt: "2026-08-14T10:30:00.000Z",
      },
    },
    clientUpdatedAt: "2026-08-14T10:30:00.000Z",
  },
];

globalThis.fetch = async (_input, init = {}) => {
  assert.equal(new Headers(init.headers).get("Authorization"), "Bearer lookup-sync-access-token");
  if ((init.method ?? "GET") === "GET") {
    return Response.json({ snapshots: remoteSnapshots });
  }
  uploadedSnapshots = JSON.parse(String(init.body)).snapshots;
  remoteSnapshots = uploadedSnapshots.map((snapshot) => ({
    ...snapshot,
    clientUpdatedAt: "2026-08-14T11:01:00.000Z",
  }));
  return Response.json({
    at: "2026-08-14T11:01:00.000Z",
    snapshots: remoteSnapshots,
    historyProtected: false,
  });
};

const { syncProgress } = await import(pathToFileURL(
  join(process.cwd(), "lib", "progress", "sync.ts"),
).href);

test("lookup history and the latest favourite state sync between devices", async () => {
  const outcome = await syncProgress();
  assert.equal(outcome.status, "done");

  const uploaded = uploadedSnapshots.find((snapshot) => snapshot.storeKey === LOOKUPS_KEY).payload;
  assert.deepEqual(Object.keys(uploaded).sort(), ["cohort", "estuary", "rubric"]);
  assert.equal(uploaded.cohort.favourite, false, "the later local unpin wins during upload");
  assert.equal(uploaded.cohort.favouriteUpdatedAt, "2026-08-14T11:00:00.000Z");
  assert.equal(uploaded.rubric.favourite, true);

  const restored = JSON.parse(perTab.get(LOOKUPS_KEY));
  assert.deepEqual(Object.keys(restored).sort(), ["cohort", "estuary", "rubric"]);
  assert.equal(restored.cohort.favourite, false);
  assert.equal(restored.rubric.favourite, true);
});

test("pinning and unpinning are synced state changes but never remove lookup history", async () => {
  const lookups = await import(pathToFileURL(
    join(process.cwd(), "lib", "lookups.ts"),
  ).href);

  assert.deepEqual(
    lookups.lookupHistory().map((word) => word.term).sort(),
    ["cohort", "estuary", "rubric"],
  );
  assert.deepEqual(lookups.favouriteWords().map((word) => word.term), ["rubric"]);
  assert.equal(lookups.lookupHistory(), lookups.lookupHistory(), "history snapshots stay stable");
  assert.equal(lookups.favouriteWords(), lookups.favouriteWords(), "favourite snapshots stay stable");

  lookups.setLookupFavourite("cohort", true);
  const pinned = JSON.parse(perTab.get(LOOKUPS_KEY));
  assert.equal(pinned.cohort.favourite, true);
  assert.ok(Number.isFinite(Date.parse(pinned.cohort.favouriteUpdatedAt)));
  assert.deepEqual(
    lookups.favouriteWords().map((word) => word.term).sort(),
    ["cohort", "rubric"],
  );

  lookups.saveLookup({
    term: "cohort",
    short: "a refreshed definition",
    source: "ai",
    at: "2026-08-14T11:30:00.000Z",
  });
  const refreshed = JSON.parse(perTab.get(LOOKUPS_KEY));
  assert.equal(refreshed.cohort.short, "a refreshed definition");
  assert.equal(refreshed.cohort.favourite, true, "a repeated lookup must not clear its pin");
  assert.equal(refreshed.cohort.favouriteUpdatedAt, pinned.cohort.favouriteUpdatedAt);

  lookups.setLookupFavourite("cohort", false);
  const unpinned = JSON.parse(perTab.get(LOOKUPS_KEY));
  assert.equal(unpinned.cohort.favourite, false);
  assert.ok(Number.isFinite(Date.parse(unpinned.cohort.favouriteUpdatedAt)));
  assert.ok(unpinned.cohort.favouriteUpdatedAt >= pinned.cohort.favouriteUpdatedAt);
  assert.ok(lookups.cachedLookup("cohort"), "unpinning must keep the cached history entry");
  assert.ok(
    lookups.lookupHistory().some((word) => word.term === "cohort"),
    "unpinning must keep the word in lookup history",
  );
  assert.deepEqual(lookups.favouriteWords().map((word) => word.term), ["rubric"]);

  assert.ok(
    dispatched.filter((type) => type === "bandup:progress-write").length >= 3,
    "pin, refreshed lookup and unpin must all request account autosync",
  );
});

test("an unavailable definition can still be pinned without becoming a false cache hit", async () => {
  const lookups = await import(pathToFileURL(
    join(process.cwd(), "lib", "lookups.ts"),
  ).href);

  assert.equal(lookups.cachedLookup("automatically"), undefined);
  const saved = lookups.saveLookupForLater("automatically");
  assert.equal(saved?.pendingDefinition, true);
  assert.equal(lookups.cachedLookup("automatically"), undefined);

  const pinned = lookups.setLookupFavourite("automatically", true);
  assert.equal(pinned?.favourite, true);
  assert.ok(
    lookups.favouriteWords().some((word) => word.term === "automatically"),
    "the lookup panel can pin a word even when its definition service failed",
  );

  const complete = lookups.saveLookup({
    term: "automatically",
    short: "in a way that happens without deliberate action",
    source: "ai",
    at: "2026-08-14T14:00:00.000Z",
  });
  assert.equal(complete.pendingDefinition, undefined);
  assert.equal(complete.favourite, true, "a later definition must preserve the learner's pin");
  assert.equal(lookups.cachedLookup("automatically")?.short, complete.short);
});
