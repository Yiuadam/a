/*
  The merge rules from ACCOUNTS.md threat 5.

  Every test here describes a way a learner could lose work that they would
  never get back and might not even notice: a month of practice replaced by an
  empty plan, a re-sit silently dropped, a placement result erased by a device
  that never took the test. None of those throw. They just quietly return the
  wrong thing, which is why this file is the actual safety and not the types.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { mergeProfiles, mergeDrillScores, mergeLookups } = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "merge.ts")).href
);

const OLD = 1_700_000_000_000;
const NEW = 1_700_009_999_999;

const result = (testId, date, band, module = "reading") => ({
  module,
  testId,
  testTitle: testId,
  band,
  date,
});

/* ---------------------------------------------------------------- profiles */

test("an empty account takes everything the browser has", () => {
  const local = { results: [result("reading-1", "2026-01-01", 6)], targetBand: 7 };
  const merged = mergeProfiles(local, null, NEW, null);
  assert.equal(merged.results.length, 1);
  assert.equal(merged.targetBand, 7);
});

test("a browser with nothing does not wipe the account", () => {
  // The first sign-in on a fresh phone. This is the one that would look like
  // the app had deleted a month of work.
  const remote = { results: [result("reading-1", "2026-01-01", 6)], targetBand: 7 };
  const merged = mergeProfiles(null, remote, null, NEW);
  assert.equal(merged.results.length, 1);
  assert.equal(merged.targetBand, 7);
});

test("results from both devices survive", () => {
  const local = { results: [result("reading-1", "2026-01-01", 6)] };
  const remote = { results: [result("listening-1", "2026-01-02", 7, "listening")] };
  const merged = mergeProfiles(local, remote, OLD, NEW);
  assert.equal(merged.results.length, 2);
});

test("the same sitting recorded on both devices collapses to one", () => {
  const sitting = result("reading-1", "2026-01-01", 6);
  const merged = mergeProfiles({ results: [sitting] }, { results: [{ ...sitting }] }, OLD, NEW);
  assert.equal(merged.results.length, 1);
});

test("sitting the same test twice keeps both attempts", () => {
  // ACCOUNTS.md says "unioned by test id", which taken literally would drop
  // one of these. Losing an attempt is the harm the rule exists to prevent.
  const local = { results: [result("reading-1", "2026-01-01", 5)] };
  const remote = { results: [result("reading-1", "2026-02-01", 7)] };
  const merged = mergeProfiles(local, remote, OLD, NEW);
  assert.equal(merged.results.length, 2);
  assert.deepEqual(
    merged.results.map((r) => r.band),
    [7, 5],
  );
});

test("merged results come back newest first", () => {
  /*
    This assertion used to read the other way round, and that was the bug.
    Order here is not a matter of taste: lib/store.ts addResult prepends, so a
    single device is newest-first, and every reader was written against that —
    the dashboard slices the first six as "recent", lib/plan.ts calls the first
    match `latest`. Sorting the merged union the opposite way meant those
    readers silently switched to the learner's oldest sitting the moment they
    signed in on a second device. See lib/results.ts and tests/results.test.mjs.
  */
  const local = { results: [result("a", "2026-03-01", 7), result("b", "2026-01-01", 5)] };
  const remote = { results: [result("c", "2026-02-01", 6)] };
  const merged = mergeProfiles(local, remote, OLD, NEW);
  assert.deepEqual(
    merged.results.map((r) => r.date),
    ["2026-03-01", "2026-02-01", "2026-01-01"],
  );
});

test("the later placement result wins independently of profile snapshot freshness", () => {
  const local = {
    placement: { band: 6, date: "2026-08-01T10:00:00.000Z" },
    results: [],
  };
  const remote = {
    placement: { band: 7, date: "2026-08-12T10:00:00.000Z" },
    results: [],
  };

  assert.equal(mergeProfiles(local, remote, NEW, OLD).placement.band, 7);
  assert.equal(mergeProfiles(remote, local, OLD, NEW).placement.band, 7);
});

test("a newer unrelated profile write cannot hide a newer placement from another device", () => {
  const local = {
    // This browser changed only the target after its older placement result.
    placement: { band: 5.5, date: "2026-08-01T10:00:00.000Z" },
    targetBand: 8,
    results: [],
  };
  const remote = {
    placement: { band: 7, date: "2026-08-12T10:00:00.000Z" },
    targetBand: 6,
    results: [],
  };

  const merged = mergeProfiles(
    local,
    remote,
    Date.parse("2026-08-14T10:00:00.000Z"),
    Date.parse("2026-08-12T11:00:00.000Z"),
  );

  assert.equal(merged.placement.band, 7);
  assert.equal(merged.placement.date, "2026-08-12T10:00:00.000Z");
  assert.equal(merged.targetBand, 8, "the unrelated newer target-band change still survives");
});

