/*
  The pure parts of the on-device transcription path.

  Whisper does not only return words. It annotates what it hears that is not
  speech — `[BLANK_AUDIO]` over a pause, `(coughs)`, `♪` over anything musical —
  and those annotations would go straight into a transcript that is about to be
  marked for fluency and coherence. A candidate who paused to think would be
  marked on the pause. Stripping them is therefore load-bearing, and so is the
  limit on it: an aside the candidate actually typed in brackets is theirs and
  must survive.

  The saved-preference parser matters for a smaller reason: it reads whatever is
  in localStorage, which is to say anything at all, and a learner must never
  arrive at the speaking test to find it broken by a bad value.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const load = (file) => import(pathToFileURL(join(process.cwd(), "lib", file)).href);

const { cleanTranscript, mergeAnswer, formatBytes, describeStatus } = await load("transcribe.ts");
const { parseSpeechPrefs, DEFAULT_SPEECH_PREFS } = await load("speech.ts");

test("whisper's non-speech annotations are stripped", () => {
  assert.equal(cleanTranscript(["[BLANK_AUDIO]"]), "");
  assert.equal(
    cleanTranscript([" I think", " [BLANK_AUDIO]", " so, yes. (coughs)"]),
    "I think so, yes.",
  );
  assert.equal(cleanTranscript(["♪ La la ♪ I live in Hanoi."]), "La la I live in Hanoi.");
  assert.equal(cleanTranscript(["*laughs* Not really."]), "Not really.");
});

test("a candidate's own parenthetical survives", () => {
  assert.equal(
    cleanTranscript(["My city (Da Nang) is on the coast."]),
    "My city (Da Nang) is on the coast.",
  );
});

test("segments are joined without stray gaps before punctuation", () => {
  assert.equal(cleanTranscript(["Well", " , I suppose  so ."]), "Well, I suppose so.");
});

test("nothing said transcribes to nothing, not to whitespace", () => {
  assert.equal(cleanTranscript([]), "");
  assert.equal(cleanTranscript(["   ", "[BLANK_AUDIO]", "  "]), "");
});

test("a transcription is appended to whatever the candidate already typed", () => {
  assert.equal(mergeAnswer("I live in Lima.", "It is very big."), "I live in Lima. It is very big.");
  assert.equal(mergeAnswer("", "It is very big."), "It is very big.");
  assert.equal(mergeAnswer("I live in Lima.", "   "), "I live in Lima.");
  assert.equal(mergeAnswer("  ", "  "), "");
});

test("download sizes are stated the way a person reads them", () => {
  assert.equal(formatBytes(148_000_000), "148 MB");
  assert.equal(formatBytes(78_000_000), "78 MB");
});

test("every phase says something a learner can understand", () => {
  assert.equal(describeStatus({ phase: "recording", percent: null }), "Recording");
  assert.equal(
    describeStatus({ phase: "downloading", percent: 42.4 }),
    "Downloading the speech model 42%",
  );
  assert.equal(describeStatus({ phase: "loading", percent: null }), "Starting the speech model");
  assert.equal(
    describeStatus({ phase: "transcribing", percent: 7 }),
    "Transcribing on your device 7%",
  );
});

test("a saved preference is honoured", () => {
  assert.deepEqual(parseSpeechPrefs('{"engine":"local","model":"tiny.en"}'), {
    engine: "local",
    model: "tiny.en",
  });
});

test("nonsense in storage falls back to the platform recogniser", () => {
  for (const raw of [null, "", "not json", "[]", '{"engine":"telepathy","model":"huge"}']) {
    assert.deepEqual(parseSpeechPrefs(raw), DEFAULT_SPEECH_PREFS, `for ${JSON.stringify(raw)}`);
  }
});

test("the default is the platform recogniser, and the accurate local model", () => {
  assert.equal(DEFAULT_SPEECH_PREFS.engine, "platform");
  assert.equal(DEFAULT_SPEECH_PREFS.model, "base.en");
});
