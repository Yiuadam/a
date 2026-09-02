/*
  Numbers, which the marker used to get wrong in both directions at once.

  The normaliser stripped every full stop, punctuation and decimal point alike.
  That is how "6.30pm" and "630 pm" came to be the same answer, which is right —
  and how the key "3.8" became "38", which is not: a candidate who read the
  passage correctly and typed 3.8 was marked wrong, while one who typed 38 was
  marked right. Both halves of that were live in the bank at once.

  A decimal point flanked by digits is kept now. The tolerance it used to
  provide for free is written down instead, as an accept list, which is why
  CompletionQuestion grew the field short-answer already had.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { isCorrect } = await import(pathToFileURL(join(process.cwd(), "lib", "band.ts")).href);

const gap = (answer, accept) => ({
  id: "q",
  type: "completion",
  sentence: "___",
  answer,
  ...(accept ? { accept } : {}),
  maxWords: 2,
});

test("a decimal is marked on its digits, not on the digits with the point removed", () => {
  const q = gap("3.8");
  assert.equal(isCorrect(q, "3.8"), true);
  // The unit is stripped as punctuation, which is deliberate and unchanged.
  assert.equal(isCorrect(q, "3.8%"), true);
  assert.equal(isCorrect(q, " 3.8 "), true);
  // The defect: this used to be accepted, because the key normalised to "38".
  assert.equal(isCorrect(q, "38"), false);
  assert.equal(isCorrect(q, "3"), false);
});

test("a time keeps the tolerance it used to get by accident, now that it asks for it", () => {
  const q = gap("6.30 pm", ["630 pm", "6.30pm", "630pm"]);
  for (const given of ["6.30 pm", "6.30pm", "630 pm", "630pm"]) {
    assert.equal(isCorrect(q, given), true, `${given} should be accepted`);
  }
  assert.equal(isCorrect(q, "7.30 pm"), false);
  assert.equal(isCorrect(q, "6.30 am"), false);
});

test("a completion question with no accept list behaves exactly as before", () => {
  const q = gap("sixty-two");
  assert.equal(isCorrect(q, "sixty-two"), true);
  // Words to digits still works: that path is the reason the normaliser is
  // more than a string comparison.
  assert.equal(isCorrect(q, "62"), true);
  assert.equal(isCorrect(q, "sixty two"), true);
  assert.equal(isCorrect(q, "sixty-three"), false);
});

test("a full stop that is not a decimal point is still stripped", () => {
  assert.equal(isCorrect(gap("Dr Smith"), "Dr. Smith"), true);
  assert.equal(isCorrect(gap("the end"), "the end."), true);
  assert.equal(isCorrect(gap("am"), "a.m."), true);
});

test("short-answer keeps the shape completion has borrowed", () => {
  const q = { id: "s", type: "short-answer", question: "?", answer: "9.30", accept: ["930"] };
  assert.equal(isCorrect(q, "9.30"), true);
  assert.equal(isCorrect(q, "930"), true);
  assert.equal(isCorrect(q, "9.31"), false);
});