test("a missing or invalid placement date cannot displace a valid result", () => {
  const dated = { band: 7, date: "2026-08-12T10:00:00.000Z" };

  assert.equal(
    mergeProfiles(
      { placement: { band: 5.5 }, results: [] },
      { placement: dated, results: [] },
      NEW,
      OLD,
    ).placement.band,
    7,
  );
  assert.equal(
    mergeProfiles(
      { placement: dated, results: [] },
      { placement: { band: 8, date: "not-a-date" }, results: [] },
      OLD,
      NEW,
    ).placement.band,
    7,
  );
});

test("a device that never sat the placement cannot erase one that did", () => {
  // The subtle one. Syncing more recently is not the same as knowing more.
  const local = { results: [] };
  const remote = { placement: { band: 7 }, results: [] };
  assert.equal(mergeProfiles(local, remote, NEW, OLD).placement.band, 7);
});

/*
  The confirmed production bug: "clear this device" wiped the tab, but the
  account's placement was never told to go, so the very next ordinary sync
  downloaded it straight back — placement merges independently of results by
  design (the test above), and that design has no opinion about a device
  clear at all. placementClearedAt is the fix: its own tombstone, so a clear
  can finally say so.
*/
test("a placement-clear tombstone stops an older snapshot restoring the cleared placement", () => {
  const clearedAt = "2026-08-14T09:00:00.000Z";
  const stale = { placement: { band: 6, date: "2026-08-01T10:00:00.000Z" }, results: [] };
  const cleared = { placement: undefined, placementClearedAt: clearedAt, results: [] };

  const merged = mergeProfiles(stale, cleared, NEW, OLD);
  assert.equal(merged.placement, undefined, "the pre-clear placement must not survive the merge");
  assert.equal(merged.placementClearedAt, clearedAt);

  // Order must not matter: the same result whichever side is "local".
  const reversed = mergeProfiles(cleared, stale, OLD, NEW);
  assert.equal(reversed.placement, undefined);
});

test("a placement sat again after a clear still merges in normally", () => {
  // Requirement 3: clearing is the only thing that may remove a placement,
  // and it must never cost a learner a real one. A learner who clears their
  // laptop and then genuinely re-sits the test on their phone must still see
  // the new result everywhere — the tombstone must not become permanent.
  const clearedAt = "2026-08-14T09:00:00.000Z";
  const cleared = { placementClearedAt: clearedAt, results: [] };
  const freshlyRetaken = {
    placement: { band: 6.5, date: "2026-08-14T10:00:00.000Z" }, // after the clear
    results: [],
  };

  const merged = mergeProfiles(cleared, freshlyRetaken, OLD, NEW);
  assert.equal(merged.placement.band, 6.5);
  assert.equal(merged.placementClearedAt, clearedAt, "the tombstone itself is kept, just no longer suppresses anything");
});

test("placementClearedAt is independent of historyClearedAt: clearing history alone leaves placement alone", () => {
  // components/history/ClearHistoryButton.tsx clears scores and mock reports
  // only; it must never take the placement (and the study plan built on it)
  // down with it.
  const local = {
    placement: { band: 6, date: "2026-08-01T10:00:00.000Z" },
    historyClearedAt: "2026-08-14T09:00:00.000Z",
    results: [],
  };
  const remote = { results: [] };
  const merged = mergeProfiles(local, remote, NEW, OLD);
  assert.equal(merged.placement.band, 6, "a history-only clear must not be read as a placement clear too");
});

test("an unset target band does not overwrite one that is set", () => {
  const merged = mergeProfiles({ results: [] }, { targetBand: 7, results: [] }, NEW, OLD);
  assert.equal(merged.targetBand, 7);
});

test("the newer side wins for the plan's length", () => {
  const local = { planDays: 28, results: [] };
  const remote = { planDays: 5, results: [] };
  assert.equal(mergeProfiles(local, remote, OLD, NEW).planDays, 5);
  assert.equal(mergeProfiles(local, remote, NEW, OLD).planDays, 28);
});

