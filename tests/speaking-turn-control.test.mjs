import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const control = await import(
  pathToFileURL(join(process.cwd(), "lib/speaking/turn-control.ts")).href
);

function evidence(overrides = {}) {
  return {
    part: 1,
    elapsedSeconds: 15,
    wordCount: 24,
    speechDetected: true,
    silenceMilliseconds: 1_600,
    liveTranscript: true,
    ...overrides,
  };
}

test("Part 1 moves on after a developed answer reaches a natural pause", () => {
  assert.equal(control.decideTurnEnd(evidence()), "natural-pause");
});

test("the examiner does not cut a candidate off while they are still speaking", () => {
  assert.equal(
    control.decideTurnEnd(evidence({ silenceMilliseconds: 300, elapsedSeconds: 30 })),
    null,
  );
});

test("a short or silent answer is given more time", () => {
  assert.equal(control.decideTurnEnd(evidence({ wordCount: 5 })), null);
  assert.equal(control.decideTurnEnd(evidence({ speechDetected: false })), null);
});

test("an overlong answer ends even without a pause", () => {
  assert.equal(
    control.decideTurnEnd(evidence({ elapsedSeconds: 40, silenceMilliseconds: 0 })),
    "time-limit",
  );
});

test("Part 2 is protected until near two minutes and stops at two minutes", () => {
  assert.equal(
    control.decideTurnEnd(
      evidence({ part: 2, elapsedSeconds: 90, wordCount: 150, silenceMilliseconds: 3_000 }),
    ),
    null,
  );
  assert.equal(
    control.decideTurnEnd(
      evidence({ part: 2, elapsedSeconds: 110, wordCount: 150, silenceMilliseconds: 2_000 }),
    ),
    "natural-pause",
  );
  assert.equal(
    control.decideTurnEnd(
      evidence({ part: 2, elapsedSeconds: 120, wordCount: 0, silenceMilliseconds: 0 }),
    ),
    "time-limit",
  );
});

test("on-device transcription can use time and microphone activity without live words", () => {
  assert.equal(
    control.decideTurnEnd(
      evidence({
        part: 3,
        elapsedSeconds: 36,
        wordCount: 0,
        silenceMilliseconds: 1_800,
        liveTranscript: false,
      }),
    ),
    "natural-pause",
  );
});

test("the examiner uses a clear closing phrase", () => {
  assert.equal(control.examinerTransition(false, "time-limit"), "Thank you. Let's move on.");
  assert.equal(
    control.examinerTransition(true, "natural-pause"),
    "Thank you. That is the end of the speaking test.",
  );
});

test("the examiner varies neutral connecting phrases instead of repeating one line", () => {
  const natural = Array.from({ length: 5 }, (_, index) =>
    control.examinerTransition(false, "natural-pause", index),
  );
  const timed = Array.from({ length: 4 }, (_, index) =>
    control.examinerTransition(false, "time-limit", index),
  );

  assert.equal(new Set(natural).size, 5);
  assert.equal(new Set(timed).size, 4);
  assert.ok(natural.every((line) => !/^All right, thank you\.$/.test(line)));
});

test("the acknowledgement and next question are one continuous prompt", () => {
  const questions = [
    { part: 1, question: "Where do you live?" },
    { part: 1, question: "What do you like about it?" },
    { part: 2, question: "Describe a memorable journey." },
  ];
  assert.equal(
    control.examinerFollowUp(questions, 0, "natural-pause"),
    "Thank you. Let's continue. What do you like about it?",
  );
  assert.equal(
    control.examinerFollowUp(questions, 1, "time-limit"),
    "All right, we'll continue. In Part 2, I'm going to give you a topic card. You have one minute to prepare, then talk for one to two minutes. Describe a memorable journey.",
  );
});

test("the last answer closes the interview without inventing another question", () => {
  const questions = [{ part: 1, question: "Where do you live?" }];
  assert.equal(
    control.examinerFollowUp(questions, 0, "natural-pause"),
    "Thank you. That is the end of the speaking test.",
  );
});

test("word counting tolerates spacing", () => {
  assert.equal(control.countSpokenWords("  I   live in Hong Kong. "), 5);
  assert.equal(control.countSpokenWords("   "), 0);
});
