import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("../scripts/ts-resolve.mjs", import.meta.url);

const pipeline = await import(
  pathToFileURL(join(process.cwd(), "lib", "speaking", "audio-pipeline.ts")).href
);

test("the next examiner phrase starts generating before playback finishes", async () => {
  let reads = 0;
  const source = {
    async next() {
      reads += 1;
      if (reads <= 2) return { done: false, value: reads };
      return { done: true, value: undefined };
    },
  };
  const heard = [];
  await pipeline.playWithLookahead(source, async (value) => {
    assert.ok(reads >= value + 1, "the next phrase was not requested early");
    heard.push(value);
  });
  assert.deepEqual(heard, [1, 2]);
});

test("examiner copy is generated a sentence at a time", () => {
  assert.deepEqual(
    pipeline.speechPhrases("All right, thank you. Where do you live?"),
    ["All right, thank you.", "Where do you live?"],
  );
});

test("dead air is trimmed but a soft speech edge remains", () => {
  const samples = new Float32Array(1_000);
  samples[400] = 0.2;
  samples[500] = -0.2;
  const trimmed = pipeline.trimSpeechSilence(samples, 1_000, 0.01, 20);
  assert.equal(trimmed.length, 141);
  assert.equal(trimmed[20], samples[400]);
  assert.equal(trimmed[120], samples[500]);
});

test("a silent examiner engine falls back or becomes recoverable", () => {
  const neural = readFileSync(join(process.cwd(), "lib", "neural-speech.ts"), "utf8");
  const speech = readFileSync(join(process.cwd(), "lib", "speech.ts"), "utf8");
  const session = readFileSync(
    join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"),
    "utf8",
  );

  assert.match(neural, /FIRST_AUDIO_TIMEOUT_MS/);
  assert.match(neural, /if \(!started\)[\s\S]+return "unavailable";/);
  assert.match(neural, /return "cancelled";/);
  assert.match(speech, /Promise<boolean>/);
  assert.match(speech, /Chrome can accept an utterance but emit neither start, end nor error/);
  assert.match(session, /Play question again/);
  assert.match(session, /Replay question/);
  assert.match(session, /if \(!spoken\)/);
  assert.match(session, /if \(!promptPlayed\)/);
});

test("a failed private model distinguishes download from runtime setup and stays recoverable", () => {
  const session = readFileSync(
    join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"),
    "utf8",
  );

  assert.match(session, /isLocalModelDownloadError\(error\)/);
  assert.match(session, /setLocalSetupFailed\(downloadFailed \? "download" : "initializing"\)/);
  assert.match(session, /Retry the download/);
  assert.match(session, /Retry setup/);
  assert.match(session, /Use my device recogniser/);
  assert.match(session, /updatePrefs\(\{ \.\.\.prefs, engine: "platform" \}\)/);
  assert.match(session, /void begin\(true\)/);
  assert.match(session, /const chosenEngine: SpeechPrefs\["engine"\] =/);
  assert.match(session, /forcePlatform \|\| localBlock !== null \? "platform" : prefs\.engine/);
  assert.match(session, /sessionEngineRef\.current = chosenEngine/);
  assert.match(session, /sessionEngineRef\.current === "local"/);
});

test("the answer phase is gated by the complete current examiner prompt", () => {
  const session = readFileSync(
    join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"),
    "utf8",
  );

  assert.match(session, /const \[answerWindowOpen, setAnswerWindowOpen\]/);
  assert.match(session, /const promptGeneration = \+\+promptGenerationRef\.current/);
  assert.match(session, /if \(promptGeneration !== promptGenerationRef\.current\) return;/);
  assert.match(session, /if \(!step \|\| !answerWindowOpen \|\| advancingRef\.current\) return;/);
  assert.match(session, /disabled=\{!answerWindowOpen \|\| examinerSpeaking \|\| preparing \|\| transcribing\}/);
  assert.match(session, /The complete examiner question did not play/);
  assert.match(session, /Use written question/);
});

test("stale microphone and preparation callbacks cannot enter a later answer", () => {
  const session = readFileSync(
    join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"),
    "utf8",
  );

  assert.match(session, /recRef\.current !== rec/);
  assert.match(session, /sessionRef\.current !== session/);
  assert.match(session, /prepGenerationRef\.current/);
  assert.match(session, /answerWindowOpenRef\.current/);
  assert.match(session, /const retainedAnswer = await stopAnswer\(\)/);
  assert.match(session, /if \(beginningRef\.current\) return;/);
});

test("a marking outage keeps the completed transcript retryable", () => {
  const session = readFileSync(
    join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"),
    "utf8",
  );

  assert.match(session, /"grade-error"/);
  assert.match(session, /Your interview is safely recorded/);
  assert.match(session, /Retry marking/);
  assert.match(session, /gradeInterview\(transcript\)/);
});

/*
  The on-device engine is only offered once the plugin can answer for itself.

  The picker used to be gated on IS_MOBILE_BUILD alone, which put a choice on
  screen that the shipped app could not honour: ios-plugins/local-transcription
  is not a dependency in ios/App/CapApp-SPM/Package.swift, so localAvailability
  resolves "no-plugin" and picking Whisper only ever answered that this version
  does not include it. An unfinished feature on screen is what App Review reads
  as incompleteness, and it was reachable without a subscription through the
  mock exam. Requiring localBlock === null means the picker appears when the
  plugin does and not before, and until then the interview simply uses the
  device recogniser.
*/
test("the on-device speech engine is offered only when the plugin answers", () => {
  const session = readFileSync(
    join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"),
    "utf8",
  );

  assert.match(session, /\{IS_MOBILE_BUILD && localBlock === null && \(/);
  assert.doesNotMatch(session, /\{IS_MOBILE_BUILD && \(/);
  // Nothing left inside the picker reports that on-device transcription is
  // unavailable, because the picker cannot be drawn while it is.
  assert.doesNotMatch(session, /blockerMessage\(/);
});
