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

/*
  Thousands, which the marker could not read until a listening script said
  "four thousand signatures" against a key of "4000". Every number in a
  listening script is spoken in words and every answer key is written in
  digits, so a gap here is not an edge case — it is a learner typing the right
  answer and being told it is wrong.
*/
test("completion accepts thousands written either way", () => {
  const k = (answer) => ({ id: "t", type: "completion", sentence: "___", answer, maxWords: 3 });
  assert.equal(isCorrect(k("4000"), "four thousand"), true);
  assert.equal(isCorrect(k("four thousand"), "4000"), true);
  assert.equal(isCorrect(k("11000"), "eleven thousand"), true);
  assert.equal(isCorrect(k("25000"), "twenty-five thousand"), true);
  assert.equal(isCorrect(k("100000"), "a hundred thousand"), true);
  /* Still wrong when it is wrong — the rule must not make everything match. */
  assert.equal(isCorrect(k("4000"), "five thousand"), false);
  assert.equal(isCorrect(k("4000"), "four hundred"), false);
  /* And the hundreds rule it sits in front of still works. */
  assert.equal(isCorrect(k("600"), "six hundred"), true);
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

/* ---------------------------------------------------------------------------
   The types added for matching headings, Yes/No/Not Given and short answer.
   Each is here because it can be marked wrong in a way that looks right.
   --------------------------------------------------------------------------- */

const ynng = { id: "y", type: "ynng", statement: "?", answer: "NOT GIVEN" };

test("yes/no/not given marks on the exact label", () => {
  assert.equal(isCorrect(ynng, "NOT GIVEN"), true);
  assert.equal(isCorrect(ynng, "YES"), false);
  assert.equal(isCorrect(ynng, ""), false);
  assert.equal(isCorrect(ynng, undefined), false);
});

test("a yes/no answer is not interchangeable with a true/false one", () => {
  // The two tasks look identical on screen and are not. Marking YES against a
  // TRUE key would quietly tell a candidate they had understood a distinction
  // they had in fact missed.
  assert.equal(isCorrect({ id: "y", type: "ynng", statement: "?", answer: "YES" }, "TRUE"), false);
  assert.equal(isCorrect({ id: "t", type: "tfng", statement: "?", answer: "TRUE" }, "YES"), false);
});

const matching = { id: "m", type: "matching", prompt: "Paragraph A", answer: "vii" };

test("matching accepts the key in any case", () => {
  // Roman numerals get typed as capitals by people who assume they should be.
  assert.equal(isCorrect(matching, "vii"), true);
  assert.equal(isCorrect(matching, "VII"), true);
  assert.equal(isCorrect(matching, " vii "), true);
  assert.equal(isCorrect(matching, "vi"), false);
  assert.equal(isCorrect(matching, "viii"), false);
});

const shortAnswer = {
  id: "s",
  type: "short-answer",
  question: "?",
  answer: "some land",
  accept: ["land"],
  maxWords: 3,
};

test("short answer accepts every listed wording", () => {
  assert.equal(isCorrect(shortAnswer, "some land"), true);
  assert.equal(isCorrect(shortAnswer, "land"), true);
  assert.equal(isCorrect(shortAnswer, "Some Land"), true);
  assert.equal(isCorrect(shortAnswer, "some  land"), true);
  assert.equal(isCorrect(shortAnswer, "water"), false);
});

test("short answer with no alternatives still marks its own answer", () => {
  const only = { id: "s2", type: "short-answer", question: "?", answer: "daylighting", maxWords: 3 };
  assert.equal(isCorrect(only, "daylighting"), true);
  assert.equal(isCorrect(only, "Daylighting."), true);
  assert.equal(isCorrect(only, "culverting"), false);
});
