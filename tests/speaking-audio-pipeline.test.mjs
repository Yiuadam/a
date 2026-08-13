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
  assert.match(neural, /if \(!started\)[\s\S]+return false;/);
  assert.match(speech, /Promise<boolean>/);
  assert.match(speech, /Chrome can accept an utterance but emit neither start, end nor error/);
  assert.match(session, /Play question again/);
  assert.match(session, /Replay question/);
  assert.match(session, /if \(!spoken\)/);
  assert.match(session, /if \(!promptPlayed\)/);
});
