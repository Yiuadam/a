import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
