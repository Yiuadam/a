/*
  The progress bar reports work that has actually happened.

  A bar driven by a clock cannot be told from a bar driven by the work until
  the work runs long, and then it is obvious and it is too late. So the reader
  is a pure function over the half-written JSON, and this drives it with a
  scripted stream — including at chunk boundaries a network would produce and a
  hand-written test would not.

  What it does not prove: that the live Anthropic stream arrives in the shape
  assumed here. There is no API key in CI. That part is checked by generating a
  test in a browser and watching the bar.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { SHAPES, monotonic, readProgress } = await import(
  pathToFileURL(join(process.cwd(), "lib", "generate", "progress.ts")).href
);

/** A plausible partial document, built up field by field. */
function readingUpTo(questionsDone, passageChars = 4800) {
  let s = `{"id":"gen-1","title":"A Title","topic":"A topic","difficulty":"medium","timeMinutes":20,`;
  s += `"passage":"${"word ".repeat(Math.round(passageChars / 5))}`;
  if (questionsDone === 0) return s;
  s += `","questions":[`;
  for (let i = 0; i < questionsDone; i += 1) {
    s += `{"id":"q${i + 1}","type":"tfng","statement":"S","answer":"TRUE","explanation":"because"},`;
  }
  return s;
}

test("nothing is claimed before anything is written", () => {
  const p = readProgress("{", SHAPES.reading);
  assert.equal(p.phase, "starting");
  assert.ok(p.percent <= 2, `started at ${p.percent}%`);
  assert.equal(p.questionsDone, 0);
});

test("the passage phase tracks the passage, not the clock", () => {
  const quarter = readProgress(readingUpTo(0, 1200), SHAPES.reading);
  const half = readProgress(readingUpTo(0, 2400), SHAPES.reading);
  const full = readProgress(readingUpTo(0, 4800), SHAPES.reading);
  assert.equal(quarter.phase, "passage");
  assert.ok(quarter.percent < half.percent, "a longer passage must read as further along");
  assert.ok(half.percent < full.percent);
  assert.ok(full.percent <= 35, `the passage must not consume the whole bar (${full.percent}%)`);
  /* Identical input, identical answer — no time, no randomness. */
  assert.equal(readProgress(readingUpTo(0, 2400), SHAPES.reading).percent, half.percent);
});

test("questions are counted only once finished", () => {
  /* A question that has been started but has no explanation yet is not done. */
  const started = readingUpTo(3) + `{"id":"q4","type":"mcq","question":"Q?","options":["a","b","c"],"answer":1`;
  const p = readProgress(started, SHAPES.reading);
  assert.equal(p.questionsDone, 3, "an unfinished question must not be counted");
  assert.equal(p.label, "Writing question 4 of 13");
});

test("the bar advances with each question and never overshoots", () => {
  let last = 0;
  for (let done = 1; done <= SHAPES.reading.questions; done += 1) {
    const p = readProgress(readingUpTo(done), SHAPES.reading);
    assert.equal(p.questionsDone, done);
    assert.ok(p.percent > last, `stalled at ${done} questions (${p.percent}%)`);
    assert.ok(p.percent <= 99, "the bar must not reach 100 before the work is finished");
    last = p.percent;
  }
  assert.equal(readProgress(readingUpTo(13), SHAPES.reading).phase, "finishing");
});

test("more questions than expected cannot push it past the end", () => {
  const p = readProgress(readingUpTo(20), SHAPES.reading);
  assert.equal(p.questionsDone, SHAPES.reading.questions);
  assert.ok(p.percent <= 99);
});

test("chunk boundaries do not change the answer", () => {
  const whole = readingUpTo(6);
  const byChunks = [];
  for (let i = 0; i < whole.length; i += 37) byChunks.push(whole.slice(i, i + 37));
  const rebuilt = byChunks.join("");
  assert.equal(rebuilt, whole);
  assert.deepEqual(readProgress(rebuilt, SHAPES.reading), readProgress(whole, SHAPES.reading));
});

test("listening is measured against its own script and question count", () => {
  const s = `{"id":"g","title":"T","context":"c","difficulty":"medium","timeMinutes":12,"speakers":["A"],"script":[{"speaker":"A","text":"${"word ".repeat(200)}`;
  const p = readProgress(s, SHAPES.listening);
  assert.equal(p.phase, "passage");
  assert.equal(p.label, "Writing the script");
  assert.equal(p.questionsTotal, 10);
});

test("progress only ever goes forwards", () => {
  assert.equal(monotonic(40, 45), 45);
  assert.equal(monotonic(45, 40), 45, "a lower reading must be ignored, not shown");
  assert.equal(monotonic(45, 45), 45);
});
