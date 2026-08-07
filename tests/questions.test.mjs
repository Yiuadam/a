/*
  The question-set helpers are load-bearing: scoring, review, advice and the
  renderer all normalise through them, and every question type still to be
  built arrives as a group. Two properties matter enough to pin down.

  Continuous numbering — IELTS numbers a paper 1-40 straight through however
  many blocks it is divided into, and candidates transfer those numbers to an
  answer sheet. Restarting the count per block would put the wrong number
  beside the question.

  Back-compat — every test shipped so far is a flat array. If a flat paper
  stops marking correctly, every existing test in the app breaks at once.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const {
  flatQuestions,
  isGrouped,
  numberedGroups,
  questionCount,
  toGroups,
} = await import(pathToFileURL(join(process.cwd(), "lib", "questions.ts")).href);

const q = (id) => ({ id, type: "mcq", question: id, options: ["a", "b", "c"], answer: 0 });

const FLAT = [q("q1"), q("q2"), q("q3")];
const GROUPED = [
  { instruction: "Do the first thing.", questions: [q("q1"), q("q2")] },
  { instruction: "Do the second thing.", questions: [q("q3"), q("q4"), q("q5")] },
];

test("a flat array is recognised as flat, and a grouped one as grouped", () => {
  assert.equal(isGrouped(FLAT), false);
  assert.equal(isGrouped(GROUPED), true);
  // An empty paper has no shape to detect; treating it as flat keeps every
  // caller on the path that copes with nothing to render.
  assert.equal(isGrouped([]), false);
});

test("a flat array survives every helper unchanged", () => {
  assert.deepEqual(flatQuestions(FLAT), FLAT);
  assert.equal(questionCount(FLAT), 3);
  const groups = toGroups(FLAT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].instruction, "");
  assert.deepEqual(groups[0].questions, FLAT);
});

test("grouping flattens back to the original order", () => {
  assert.deepEqual(
    flatQuestions(GROUPED).map((x) => x.id),
    ["q1", "q2", "q3", "q4", "q5"],
  );
  assert.equal(questionCount(GROUPED), 5);
});

test("numbering runs continuously across blocks, not restarting per block", () => {
  const blocks = numberedGroups(GROUPED);
  assert.deepEqual(
    blocks.flatMap((b) => b.questions.map((x) => x.number)),
    [1, 2, 3, 4, 5],
  );
  assert.equal(blocks[1].questions[0].number, 3, "second block must not restart at 1");
});

test("each block reports the range it covers, for its printed heading", () => {
  const [first, second] = numberedGroups(GROUPED);
  assert.deepEqual([first.from, first.to], [1, 2]);
  assert.deepEqual([second.from, second.to], [3, 5]);
});

test("a flat paper numbers from 1 exactly as it did before groups existed", () => {
  const [only] = numberedGroups(FLAT);
  assert.deepEqual(
    only.questions.map((x) => x.number),
    [1, 2, 3],
  );
});

test("an empty paper produces one empty block rather than throwing", () => {
  const blocks = numberedGroups([]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].questions, []);
});
