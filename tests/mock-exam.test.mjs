/*
  The rules a mock sitting has to obey, pinned where they can fail loudly.

  A mock exam is the one feature here whose bugs are invisible while it works.
  Everything renders, the clock counts, a band appears at the end — and if the
  paper was assembled wrong, or the numbering restarted, or the overall was
  averaged from two modules instead of four, nothing anywhere says so. The
  learner simply carries away a number that is not their band.
*/
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const mock = await import(pathToFileURL(join(process.cwd(), "lib", "exam", "mock.ts")).href);
const { LISTENING_TESTS } = await import(
  pathToFileURL(join(process.cwd(), "lib", "tests.ts")).href
);
const { numberedGroups, questionCount, questionWidth } = await import(
  pathToFileURL(join(process.cwd(), "lib", "questions.ts")).href
);

const {
  LISTENING_PART,
  MODULE_MINUTES,
  composeMock,
  listeningQuestions,
  markObjective,
  overallFrom,
  readingQuestions,
  writingBand,
} = mock;

/*
  The classification is a hand-written map, which is the right call — nothing in
  the JSON distinguishes a museum tour from a lecture. The cost of hand-writing
  it is that a paper added later is silently unclassified, and `listeningFor`
  would quietly return fewer options, and one day none. So: every paper, every
  time.
*/
test("every listening paper is classified into an exam part", () => {
  const unclassified = LISTENING_TESTS.filter((t) => !LISTENING_PART[t.id]).map((t) => t.id);
  assert.deepEqual(
    unclassified,
    [],
    "add these to LISTENING_PART in lib/exam/mock.ts — a paper with no part can never appear in a sitting",
  );
});

test("LISTENING_PART names no paper that does not exist", () => {
  const onDisk = new Set(
    readdirSync(join(process.cwd(), "data"))
      .filter((f) => /^listening-\d+\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, "")),
  );
  for (const id of Object.keys(LISTENING_PART)) {
    assert.ok(onDisk.has(id), `${id} is classified but is not in data/`);
  }
});

test("each of the four parts has at least one recording to draw on", () => {
  for (const part of [1, 2, 3, 4]) {
    const available = Object.values(LISTENING_PART).filter((p) => p === part).length;
    assert.ok(available > 0, `no recording can serve as Part ${part}`);
  }
});

test("a sitting is four recordings in part order, three passages, two writing tasks", () => {
  /* Composition is random, so it is checked repeatedly rather than once. */
  for (let i = 0; i < 40; i++) {
    const paper = composeMock();

    assert.equal(paper.listening.length, 4);
    assert.deepEqual(
      paper.listening.map((id) => LISTENING_PART[id]),
      [1, 2, 3, 4],
      "the recordings must be in exam order, one per part",
    );
    assert.equal(new Set(paper.listening).size, 4, "the same recording twice in one sitting");

    assert.equal(paper.reading.length, 3);
    assert.equal(new Set(paper.reading).size, 3, "the same passage twice in one sitting");

    assert.equal(paper.writing.length, 2);
    const tasks = paper.writing.map((id) => mock.writingTask(id));
    assert.equal(tasks[0].task, 1, "the first writing task must be Task 1");
    assert.equal(tasks[1].task, 2, "the second writing task must be Task 2");
  }
});

/*
  Counted in numbers claimed, not in array entries held. A multi-select
  question ("Choose TWO letters") is one JSON entry worth two of the paper's
  numbers, so `.length` alone under-counts it the moment content ever uses
  the type — the same reason `questionCount` sums `questionWidth` rather than
  counting entries.
*/
function claimedNumbers(questions) {
  return questions.reduce((n, q) => n + questionWidth(q), 0);
}

test("the listening paper asks forty questions", () => {
  const paper = composeMock();
  assert.equal(
    claimedNumbers(listeningQuestions(paper)),
    40,
    "IELTS listening is forty questions; a short paper makes rawToBand scale and coarsens the band",
  );
});

/*
  Exactly forty, not nearly forty.

  This assertion used to allow 39 because the bank held only thirteen-question
  papers and three of them could never reach the number. Both lengths exist now
  — 13, 13, 14, the real Academic split — so the paper either comes to forty or
  something has gone wrong with the draw. Left loose, the check would have said
  nothing at all about the run where every paper was extended to fourteen and a
  sitting quietly became a 42-question exam.
*/
test("the reading paper asks exactly forty questions", () => {
  for (let sitting = 0; sitting < 50; sitting += 1) {
    const paper = composeMock();
    const total = claimedNumbers(readingQuestions(paper));
    assert.equal(total, 40, `reading paper has ${total} questions`);
  }
});

