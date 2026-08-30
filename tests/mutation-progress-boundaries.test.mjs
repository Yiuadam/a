/*
  Local-only regression boundaries for the progress merge.  These cases are
  intentionally narrow so scripts/mutation-test.mjs can run independently of
  the broader feature suite and without any service configuration.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { mergeProfiles } = await import(
  pathToFileURL(join(process.cwd(), "lib", "progress", "merge.ts")).href,
);

const OLD = Date.parse("2026-08-01T00:00:00.000Z");
const NEW = Date.parse("2026-08-14T00:00:00.000Z");

test("placement chooses its own newest valid date, not an unrelated profile write", () => {
  const merged = mergeProfiles(
    {
      placement: { band: 5.5, date: "2026-08-01T10:00:00.000Z" },
      targetBand: 8,
      results: [],
    },
    {
      placement: { band: 7, date: "2026-08-12T10:00:00.000Z" },
      targetBand: 6,
      results: [],
    },
    NEW,
    OLD,
  );

  assert.equal(merged.placement?.band, 7);
  assert.equal(merged.targetBand, 8);
});

test("a placement at or before its clear watermark cannot return", () => {
  const clearedAt = "2026-08-14T09:00:00.000Z";
  const merged = mergeProfiles(
    { placement: { band: 6, date: clearedAt }, results: [] },
    { placementClearedAt: clearedAt, results: [] },
    NEW,
    OLD,
  );
  assert.equal(merged.placement, undefined);
});

test("an undated placement cannot displace a valid placement", () => {
  const merged = mergeProfiles(
    { placement: { band: 5.5 }, results: [] },
    { placement: { band: 7, date: "2026-08-12T10:00:00.000Z" }, results: [] },
    NEW,
    OLD,
  );
  assert.equal(merged.placement?.band, 7);
});

test("a sitting at the history-clear watermark cannot return", () => {
  const clearedAt = "2026-04-01T12:00:00.000Z";
  const merged = mergeProfiles(
    {
      results: [{ module: "reading", testId: "equal", testTitle: "equal", band: 6, date: clearedAt }],
    },
    { historyClearedAt: clearedAt, results: [] },
    NEW,
    OLD,
  );
  assert.deepEqual(merged.results, []);
});
