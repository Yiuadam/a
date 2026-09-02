/*
  IELTS One Skill Retake: the arithmetic, and what a retake is allowed to touch.

  Every failure this file catches is silent. A retake that replaced the wrong
  module, an overall averaged from three bands, a retake that could not be
  marked quietly erasing a band the learner earned last month — all of them
  render perfectly, and the learner simply carries away a number that is not
  their band, or opens history to find one missing. Nothing in the types says a
  word about any of it, so it is said here.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
  The alias hook rather than scripts/ts-resolve.mjs, because lib/exam/mock.ts
  reaches the content bank: it imports every reading and listening paper as
  JSON, and only this hook can hand those to Node without the import attribute
  a bundler never writes.
*/
register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);

const {
  REPORT_MODULES,
  currentSitting,
  overallBand,
  retakesOf,
  standingFor,
  standingRecord,
} = await load("lib", "exam", "report.ts");
const { mergeProfiles } = await load("lib", "progress", "merge.ts");
const { MOCK_MODULES, nextStage, overallFrom, recordRetake, sittingModules } = await load(
  "lib",
  "exam",
  "mock.ts",
);

const report = (id, bands, completedAt = "2026-01-10T10:00:00.000Z") => ({
  id,
  startedAt: completedAt,
  completedAt,
  marks: {
    listening: bands.listening === null ? null : { band: bands.listening, raw: 30, total: 40 },
    reading: bands.reading === null ? null : { band: bands.reading, raw: 27, total: 40 },
    writing: bands.writing === null ? null : { band: bands.writing },
    speaking: bands.speaking === null ? null : { band: bands.speaking },
    overall: bands.overall ?? null,
    unmarked: [],
  },
});

const retake = (id, of, module, band, completedAt) => ({
  id,
  of,
  module,
  band,
  startedAt: completedAt,
  completedAt,
});

const bandOf = (record, module) =>
  record.modules.find((entry) => entry.module === module)?.band ?? null;

/* ------------------------------------------------------------- the overall */

test("the overall is the mean of four, rounded the way IELTS rounds", () => {
  /* .25 up and .75 up — the official rule, and the reason roundToHalf exists. */
  assert.equal(overallBand({ listening: 6, reading: 6, writing: 6, speaking: 7 }), 6.5);
  assert.equal(overallBand({ listening: 6, reading: 6, writing: 6, speaking: 6 }), 6);
  assert.equal(overallBand({ listening: 6.5, reading: 6.5, writing: 6, speaking: 6 }), 6.5);
  assert.equal(overallBand({ listening: 7, reading: 6.5, writing: 6, speaking: 6 }), 6.5);
  assert.equal(overallBand({ listening: 7, reading: 7, writing: 6.5, speaking: 6 }), 6.5);
  assert.equal(overallBand({ listening: 7, reading: 7, writing: 7, speaking: 6 }), 7);
});

test("no overall band from fewer than four marked skills", () => {
  for (const missing of REPORT_MODULES) {
    const bands = { listening: 7, reading: 7, writing: 7, speaking: 7 };
    delete bands[missing];
    assert.equal(overallBand(bands), null, `${missing} missing must withhold the overall`);
    bands[missing] = null;
    assert.equal(overallBand(bands), null, `${missing} null must withhold the overall`);
  }
  assert.equal(overallBand({}), null);
});

test("an overall cannot be manufactured by adding keys that are not skills", () => {
  /*
    The rule is "all four, or nothing". A version that summed the values it was
    handed and divided by their count would answer this with a confident 7.
  */
  assert.equal(
    overallBand({ listening: 7, reading: 7, writing: 7, grammar: 7, vocabulary: 7 }),
    null,
  );
});

test("a sitting's overall and a standing form's overall are the same function", () => {
  /*
    Two ways to reach four bands — one sitting, or a sitting updated by a
    retake — and a learner must not be handed a number by one route that the
    other would have refused.
  */
  const marks = overallFrom({
    listening: { band: 7 },
    reading: { band: 6 },
    writing: { band: 6.5 },
    speaking: { band: 6 },
  });
  assert.equal(marks.overall, 6.5);
  assert.equal(
    marks.overall,
    overallBand({ listening: 7, reading: 6, writing: 6.5, speaking: 6 }),
  );

  const withoutWriting = overallFrom({
    listening: { band: 7 },
    reading: { band: 6 },
    writing: null,
    speaking: { band: 6 },
  });
  assert.equal(withoutWriting.overall, null);
  assert.deepEqual(withoutWriting.unmarked, ["writing"]);
});

