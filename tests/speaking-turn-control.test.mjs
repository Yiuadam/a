import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a thin answer that has dried up gets a nudge, well before the hard limit", () => {
  // Part 1: "I live in Manchester." — a handful of words, then silence.
  assert.equal(
    control.decideNudge(
      evidence({ part: 1, elapsedSeconds: 6, wordCount: 4, silenceMilliseconds: 2_600 }),
    ),
    "probe",
  );
  // Part 2: the long turn dries up well short of 80 words.
  assert.equal(
    control.decideNudge(
      evidence({ part: 2, elapsedSeconds: 50, wordCount: 60, silenceMilliseconds: 4_100 }),
    ),
    "probe",
  );
  // Part 3: 25 words at 20 s, the case the plan measures at 55 s of dead air today.
  assert.equal(
    control.decideNudge(
      evidence({ part: 3, elapsedSeconds: 20, wordCount: 25, silenceMilliseconds: 3_100 }),
    ),
    "probe",
  );
});

test("a nudge does not fire before its part's silence threshold, or once enough has been said", () => {
  assert.equal(
    control.decideNudge(
      evidence({ part: 1, elapsedSeconds: 6, wordCount: 4, silenceMilliseconds: 2_000 }),
    ),
    null,
  );
  assert.equal(
    control.decideNudge(
      evidence({ part: 3, elapsedSeconds: 20, wordCount: 45, silenceMilliseconds: 3_100 }),
    ),
    null,
  );
});

test("a nudge fires once and never a second time in the same turn", () => {
  const thin = evidence({ part: 3, elapsedSeconds: 20, wordCount: 25, silenceMilliseconds: 3_100 });
  assert.equal(control.decideNudge(thin), "probe");
  assert.equal(control.decideNudge({ ...thin, nudgesUsed: 1 }), null);
});

test("the hard limit still bounds the turn even after a nudge", () => {
  assert.equal(
    control.decideNudge(
      evidence({ part: 3, elapsedSeconds: 75, wordCount: 25, silenceMilliseconds: 3_100 }),
    ),
    null,
  );
  assert.equal(
    control.decideTurnEnd(
      evidence({
        part: 3,
        elapsedSeconds: 75,
        wordCount: 25,
        silenceMilliseconds: 0,
        nudgesUsed: 1,
      }),
    ),
    "time-limit",
  );
});

test("once a nudge has been used, a candidate who stays quiet ends the turn at the ordinary pause, not the hard limit", () => {
  // Past Part 3's earliestNaturalEnd (28 s) but nowhere near its 75 s hard limit.
  assert.equal(
    control.decideTurnEnd(
      evidence({
        part: 3,
        elapsedSeconds: 30,
        wordCount: 25,
        silenceMilliseconds: 1_700,
        nudgesUsed: 1,
      }),
    ),
    "natural-pause",
  );
});

test("a candidate who never speaks gets a different, unvarying nudge after about eight seconds", () => {
  assert.equal(
    control.decideNudge(
      evidence({ part: 1, elapsedSeconds: 5, wordCount: 0, speechDetected: false, silenceMilliseconds: 0 }),
    ),
    null,
  );
  assert.equal(
    control.decideNudge(
      evidence({ part: 1, elapsedSeconds: 8, wordCount: 0, speechDetected: false, silenceMilliseconds: 0 }),
    ),
    "silent",
  );
  assert.equal(
    control.examinerNudge(1, 0, "silent"),
    "Take your time. Would you like me to repeat the question?",
  );
});

test("the probe bank gives three distinct lines per part", () => {
  for (const part of [1, 2, 3]) {
    const lines = new Set([0, 1, 2].map((index) => control.examinerNudge(part, index)));
    assert.equal(lines.size, 3);
  }
});

/*
  Restarting the recogniser, which on Android is not an edge case.

  Chrome there does not honour `continuous`, so `onend` fires at the end of
  almost every phrase and `no-speech` fires during an ordinary thinking pause.
  The old code called `rec.start()` synchronously inside `onend` and, when that
  threw — which it readily does, because the engine has not finished releasing
  the microphone at the moment it says it has stopped — it called
  setRecording(false) and gave up. The microphone died part-way through an
  answer, silently, while the screen still said it was listening.
*/
test("the recogniser is restarted on a timer, not from inside onend", () => {
  const src = readFileSync("components/speaking/SpeakingSession.tsx", "utf8");
  assert.match(src, /rec\.onend = scheduleRestart;/);
  const fn = src.match(/const scheduleRestart = \(\) => \{[\s\S]*?\n {4}\};/)?.[0] ?? "";
  assert.notEqual(fn, "", "SpeakingSession should schedule the restart");
  assert.match(fn, /setTimeout\(/, "a frame's delay is what lets the engine settle");
  // Everything is re-checked inside the timer: 120ms is long enough for the
  // turn to have ended or the recogniser to have been replaced.
  assert.equal(fn.match(/stillWanted\(\)/g)?.length, 2);
  assert.match(fn, /restartFailuresRef\.current = 0;/, "a success clears the budget");
  assert.match(fn, /RESTART_BUDGET/, "and repeated failure is a fault worth reporting");
  assert.match(fn, /setError\(/, "which the candidate is told about rather than left in");
});

test("a failed restart retries before it gives up", () => {
  const src = readFileSync("components/speaking/SpeakingSession.tsx", "utf8");
  const fn = src.match(/const scheduleRestart = \(\) => \{[\s\S]*?\n {4}\};/)?.[0] ?? "";
  // The recursion is the retry. Without it a single InvalidStateError — the
  // common case on Android — ends the answer.
  assert.match(fn, /scheduleRestart\(\);/);
  assert.match(src, /const RESTART_BUDGET = \d+;/);
  assert.match(src, /const RESTART_DELAY_MS = \d+;/);
});

test("stopping clears the pending restart, so a stopped mic stays stopped", () => {
  const src = readFileSync("components/speaking/SpeakingSession.tsx", "utf8");
  const stop = src.match(/const stopRecording = useCallback\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
  assert.match(stop, /clearRestartTimer\(\)/);
  assert.match(stop, /restartFailuresRef\.current = 0/);
});
