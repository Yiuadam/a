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