/* --------------------------------------------------------- the retake model */

test("a retake replaces one band and leaves the other three exactly as they were", () => {
  const sitting = report("mock-1", { listening: 6, reading: 6.5, writing: 6, speaking: 6.5 });
  const before = standingFor(sitting, []);
  assert.equal(before.overall, 6.5);

  const after = standingFor(sitting, [
    retake("retake-1", "mock-1", "listening", 7.5, "2026-02-01T10:00:00.000Z"),
  ]);

  assert.equal(bandOf(after, "listening"), 7.5);
  assert.equal(bandOf(after, "reading"), 6.5);
  assert.equal(bandOf(after, "writing"), 6);
  assert.equal(bandOf(after, "speaking"), 6.5);
  /* (7.5 + 6.5 + 6 + 6.5) / 4 = 6.625, which rounds up to 6.5's neighbour. */
  assert.equal(after.overall, 6.5);

  const bigger = standingFor(sitting, [
    retake("retake-2", "mock-1", "listening", 9, "2026-02-01T10:00:00.000Z"),
  ]);
  /* (9 + 6.5 + 6 + 6.5) / 4 = 7.0 */
  assert.equal(bigger.overall, 7);
});

test("the sitting itself is never edited by a retake", () => {
  const sitting = report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 });
  const snapshot = JSON.stringify(sitting);
  standingFor(sitting, [retake("r1", "mock-1", "reading", 8, "2026-02-01T10:00:00.000Z")]);
  assert.equal(JSON.stringify(sitting), snapshot, "the original report must be immutable");
});

test("the original band stays visible beside the one that replaced it", () => {
  const sitting = report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 });
  const after = standingFor(sitting, [
    retake("r1", "mock-1", "speaking", 7, "2026-02-01T10:00:00.000Z"),
  ]);
  const speaking = after.modules.find((entry) => entry.module === "speaking");
  assert.equal(speaking.band, 7);
  assert.equal(speaking.original, 6);
  assert.equal(speaking.retakes, 1);

  const listening = after.modules.find((entry) => entry.module === "listening");
  assert.equal(listening.original, null, "a skill never re-sat has no 'was' to show");
  assert.equal(listening.retakes, 0);
});

test("the latest retake wins, not the best one", () => {
  /*
    Best-wins would make the standing band a personal record rather than a
    measurement, and this is the number a learner uses to decide whether to
    book the real test.
  */
  const sitting = report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 });
  const after = standingFor(sitting, [
    retake("r1", "mock-1", "listening", 8, "2026-02-01T10:00:00.000Z"),
    retake("r2", "mock-1", "listening", 6.5, "2026-03-01T10:00:00.000Z"),
  ]);
  assert.equal(bandOf(after, "listening"), 6.5);
  const listening = after.modules.find((entry) => entry.module === "listening");
  assert.equal(listening.original, 6, "the sitting's band, not the intervening retake");
  assert.equal(listening.retakes, 2);
  assert.equal(after.issuedAt, "2026-03-01T10:00:00.000Z");
});

test("a retake can supply a band the sitting never had, and the overall appears", () => {
  /*
    A sitting whose Writing could not be marked has no overall at all. Retaking
    Writing on a plan that can mark it produces the fourth number, and the
    overall arrives from the ordinary rule with no special case anywhere.
  */
  const sitting = report("mock-1", { listening: 7, reading: 7, writing: null, speaking: 6.5 });
  const before = standingFor(sitting, []);
  assert.equal(before.overall, null);
  assert.deepEqual(before.unmarked, ["writing"]);

  const after = standingFor(sitting, [
    retake("r1", "mock-1", "writing", 6.5, "2026-02-01T10:00:00.000Z"),
  ]);
  assert.deepEqual(after.unmarked, []);
  assert.equal(after.overall, 7);
});