test("an unset plan length does not overwrite one that is set", () => {
  // The learner sets five days on their phone the evening before the exam,
  // then opens the app on a laptop that has never seen the plan page. Syncing
  // more recently is not the same as knowing more.
  const merged = mergeProfiles({ results: [] }, { planDays: 5, results: [] }, NEW, OLD);
  assert.equal(merged.planDays, 5);
});

test("placement history is taken whole from whichever side has one", () => {
  const local = { results: [], placementHistory: [] };
  const remote = { results: [], placementHistory: [["q1", "q2"]] };
  assert.deepEqual(mergeProfiles(local, remote, NEW, OLD).placementHistory, [["q1", "q2"]]);
});

test("malformed input is survived rather than thrown on", () => {
  // A snapshot can be hand-edited, truncated, or written by an older build.
  const merged = mergeProfiles({ results: "nonsense" }, { genTests: 42 }, OLD, NEW);
  assert.deepEqual(merged.results, []);
  assert.deepEqual(merged.genTests, []);
});

test("two null profiles produce an empty one, not a crash", () => {
  const merged = mergeProfiles(null, null, null, null);
  assert.deepEqual(merged.results, []);
  assert.deepEqual(merged.genTests, []);
});

test("a history clear tombstone stops an older device restoring deleted sittings", () => {
  const clearedAt = "2026-04-01T12:00:00.000Z";
  const stale = {
    results: [result("reading-old", "2026-03-01T12:00:00.000Z", 6)],
    mockReports: [
      {
        id: "mock-old",
        startedAt: "2026-03-01T08:00:00.000Z",
        completedAt: "2026-03-01T11:00:00.000Z",
        marks: { overall: 6 },
      },
    ],
  };
  const cleared = { results: [], mockReports: [], historyClearedAt: clearedAt };
  const merged = mergeProfiles(stale, cleared, NEW, OLD);
  assert.deepEqual(merged.results, []);
  assert.deepEqual(merged.mockReports, []);
  assert.equal(merged.historyClearedAt, clearedAt);
});

test("only sittings completed after a history clear survive", () => {
  const clearedAt = "2026-04-01T12:00:00.000Z";
  const local = {
    historyClearedAt: clearedAt,
    results: [result("reading-new", "2026-04-02T12:00:00.000Z", 7)],
    mockReports: [
      {
        id: "mock-new",
        startedAt: "2026-04-02T08:00:00.000Z",
        completedAt: "2026-04-02T11:00:00.000Z",
        marks: { overall: 7 },
      },
    ],
  };
  const remote = {
    results: [result("reading-old", "2026-03-01T12:00:00.000Z", 5)],
  };
  const merged = mergeProfiles(local, remote, OLD, NEW);
  assert.deepEqual(merged.results.map((item) => item.testId), ["reading-new"]);
  assert.deepEqual(merged.mockReports.map((item) => item.id), ["mock-new"]);
});

test("a generated-test deletion tombstone stops the account restoring it", () => {
  const generated = {
    kind: "reading",
    createdAt: "2026-04-01T10:00:00.000Z",
    test: { id: "generated-reading-1", title: "Restored paper" },
  };
  const local = {
    genTests: [],
    deletedGenTests: { "generated-reading-1": "2026-04-02T10:00:00.000Z" },
  };
  const remote = { genTests: [generated] };

  const merged = mergeProfiles(local, remote, NEW, OLD);

  assert.deepEqual(merged.genTests, []);
  assert.equal(
    merged.deletedGenTests["generated-reading-1"],
    "2026-04-02T10:00:00.000Z",
  );
});

test("the newest deletion wins across devices", () => {
  const merged = mergeProfiles(
    { deletedGenTests: { paper: "2026-04-01T10:00:00.000Z" } },
    { deletedGenTests: { paper: "2026-04-03T10:00:00.000Z" } },
    NEW,
    OLD,
  );

  assert.equal(merged.deletedGenTests.paper, "2026-04-03T10:00:00.000Z");
});

test("a generated paper created after an old deletion survives", () => {
  const generated = {
    kind: "listening",
    createdAt: "2026-04-04T10:00:00.000Z",
    test: { id: "paper", title: "Generated again" },
  };
  const merged = mergeProfiles(
    { deletedGenTests: { paper: "2026-04-03T10:00:00.000Z" }, genTests: [] },
    { genTests: [generated] },
    NEW,
    OLD,
  );

  assert.deepEqual(merged.genTests, [generated]);
});

/* ------------------------------------------------------------------ drills */

test("drill scores from both devices are kept", () => {
  const merged = mergeDrillScores(
    { articles: { correct: 6, total: 8, at: "2026-01-01" } },
    { modals: { correct: 7, total: 8, at: "2026-01-02" } },
  );
  assert.equal(Object.keys(merged).length, 2);
});

