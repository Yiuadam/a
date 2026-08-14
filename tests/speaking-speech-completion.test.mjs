import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

class FakeUtterance {
  constructor(text = "") {
    this.text = text;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

const behaviours = [];
let activeUtterance = null;
const spokenVoices = [];
let voices = [
  {
    default: true,
    lang: "en-GB",
    localService: true,
    name: "Test British voice",
    voiceURI: "test:british",
  },
];

const speechSynthesis = {
  getVoices() {
    return voices;
  },
  resume() {},
  speak(utterance) {
    activeUtterance = utterance;
    spokenVoices.push(utterance.voice);
    const behaviour = behaviours.shift();
    queueMicrotask(() => {
      if (behaviour !== "end-without-start" && behaviour !== "fail-before-start") {
        utterance.onstart?.();
      }
      queueMicrotask(() => {
        if (behaviour === "complete" || behaviour === "end-without-start") {
          if (activeUtterance === utterance) activeUtterance = null;
          utterance.onend?.();
        } else if (behaviour === "fail" || behaviour === "fail-before-start") {
          if (activeUtterance === utterance) activeUtterance = null;
          utterance.onerror?.(new Error("tts-failed"));
        }
      });
    });
  },
  cancel() {
    const utterance = activeUtterance;
    activeUtterance = null;
    // Safari may report `end` as part of cancellation. The production callback
    // must already have marked the job cancelled before this can happen.
    utterance?.onend?.();
  },
  addEventListener() {},
  removeEventListener() {},
};

globalThis.SpeechSynthesisUtterance = FakeUtterance;
globalThis.window = {
  speechSynthesis,
  setTimeout,
  clearTimeout,
};

const speech = await import(
  pathToFileURL(join(process.cwd(), "lib", "speech.ts")).href
);

test("a prompt succeeds only when every examiner sentence completes", async () => {
  behaviours.push("complete", "fail");
  assert.equal(
    await speech.speak("All right, thank you. What do you like about your city?"),
    false,
  );
});

test("a complete multi-sentence examiner prompt succeeds", async () => {
  behaviours.push("complete", "complete");
  assert.equal(
    await speech.speak("All right, thank you. What do you like about your city?"),
    true,
  );
});

test("an end event without an audible start does not complete the question", async () => {
  behaviours.push("end-without-start", "fail-before-start");
  assert.equal(await speech.speak("Where do you live?"), false);
});

test("a listed voice that cannot start falls back to the browser default", async () => {
  spokenVoices.length = 0;
  behaviours.push("fail-before-start", "complete");
  assert.equal(await speech.speak("Where do you live?"), true);
  assert.equal(spokenVoices.length, 2);
  assert.equal(spokenVoices[0]?.name, "Test British voice");
  assert.equal(spokenVoices[1], undefined);
});

test("an empty browser voice list still queues the first examiner line in the start interaction", async () => {
  voices = [];
  spokenVoices.length = 0;
  behaviours.push("hold");
  const pending = speech.speak("Where do you live?");

  // `speak()` must reach the default browser utterance before its first await.
  // Waiting for voiceschanged here loses Safari's user-activation window.
  assert.equal(spokenVoices.length, 1);
  assert.equal(spokenVoices[0], undefined);

  speech.cancelSpeech();
  assert.equal(await pending, false);
  voices = [
    {
      default: true,
      lang: "en-GB",
      localService: true,
      name: "Test British voice",
      voiceURI: "test:british",
    },
  ];
});

test("cancelling speech cannot turn a stale prompt into a completed question", async () => {
  behaviours.push("hold");
  const pending = speech.speak("Where do you live?");
  await new Promise((resolve) => setImmediate(resolve));
  speech.cancelSpeech();
  assert.equal(await pending, false);
});
