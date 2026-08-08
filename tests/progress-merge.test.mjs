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

test("the newer side wins for the placement result", () => {
  const local = { placement: { band: 6 }, results: [] };
  const remote = { placement: { band: 7 }, results: [] };
  assert.equal(mergeProfiles(local, remote, OLD, NEW).placement.band, 7);
  assert.equal(mergeProfiles(local, remote, NEW, OLD).placement.band, 6);
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