test("the later attempt at a drill wins, even if it is worse", () => {
  // Consistent with one device, where a fresh attempt already replaces the
  // old score. Keeping the best across devices would make syncing behave
  // differently from not syncing.
  const merged = mergeDrillScores(
    { articles: { correct: 8, total: 8, at: "2026-01-01" } },
    { articles: { correct: 3, total: 8, at: "2026-02-01" } },
  );
  assert.equal(merged.articles.correct, 3);
});

test("an earlier remote attempt does not displace a later local one", () => {
  const merged = mergeDrillScores(
    { articles: { correct: 8, total: 8, at: "2026-03-01" } },
    { articles: { correct: 3, total: 8, at: "2026-01-01" } },
  );
  assert.equal(merged.articles.correct, 8);
});

test("null drill stores merge to an empty object", () => {
  assert.deepEqual(mergeDrillScores(null, null), {});
});

/* ----------------------------------------------------------------- lookups */

test("saved words from both devices are kept", () => {
  const merged = mergeLookups({ river: { term: "river" } }, { culvert: { term: "culvert" } });
  assert.deepEqual(Object.keys(merged).sort(), ["culvert", "river"]);
});

test("saved words are capped, keeping the newest", () => {
  const local = {};
  for (let i = 0; i < 5; i++) local[`w${i}`] = { term: `w${i}` };
  const merged = mergeLookups(local, {}, 3);
  assert.equal(Object.keys(merged).length, 3);
  assert.ok(Object.keys(merged).includes("w4"));
});

test("a merge under the cap is left alone", () => {
  const merged = mergeLookups({ a: 1 }, { b: 2 }, 300);
  assert.deepEqual(merged, { a: 1, b: 2 });
});

test("a richer copy of the same sitting keeps its review", () => {
  const sitting = result("reading-1", "2026-05-01T12:00:00.000Z", 6);
  const reviewed = { ...sitting, review: { questions: [{ correct: true }] } };
  const merged = mergeProfiles({ results: [sitting] }, { results: [reviewed] }, NEW, OLD);
  assert.deepEqual(merged.results, [reviewed]);
});

test("timestamp boundaries preserve only entries created strictly after a clear", () => {
  const clearedAt = Date.parse("2026-05-02T12:00:00.000Z");
  const merged = mergeProfiles(
    {
      historyClearedAt: "2026-05-02T12:00:00.000Z",
      results: [
        result("at-clear", "2026-05-02T12:00:00.000Z", 6),
        result("after-clear", "2026-05-02T12:00:00.001Z", 7),
      ],
      mockReports: [
        { id: "at-clear", completedAt: "2026-05-02T12:00:00.000Z" },
        { id: "after-clear", completedAt: "2026-05-02T12:00:00.001Z" },
      ],
    },
    {},
    NEW,
    OLD,
  );
  assert.deepEqual(merged.results.map((item) => item.testId), ["after-clear"]);
  assert.deepEqual(merged.mockReports.map((item) => item.id), ["after-clear"]);

  assert.deepEqual(mergeDrillScores({
    atClear: { correct: 1, total: 1, at: "2026-05-02T12:00:00.000Z" },
    after: { correct: 1, total: 1, at: "2026-05-02T12:00:00.001Z" },
    undated: { correct: 1, total: 1 },
  }, null, clearedAt), {
    after: { correct: 1, total: 1, at: "2026-05-02T12:00:00.001Z" },
  });
});