test("a retake against another sitting cannot touch this one", () => {
  const sitting = report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 });
  const after = standingFor(sitting, [
    retake("r1", "mock-2", "listening", 9, "2026-02-01T10:00:00.000Z"),
  ]);
  assert.equal(bandOf(after, "listening"), 6);
  assert.equal(after.overall, 6);
  assert.deepEqual(retakesOf("mock-1", [retake("r1", "mock-2", "reading", 9, "2026-02-01")]), []);
});

test("a malformed retake is dropped rather than allowed to replace a real band", () => {
  const sitting = report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 });
  const junk = [
    null,
    undefined,
    { id: "a", of: "mock-1", module: "listening", completedAt: "2026-02-01T10:00:00.000Z" },
    { id: "b", of: "mock-1", module: "listening", band: "seven", completedAt: "2026-02-01T10:00:00.000Z" },
    { id: "c", of: "mock-1", module: "grammar", band: 8, completedAt: "2026-02-01T10:00:00.000Z" },
    { id: "d", of: "mock-1", module: "listening", band: 8, completedAt: "not a date" },
    { id: "e", of: "mock-1", module: "listening", band: Number.NaN, completedAt: "2026-02-01T10:00:00.000Z" },
  ];
  const after = standingFor(sitting, junk);
  assert.equal(bandOf(after, "listening"), 6);
  assert.equal(after.overall, 6);
  assert.equal(after.history.length, 0);
});

/* ------------------------------------------------- which sitting is standing */

test("the standing record is the most recent sitting, found by date not position", () => {
  const older = report("mock-old", { listening: 5, reading: 5, writing: 5, speaking: 5 }, "2026-01-01T10:00:00.000Z");
  const newer = report("mock-new", { listening: 7, reading: 7, writing: 7, speaking: 7 }, "2026-05-01T10:00:00.000Z");
  for (const order of [[older, newer], [newer, older]]) {
    assert.equal(currentSitting(order).id, "mock-new");
    assert.equal(standingRecord(order, []).overall, 7);
  }
});

test("a fresh full sitting supersedes an older one's retakes", () => {
  const older = report("mock-old", { listening: 5, reading: 5, writing: 5, speaking: 5 }, "2026-01-01T10:00:00.000Z");
  const newer = report("mock-new", { listening: 6, reading: 6, writing: 6, speaking: 6 }, "2026-05-01T10:00:00.000Z");
  const retakes = [retake("r1", "mock-old", "listening", 9, "2026-02-01T10:00:00.000Z")];
  const standing = standingRecord([newer, older], retakes);
  assert.equal(standing.reportId, "mock-new");
  assert.equal(bandOf(standing, "listening"), 6, "the old sitting's retake does not follow it");
  assert.equal(standing.overall, 6);
  /* But it is not deleted — it is still attached to the sitting it was sat for. */
  assert.equal(standingFor(older, retakes).modules.find((m) => m.module === "listening").band, 9);
});

test("no full sitting means no standing record, rather than an invented one", () => {
  assert.equal(standingRecord([], []), null);
  assert.equal(standingRecord(undefined, undefined), null);
  assert.equal(currentSitting(null), null);
});

test("the form is dated to the latest thing on it", () => {
  const sitting = report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 }, "2026-01-10T10:00:00.000Z");
  assert.equal(standingFor(sitting, []).issuedAt, "2026-01-10T10:00:00.000Z");
  const after = standingFor(sitting, [
    retake("r1", "mock-1", "reading", 7, "2026-02-20T10:00:00.000Z"),
  ]);
  assert.equal(after.satAt, "2026-01-10T10:00:00.000Z");
  assert.equal(after.issuedAt, "2026-02-20T10:00:00.000Z");
});

/* ------------------------------------------------------------- the sitting */

test("a retake session covers one module and ends after it", () => {
  const full = { retake: undefined };
  assert.deepEqual([...sittingModules(full)], [...MOCK_MODULES]);
  assert.equal(nextStage(full, "listening"), "reading");
  assert.equal(nextStage(full, "reading"), "writing");
  assert.equal(nextStage(full, "writing"), "speaking");
  assert.equal(nextStage(full, "speaking"), "results");

  for (const skill of MOCK_MODULES) {
    const one = { retake: { of: "mock-1", module: skill } };
    assert.deepEqual([...sittingModules(one)], [skill]);
    assert.equal(nextStage(one, skill), "results", `a ${skill} retake must end at the results`);
  }
});