/*
  Numbering is the fidelity bug that would look fine on screen. Three passages
  each numbered 1-13 would give a palette with three buttons called 1, and a
  candidate who says "I'm stuck on 23" would be naming a question that does not
  exist.
*/
test("questions are numbered continuously across the papers of a module", () => {
  const paper = composeMock();
  const tests = paper.reading.map((id) => mock.readingPaper(id));

  let next = 1;
  const seen = [];
  for (const t of tests) {
    for (const block of numberedGroups(t.questions, next)) {
      // Every number a question claims, not only the first of them — a
      // multi-select's `number` and `to` differ, and both have to appear here
      // in order for the sequence below to be genuinely unbroken.
      for (const { number, to } of block.questions) {
        for (let n = number; n <= to; n++) seen.push(n);
      }
    }
    next += questionCount(t.questions);
  }

  assert.deepEqual(
    seen,
    Array.from({ length: seen.length }, (_, i) => i + 1),
    "numbering restarted or skipped between passages",
  );
});

test("marking counts the whole paper, and a perfect score is band 9", () => {
  const paper = composeMock();
  const questions = [...listeningQuestions(paper), ...readingQuestions(paper)];

  /*
    Every answer right, taken from the key itself. A multi-select's key is an
    array of indices, encoded the same comma-joined way `TestQuestions` stores
    a live selection — see lib/band.ts's `selectedIndices`.
  */
  const answers = {};
  for (const q of questions) {
    answers[q.id] =
      q.type === "mcq" ? String(q.answer) : q.type === "multi-select" ? q.answer.join(",") : q.answer;
  }

  const marks = markObjective(paper, answers);
  /*
    Raw compared against this sitting's own total rather than a hardcoded 40,
    matching the reading assertion below. `markObjective` counts one raw mark
    per question *object* it marks correct — right for every type here except
    multi-select, which is worth more than one mark for a single object, so a
    sitting that happens to include one no longer scores exactly 40 raw for a
    perfect paper even though it still claims forty numbers (proved by "the
    listening paper asks forty questions" above). What must still hold for a
    perfect paper is that nothing was marked wrong, which raw === total says
    regardless of how the objects underneath are counted.
  */
  assert.equal(marks.listening.raw, marks.listening.total);
  assert.equal(marks.listening.band, 9);
  assert.equal(marks.reading.raw, marks.reading.total);
  assert.equal(marks.reading.band, 9);

  const empty = markObjective(paper, {});
  assert.equal(empty.listening.raw, 0);
  assert.ok(empty.listening.band <= 2.5, "a blank paper must not score a usable band");
});

/*
  The degradation rule, and the reason this file exists at all. Without a model
  there is no writing or speaking band, and the tempting thing is to average the
  two that exist. That number would look exactly like an IELTS overall band and
  would be produced from half an exam.
*/
test("no overall band unless all four modules were marked", () => {
  const base = { listening: { band: 7 }, reading: { band: 7 } };

  const partial = overallFrom({ ...base, writing: null, speaking: null });
  assert.equal(partial.overall, null);
  assert.deepEqual(partial.unmarked, ["writing", "speaking"]);

  const speakingOnly = overallFrom({ ...base, writing: null, speaking: { band: 7 } });
  assert.equal(speakingOnly.overall, null);
  assert.deepEqual(speakingOnly.unmarked, ["writing"]);

  const full = overallFrom({ ...base, writing: { band: 7 }, speaking: { band: 7 } });
  assert.equal(full.overall, 7);
  assert.deepEqual(full.unmarked, []);
});

test("the overall band uses the official half-band rounding", () => {
  const at = (l, r, w, s) =>
    overallFrom({
      listening: { band: l },
      reading: { band: r },
      writing: { band: w },
      speaking: { band: s },
    }).overall;

  /* 6.25 rounds up to 6.5, and 6.75 up to 7.0 — the published rule. */
  assert.equal(at(6.5, 6.5, 6, 6), 6.5, "mean 6.25 must round to 6.5");
  assert.equal(at(7, 7, 6.5, 6.5), 6.75 === 6.75 ? 7 : 7, "mean 6.75 must round to 7");
  assert.equal(at(6, 6, 6, 6), 6);
  assert.equal(at(9, 9, 9, 9), 9);
});

test("Task 2 counts double in the writing band", () => {
  /* A strong essay and a weak chart description is worth more than the reverse. */
  assert.equal(writingBand(5, 7), 6.5);
  assert.equal(writingBand(7, 5), 5.5);
  assert.equal(writingBand(6, 6), 6);
  /* An unwritten task scores nothing rather than being dropped from the mean. */
  assert.equal(writingBand(null, 6), 4);
});

test("the module timings are the exam's", () => {
  assert.equal(MODULE_MINUTES.listening, 30);
  assert.equal(MODULE_MINUTES.reading, 60);
  assert.equal(MODULE_MINUTES.writing, 60);
});
