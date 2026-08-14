import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("../scripts/ts-resolve.mjs", import.meta.url);

class FakeUtterance {
  constructor(text = "") {
    this.text = text;
    this.lang = "";
    this.rate = 1;
    this.pitch = 1;
    this.voice = undefined;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

const behaviours = [];
const spoken = [];
let activeUtterance = null;
let cancelCalls = 0;

const speechSynthesis = {
  speaking: false,
  pending: false,
  getVoices() {
    return [
      { lang: "en-GB", localService: true, name: "British voice" },
      { lang: "en-US", localService: true, name: "Fallback English voice" },
    ];
  },
  resume() {},
  speak(utterance) {
    activeUtterance = utterance;
    speechSynthesis.speaking = true;
    spoken.push(utterance);
    const behaviour = behaviours.shift() ?? "complete";
    queueMicrotask(() => {
      if (activeUtterance !== utterance || behaviour === "hold") return;
      if (behaviour !== "fail-before-start") utterance.onstart?.();
      queueMicrotask(() => {
        if (activeUtterance !== utterance) return;
        activeUtterance = null;
        speechSynthesis.speaking = false;
        if (behaviour === "fail-before-start" || behaviour === "fail") {
          utterance.onerror?.(new Error("tts-failed"));
        } else {
          utterance.onend?.();
        }
      });
    });
  },
  cancel() {
    cancelCalls += 1;
    const utterance = activeUtterance;
    activeUtterance = null;
    speechSynthesis.speaking = false;
    utterance?.onend?.();
  },
};

globalThis.SpeechSynthesisUtterance = FakeUtterance;
globalThis.window = {
  speechSynthesis,
  setTimeout,
  clearTimeout,
};

const pronunciation = await import(pathToFileURL(
  join(process.cwd(), "lib", "pronunciation.ts"),
).href);

test("a lookup pronunciation uses the installed British voice and explicit en-GB language", async () => {
  spoken.length = 0;
  behaviours.push("complete");

  assert.equal(await pronunciation.speakPronunciation("cohort"), true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "cohort");
  assert.equal(spoken[0].lang, "en-GB");
  assert.equal(spoken[0].voice.name, "British voice");
  assert.deepEqual(pronunciation.pronunciationSnapshot(), { status: "idle", term: null });
});

test("a word falls back to another English device voice when the preferred one never starts", async () => {
  spoken.length = 0;
  behaviours.push("fail-before-start", "complete");

  assert.equal(await pronunciation.speakPronunciation("public transport"), true);
  assert.equal(spoken.length, 2);
  assert.equal(spoken[0].voice.name, "British voice");
  assert.equal(spoken[1].voice.name, "Fallback English voice");
});

test("the control can stop only the active lookup pronunciation", async () => {
  behaviours.push("hold");
  const before = cancelCalls;
  const playing = pronunciation.speakPronunciation("estuary");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pronunciation.pronunciationSnapshot(), { status: "starting", term: "estuary" });

  pronunciation.stopPronunciation();
  assert.equal(await playing, false);
  assert.equal(cancelCalls, before + 1);
  assert.deepEqual(pronunciation.pronunciationSnapshot(), { status: "idle", term: null });
});

test("pronunciation does not interrupt another audio clip already speaking", async () => {
  speechSynthesis.speaking = true;
  assert.equal(await pronunciation.speakPronunciation("rubric"), false);
  assert.deepEqual(pronunciation.pronunciationSnapshot(), { status: "busy", term: "rubric" });
  speechSynthesis.speaking = false;
  pronunciation.stopPronunciation();
});

test("a browser utterance constructor failure reports unavailable without throwing", async () => {
  const original = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = class {
    constructor() {
      throw new Error("speech is unavailable");
    }
  };

  try {
    assert.equal(await pronunciation.speakPronunciation("lexicon"), false);
    assert.deepEqual(
      pronunciation.pronunciationSnapshot(),
      { status: "unavailable", term: "lexicon" },
    );
  } finally {
    globalThis.SpeechSynthesisUtterance = original;
    pronunciation.stopPronunciation();
  }
});

test("a browser without an English voice keeps the local-audio recovery path safe", async () => {
  const originalGetVoices = speechSynthesis.getVoices;
  speechSynthesis.getVoices = () => [];
  behaviours.push("fail-before-start");

  try {
    assert.equal(await pronunciation.speakPronunciation("coastline"), false);
    assert.deepEqual(
      pronunciation.pronunciationSnapshot(),
      { status: "unavailable", term: "coastline" },
    );
  } finally {
    speechSynthesis.getVoices = originalGetVoices;
    pronunciation.stopPronunciation();
  }
});

test("the lookup explanation exposes an accessible pronunciation interface", () => {
  const control = readFileSync(join(process.cwd(), "components", "PronunciationButton.tsx"), "utf8");
  const lookup = readFileSync(join(process.cwd(), "components", "Lookup.tsx"), "utf8");
  const history = readFileSync(join(process.cwd(), "components", "history", "LookupHistoryCard.tsx"), "utf8");
  const helper = readFileSync(join(process.cwd(), "lib", "pronunciation.ts"), "utf8");

  assert.match(control, /aria-pressed={playing}/);
  assert.match(control, /Stop pronunciation of \$\{term\}/);
  assert.match(control, /Listen to the pronunciation of \$\{term\}/);
  assert.match(control, /aria-live="polite"/);
  assert.match(control, /motion-reduce:transition-none/);
  assert.match(control, /data-lookup-pronunciation-button/);
  assert.match(lookup, /const panelTerm/);
  assert.match(lookup, /<PronunciationButton\s+term={panelTerm}\s+showLabel\s+showStatus/);
  assert.match(lookup, /data-lookup-actions/);
  assert.match(lookup, /data-lookup-favourite-button/);
  assert.match(lookup, /Pin word/);
  assert.ok(
    lookup.indexOf("data-lookup-actions") < lookup.indexOf('panel.status === "loading"'),
    "lookup tools render before conditional loading/ready/error content",
  );
  assert.match(lookup, /saveLookupForLater/);
  assert.doesNotMatch(history, /PronunciationButton/);
  assert.match(helper, /utterance\.lang = "en-GB"/);
  assert.match(helper, /synthesis\.speaking \|\| synthesis\.pending/);
  assert.match(helper, /shouldPrimeLocalFallback/);
  assert.match(helper, /prepareNaturalExaminerVoice/);
  assert.match(helper, /waitForNaturalExaminerVoice/);
  assert.match(helper, /speakNaturalExaminer/);
  assert.match(helper, /activeNaturalFallback/);
  assert.doesNotMatch(helper, /\bfetch\s*\(/);
});