test("a session read back without a retake key is a full sitting", () => {
  /*
    The migration path. `retake` is optional precisely so a sitting stored by
    an older build — somebody two hours in when this ships — still loads as
    what it is instead of being discarded by a version bump.
  */
  const stored = JSON.parse('{"version":1,"id":"mock-x","stage":"reading"}');
  assert.deepEqual([...sittingModules(stored)], [...MOCK_MODULES]);
  assert.equal(nextStage(stored, "reading"), "writing");
});

test("a retake that could not be marked records nothing at all", () => {
  /*
    The one way this feature could destroy something. A retake stored with no
    band would replace a real band in the standing form with a gap, and a
    learner would open history to find the 7.0 they earned has become "not
    marked" because they tried to improve it.
  */
  const session = {
    id: "retake-1",
    startedAt: "2026-02-01T09:00:00.000Z",
    retake: { of: "mock-1", module: "writing" },
  };
  assert.equal(recordRetake(session, null, "2026-02-01T10:00:00.000Z"), null);

  const recorded = recordRetake(session, { band: 7 }, "2026-02-01T10:00:00.000Z");
  assert.equal(recorded.of, "mock-1");
  assert.equal(recorded.module, "writing");
  assert.equal(recorded.band, 7);
  assert.equal(recorded.completedAt, "2026-02-01T10:00:00.000Z");

  /* A full sitting handed to the retake recorder is not a retake. */
  assert.equal(recordRetake({ id: "mock-2" }, { band: 7 }, "2026-02-01T10:00:00.000Z"), null);
});

/* ----------------------------------------------------------------- syncing */

test("two devices each retaking a different skill keep both retakes", () => {
  /*
    This is why retakes are a flat list on the profile rather than a field
    inside each report. Nested, both devices would hold one object under one
    report id, and the union would keep one of them — so an afternoon's work
    would vanish for whichever learner synced second.
  */
  const phone = {
    mockReports: [report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 })],
    mockRetakes: [retake("r-phone", "mock-1", "listening", 7, "2026-02-01T10:00:00.000Z")],
  };
  const laptop = {
    mockReports: [report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 })],
    mockRetakes: [retake("r-laptop", "mock-1", "writing", 7, "2026-02-02T10:00:00.000Z")],
  };
  const merged = mergeProfiles(phone, laptop, 2, 1);
  assert.equal(merged.mockReports.length, 1);
  assert.deepEqual(
    merged.mockRetakes.map((item) => item.id).sort(),
    ["r-laptop", "r-phone"],
  );

  const standing = standingRecord(merged.mockReports, merged.mockRetakes);
  assert.equal(bandOf(standing, "listening"), 7);
  assert.equal(bandOf(standing, "writing"), 7);
  assert.equal(standing.overall, 6.5);
});

test("clearing history takes the retakes with the sittings they belong to", () => {
  const clearedAt = "2026-03-01T00:00:00.000Z";
  const stale = {
    mockReports: [report("mock-1", { listening: 6, reading: 6, writing: 6, speaking: 6 }, "2026-01-01T10:00:00.000Z")],
    mockRetakes: [retake("r1", "mock-1", "listening", 8, "2026-02-01T10:00:00.000Z")],
  };
  const cleared = { mockReports: [], mockRetakes: [], historyClearedAt: clearedAt };
  const merged = mergeProfiles(cleared, stale, 2, 1);
  assert.deepEqual(merged.mockReports, []);
  assert.deepEqual(merged.mockRetakes, []);
  assert.equal(standingRecord(merged.mockReports, merged.mockRetakes), null);
});

test("a retake sat after a clear still survives the clear", () => {
  const clearedAt = "2026-03-01T00:00:00.000Z";
  const kept = {
    mockReports: [report("mock-2", { listening: 6, reading: 6, writing: 6, speaking: 6 }, "2026-03-05T10:00:00.000Z")],
    mockRetakes: [retake("r-new", "mock-2", "reading", 8, "2026-03-06T10:00:00.000Z")],
  };
  const merged = mergeProfiles({ historyClearedAt: clearedAt }, kept, 2, 1);
  assert.deepEqual(merged.mockRetakes.map((item) => item.id), ["r-new"]);
  assert.equal(bandOf(standingRecord(merged.mockReports, merged.mockRetakes), "reading"), 8);
});
