import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const placement = await import(
  pathToFileURL(join(process.cwd(), "lib", "placement.ts")).href
);
const bank = JSON.parse(
  readFileSync(join(process.cwd(), "data", "placement.json"), "utf8"),
).questions;

function answerRun(count, length = 5) {
  let state = placement.startAdaptive(length);
  const originalRandom = Math.random;
  Math.random = () => 0.25;
  try {
    for (let i = 0; i < count; i++) {
      const question = placement.nextQuestion(bank, state, []);
      assert.ok(question, "the authored bank ran out during a short sitting");
      const choice = i % 2 === 0
        ? question.answer
        : (question.answer + 1) % question.options.length;
      state = placement.recordAnswer(state, question, choice);
    }
  } finally {
    Math.random = originalRandom;
  }
  return state;
}

test("one answer in five minutes never produces a placement band", () => {
  const state = answerRun(1);
  const evidence = placement.placementEvidence(state);

  assert.equal(evidence.answered, 1);
  assert.equal(evidence.minimum, 9);
  assert.equal(evidence.reportable, false);
  assert.equal(evidence.confidence, "insufficient");
  assert.throws(
    () => placement.finishAdaptive(state),
    /does not contain enough evidence/,
  );
});

test("timer expiry does not turn the visible unanswered item into a wrong answer", () => {
  const page = readFileSync(join(process.cwd(), "app", "placement", "page.tsx"), "utf8");
  assert.match(page, /current && choice !== undefined \? recordAnswer/);
  assert.match(page, /No reliable score yet/);
});

test("skips are visible but never satisfy the evidence floor", () => {
  let state = placement.startAdaptive(5);
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    for (let i = 0; i < 15; i++) {
      const question = placement.nextQuestion(bank, state, []);
      assert.ok(question);
      state = placement.recordAnswer(state, question, undefined);
    }
  } finally {
    Math.random = originalRandom;
  }

  const evidence = placement.placementEvidence(state);
  assert.equal(evidence.answered, 0);
  assert.equal(evidence.skipped, 15);
  assert.equal(evidence.reportable, false);
  assert.equal(placement.shouldStop(state), false);
});

test("the five-minute floor covers every tested skill", () => {
  const state = answerRun(9);
  const evidence = placement.placementEvidence(state);

  assert.equal(evidence.answered, 9);
  assert.deepEqual(evidence.missingSkills, []);
  assert.ok(evidence.bySkill.grammar >= 2);
  assert.ok(evidence.bySkill.vocabulary >= 2);
  assert.ok(evidence.bySkill.reading >= 2);
  // Nine is a floor, not a promise. If the posterior is still wide, the test
  // correctly keeps asking instead of forcing a number at question nine.
  if (!evidence.reportable) assert.equal(placement.shouldStop(state), false);

  const fullState = answerRun(15);
  assert.equal(placement.placementEvidence(fullState).reportable, true);
  assert.doesNotThrow(() => placement.finishAdaptive(fullState));
});

test("a fake low standard error cannot bypass the minimum responses", () => {
  const oneAnswer = answerRun(1);
  const forgedPrecision = { ...oneAnswer, se: 0.01 };

  assert.equal(placement.shouldStop(forgedPrecision), false);
  assert.equal(placement.placementEvidence(forgedPrecision).reportable, false);
});

test("the reported interval comes from posterior quantiles and contains the estimate", () => {
  const state = answerRun(9);
  const [low, high] = placement.bandRange(state);
  const estimate = placement.thetaToBand(state.theta);

  assert.ok(low <= estimate);
  assert.ok(high >= estimate);
  assert.ok(high > low, "a short placement test must not claim zero uncertainty");
});