test("profile merge retains the latest valid tombstones and rejects malformed generated papers", () => {
  const merged = mergeProfiles(
    {
      drillsClearedAt: "2026-01-02T00:00:00.000Z",
      lookupsClearedAt: "not-a-date",
      deletedGenTests: { latest: "2026-01-03T00:00:00.000Z", malformed: "nope" },
      genTests: [
        { createdAt: "2026-01-04T00:00:00.000Z", test: { id: "latest" } },
        { createdAt: "2026-01-04T00:00:00.000Z", test: { id: "" } },
        { createdAt: "2026-01-04T00:00:00.000Z" },
      ],
    },
    {
      drillsClearedAt: "2026-01-03T00:00:00.000Z",
      lookupsClearedAt: "2026-01-04T00:00:00.000Z",
      deletedGenTests: { latest: "2026-01-05T00:00:00.000Z" },
    },
    OLD,
    NEW,
  );
  assert.equal(merged.drillsClearedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(merged.lookupsClearedAt, "2026-01-04T00:00:00.000Z");
  assert.deepEqual(merged.deletedGenTests, { latest: "2026-01-05T00:00:00.000Z" });
  assert.deepEqual(merged.genTests, []);
});

test("lookup favourites have their own timestamp and survive trimming before ordinary words", () => {
  const pinTime = "2026-05-03T12:00:00.000Z";
  const unpinTime = "2026-05-04T12:00:00.000Z";
  const conflicted = mergeLookups(
    { atlas: { term: "local", at: "2026-05-01", favourite: true, favouriteUpdatedAt: pinTime, localOnly: true } },
    { atlas: { term: "remote", at: "2026-05-02", favourite: false, favouriteUpdatedAt: unpinTime, remoteOnly: true } },
  );
  assert.deepEqual(conflicted.atlas, {
    term: "local",
    at: "2026-05-01",
    favourite: false,
    favouriteUpdatedAt: unpinTime,
    localOnly: true,
    remoteOnly: true,
  });

  const legacy = mergeLookups(
    { old: { at: "2026-05-01", favourite: true } },
    { old: { at: "2026-05-02" } },
  );
  assert.equal(legacy.old.favourite, true);

  const trimmed = mergeLookups({
    favourite: { at: "2026-05-01", favourite: true },
    middle: { at: "2026-05-02" },
    newest: { at: "2026-05-03" },
  }, null, 2);
  assert.deepEqual(Object.keys(trimmed).sort(), ["favourite", "newest"]);
});

test("lookup clear removes stale and undated words while keeping newer lookups", () => {
  const clearedAt = Date.parse("2026-05-02T12:00:00.000Z");
  const merged = mergeLookups({
    before: { at: "2026-05-02T11:59:59.999Z" },
    atClear: { at: "2026-05-02T12:00:00.000Z" },
    after: { at: "2026-05-02T12:00:00.001Z" },
    undated: { term: "undated" },
  }, null, 300, clearedAt);
  assert.deepEqual(merged, { after: { at: "2026-05-02T12:00:00.001Z" } });
});

test("equal snapshot and result timestamps keep the local copy deterministically", () => {
  const sameTime = Date.parse("2026-05-05T12:00:00.000Z");
  const merged = mergeProfiles(
    {
      targetBand: 6,
      planDays: 28,
      placementHistory: [["local"]],
      placement: { band: 6, date: "2026-05-05T12:00:00.000Z" },
      results: [{ ...result("same", "2026-05-05T12:00:00.000Z", 6), review: { source: "local" } }],
    },
    {
      targetBand: 8,
      planDays: 5,
      placementHistory: [["remote"]],
      placement: { band: 8, date: "2026-05-05T12:00:00.000Z" },
      results: [result("same", "2026-05-05T12:00:00.000Z", 8)],
    },
    sameTime,
    sameTime,
  );
  assert.equal(merged.targetBand, 6);
  assert.equal(merged.planDays, 28);
  assert.deepEqual(merged.placementHistory, [["local"]]);
  assert.equal(merged.placement.band, 6);
  assert.deepEqual(merged.results[0].review, { source: "local" });
  assert.equal(mergeDrillScores(
    { tenses: { correct: 8, total: 8, at: "2026-05-05" } },
    { tenses: { correct: 1, total: 8, at: "2026-05-05" } },
  ).tenses.correct, 8);
});

test("mock reports remain newest first and retain only their newest thirty", () => {
  const mockReports = Array.from({ length: 31 }, (_, index) => ({
    id: `mock-${index}`,
    completedAt: `2026-05-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  }));
  const merged = mergeProfiles({ mockReports }, null, NEW, OLD);
  assert.equal(merged.mockReports.length, 30);
  assert.equal(merged.mockReports[0].id, "mock-30");
  assert.equal(merged.mockReports.at(-1).id, "mock-1");
});

test("lookup collision rules preserve local definitions and resolve equal favourite revisions locally", () => {
  const revision = "2026-05-06T12:00:00.000Z";
  const merged = mergeLookups(
    {
      word: { term: "local definition", at: "2026-05-01", favourite: true, favouriteUpdatedAt: revision },
      primitive: "local value",
    },
    {
      word: { term: "remote definition", at: "2026-05-02", favourite: false, favouriteUpdatedAt: revision },
      primitive: { term: "remote object" },
    },
  );
  assert.equal(merged.word.term, "local definition");
  assert.equal(merged.word.favourite, true);
  assert.equal(merged.primitive, "local value");
});
