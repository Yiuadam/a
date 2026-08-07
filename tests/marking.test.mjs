/*
  Marking is where a defect is least visible and most damaging: a learner is
  simply told the wrong thing about their own answer, with nothing on screen to
  suggest the app is at fault. These pin the behaviour each question type is
  entitled to, so the types added in later phases arrive against a fixed
  contract rather than inheriting whatever the last branch happened to do.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { isCorrect, roundToHalf } = await import(
  pathToFileURL(join(process.cwd(), "lib", "band.ts")).href
);

const mcq = { id: "m", type: "mcq", question: "?", options: ["a", "b", "c"], answer: 1 };
const tfng = { id: "t", type: "tfng", statement: "?", answer: "NOT GIVEN" };
const gap = { id: "c", type: "completion", sentence: "___", answer: "sixty-two", maxWords: 1 };

test("an unanswered question is never counted as correct", () => {
  for (const q of [mcq, tfng, gap]) {
    assert.equal(isCorrect(q, undefined), false);
    assert.equal(isCorrect(q, ""), false);
  }
});

test("multiple choice matches on index, not on the option text", () => {
  assert.equal(isCorrect(mcq, 1), true);
  assert.equal(isCorrect(mcq, 0), false);
  // The renderer stores a number, but a stored answer read back from JSON can
  // arrive as a string; both must mark the same.
  assert.equal(isCorrect(mcq, "1"), true);
});

test("true/false/not given matches the exact label", () => {
  assert.equal(isCorrect(tfng, "NOT GIVEN"), true);
  assert.equal(isCorrect(tfng, "TRUE"), false);
  // Case matters here because the UI only ever submits the three exact labels.
  assert.equal(isCorrect(tfng, "not given"), false);
});

test("completion accepts a number written as digits or as words", () => {
  assert.equal(isCorrect(gap, "sixty-two"), true);
  assert.equal(isCorrect(gap, "62"), true);
  assert.equal(isCorrect(gap, "sixty two"), true);
  assert.equal(isCorrect(gap, "sixty-three"), false);
});

test("completion ignores surrounding punctuation and case", () => {
  const word = { id: "w", type: "completion", sentence: "___", answer: "warehouse", maxWords: 1 };
  assert.equal(isCorrect(word, "Warehouse."), true);
  assert.equal(isCorrect(word, "  warehouse  "), true);
  assert.equal(isCorrect(word, "warehouses"), false);
});

test("an unknown question type is marked wrong, never right", () => {
  // The compiler refuses such a type; this covers data arriving from outside
  // the type system — a generated test, or a file edited by hand.
  const alien = { id: "x", type: "not-a-real-type", answer: "anything" };
  assert.equal(isCorrect(alien, "anything"), false);
});

test("band rounding follows the official half-band rule", () => {
  // The rule that decides real results: .25 rounds up to the half, .75 rounds
  // up to the whole. Used for the overall band of a full sitting.
  assert.equal(roundToHalf(6.25), 6.5);
  assert.equal(roundToHalf(6.75), 7);
  assert.equal(roundToHalf(6.1), 6);
  assert.equal(roundToHalf(6.4), 6.5);
  assert.equal(roundToHalf((6 + 7 + 6.5 + 7) / 4), 6.5);
});
