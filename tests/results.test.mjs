/*
  The order a learner's results come back in, and who is allowed to care.

  This file exists because of a bug that no type could catch and nothing threw
  on. lib/store.ts addResult prepends, so a single device's list is
  newest-first; lib/progress/merge.ts sorted the union oldest-first. Every
  reader was written against the first of those:

    app/page.tsx    profile.results.find(r => r.module === m.key)  -> the band
                    shown on the dashboard card
    lib/plan.ts     const latest = profile.results.find(...)       -> which
                    module the study plan sends you to next

  Before a sync both were right. After one, both silently returned the
  learner's *first ever* sitting — so a learner who had worked their reading
  from 5.0 to 7.0 would be told they were a 5.0 reader and sent to practise
  reading instead of whatever they were actually weakest at. Nothing failed,
  nothing logged, and the number on screen was a real number they really had
  scored, months earlier.

  Two guards, because one is not enough: the merge must agree with addResult
  about order, and the helpers must be right even if it ever stops agreeing.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const load = (...parts) =>
  import(pathToFileURL(join(process.cwd(), ...parts)).href);

const { latestFor, newestFirst, oldestFirst, seriesFor } = await load("lib", "results.ts");
const { mergeProfiles } = await load("lib", "progress", "merge.ts");

const result = (module, date, band) => ({
  module,
  testId: `${module}-${date}`,
  testTitle: `${module} ${date}`,
  band,
  date,
});

const READING = [
  result("reading", "2026-01-01T00:00:00.000Z", 5),
  result("reading", "2026-03-01T00:00:00.000Z", 7),
  result("reading", "2026-02-01T00:00:00.000Z", 6),
];

test("latestFor returns the most recent sitting whatever the order", () => {
  for (const order of [READING, newestFirst(READING), oldestFirst(READING)]) {
    assert.equal(latestFor(order, "reading").band, 7);
  }
});

test("latestFor ignores other modules", () => {
  const mixed = [...READING, result("listening", "2026-06-01T00:00:00.000Z", 9)];
  assert.equal(latestFor(mixed, "reading").band, 7);
  assert.equal(latestFor(mixed, "listening").band, 9);
});

test("latestFor is undefined for a module never sat", () => {
  assert.equal(latestFor(READING, "writing"), undefined);
});

test("an unparseable date never wins", () => {
  const withJunk = [...READING, result("reading", "not-a-date", 2)];
  assert.equal(latestFor(withJunk, "reading").band, 7);
});

test("newestFirst and oldestFirst are exact opposites and do not mutate", () => {
  const before = READING.map((r) => r.date);
  assert.deepEqual(
    newestFirst(READING).map((r) => r.band),
    [7, 6, 5],
  );
  assert.deepEqual(
    oldestFirst(READING).map((r) => r.band),
    [5, 6, 7],
  );
  assert.deepEqual(READING.map((r) => r.date), before, "input was mutated");
});

test("seriesFor gives one module oldest-first, the direction a trend reads", () => {
  const mixed = [...READING, result("writing", "2026-01-15T00:00:00.000Z", 6.5)];
  assert.deepEqual(
    seriesFor(mixed, "reading").map((r) => r.band),
    [5, 6, 7],
  );
});

/*
  The guard on the bug itself: a merged profile must hand its first element to
  a reader that asks for the newest, exactly as addResult does.
*/
test("mergeProfiles returns results newest-first, like addResult", () => {
  const local = { results: [result("reading", "2026-01-01T00:00:00.000Z", 5)] };
  const remote = { results: [result("reading", "2026-03-01T00:00:00.000Z", 7)] };
  const merged = mergeProfiles(local, remote, 1, 2);

  assert.equal(merged.results.length, 2);
  assert.equal(merged.results[0].band, 7, "the first result must be the newest");
  assert.equal(latestFor(merged.results, "reading").band, 7);
});

test("a merged profile still answers the dashboard's question correctly", () => {
  // The learner improved on their phone; the laptop only knows the old score.
  const laptop = { results: [result("reading", "2026-01-01T00:00:00.000Z", 5)] };
  const phone = {
    results: [
      result("reading", "2026-01-01T00:00:00.000Z", 5),
      result("reading", "2026-06-01T00:00:00.000Z", 7.5),
    ],
  };
  const merged = mergeProfiles(laptop, phone, 1, 2);
  assert.equal(latestFor(merged.results, "reading").band, 7.5);
});

test("visited is unioned across devices and never un-set", () => {
  const laptop = { visited: ["reading"] };
  const phone = { visited: ["listening", "reading"] };
  const merged = mergeProfiles(laptop, phone, 1, 2);
  assert.deepEqual([...merged.visited].sort(), ["listening", "reading"]);
});

test("a device that has visited nothing does not erase the other's list", () => {
  const merged = mergeProfiles({ visited: ["speaking"] }, {}, 1, 2);
  assert.deepEqual(merged.visited, ["speaking"]);
});
