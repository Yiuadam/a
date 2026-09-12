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
  questionWidth,
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
  // An empty block owns no numbers; claiming one would print a heading for a
  // number the next block is about to use.
  assert.deepEqual([blocks[0].from, blocks[0].to], [0, 0]);
});

test("a set that mixes blocks and bare questions keeps every question, in order", () => {
  // The type forbids this and the validator rejects it, but hand-authored JSON
  // is how every question type from here on arrives. A slip should render as
  // itself rather than drop questions or crash.
  const mixed = [
    { instruction: "Do the first thing.", questions: [q("g1"), q("g2")] },
    q("loose1"),
    q("loose2"),
    { instruction: "Do the last thing.", questions: [q("g3")] },
  ];
  assert.deepEqual(
    flatQuestions(mixed).map((x) => x.id),
    ["g1", "g2", "loose1", "loose2", "g3"],
  );
  assert.equal(questionCount(mixed), 5);
  const blocks = numberedGroups(mixed);
  assert.equal(blocks.length, 3, "consecutive loose questions collect into one block");
  assert.deepEqual(
    blocks.flatMap((b) => b.questions.map((x) => x.number)),
    [1, 2, 3, 4, 5],
  );
});

test("a paper of only bare questions after a group still numbers continuously", () => {
  const trailing = [{ instruction: "Block.", questions: [q("a")] }, q("b")];
  assert.deepEqual(
    numberedGroups(trailing).flatMap((b) => b.questions.map((x) => x.number)),
    [1, 2],
  );
});

/* ---------------------------------------------------------------------------
   A multi-select question claims more than one paper number for a single
   JSON entry — "Questions 15 and 16" is one item, not two — so every helper
   that counts or numbers a paper has to count numbers claimed, not entries
   held. This is the one property added for it.
   --------------------------------------------------------------------------- */

/** A multi-select asking for `numAnswers` letters, otherwise unremarkable. */
const ms = (id, numAnswers) => ({
  id,
  type: "multi-select",
  question: id,
  options: ["a", "b", "c", "d", "e", "f", "g"].slice(0, numAnswers + 2),
  numAnswers,
  answer: Array.from({ length: numAnswers }, (_, i) => i),
});

test("questionWidth is 1 for an ordinary question and numAnswers for multi-select", () => {
  assert.equal(questionWidth(q("a")), 1);
  assert.equal(questionWidth(ms("m", 2)), 2);
  assert.equal(questionWidth(ms("m", 3)), 3);
});

test("questionCount sums the numbers a paper claims, not the entries it holds", () => {
  const set = [q("q1"), ms("q2", 2), q("q4")];
  // Three JSON entries; four numbers, because the multi-select claims two.
  assert.equal(questionCount(set), 4);
});

test("numberedGroups gives a multi-select the range it claims, and the question after it the number that follows", () => {
  const set = [q("q1"), ms("q2", 2), q("q4")];
  const [block] = numberedGroups(set);
  const [first, second, third] = block.questions;
  assert.deepEqual([first.number, first.to], [1, 1]);
  assert.deepEqual([second.number, second.to], [2, 3], "a two-letter group claims two consecutive numbers");
  assert.deepEqual(
    [third.number, third.to],
    [4, 4],
    "numbering resumes after the group's last number, not its first",
  );
  // The block's own heading range has to read the same way, or "Questions
  // 1-3" would print above a block that actually runs to 4.
  assert.deepEqual([block.from, block.to], [1, 4]);
});

test("a three-letter group claims three consecutive numbers", () => {
  const set = [ms("q1", 3), q("q2")];
  const [block] = numberedGroups(set);
  assert.deepEqual([block.questions[0].number, block.questions[0].to], [1, 3]);
  assert.equal(block.questions[1].number, 4);
});

test("an ordinary question's number and its own claimed range are the same number", () => {
  const [block] = numberedGroups(FLAT);
  for (const nq of block.questions) assert.equal(nq.number, nq.to);
});
