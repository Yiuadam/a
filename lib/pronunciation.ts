"use client";

import { isNative, nativeTTS } from "./native";
import {
  cancelNaturalExaminerVoice,
  naturalExaminerVoiceBusy,
  prepareNaturalExaminerVoice,
  speakNaturalExaminer,
  waitForNaturalExaminerVoice,
} from "./neural-speech";

/*
  Short lookup pronunciations deliberately use the device's built-in speech
  service. They are a user-triggered convenience, not part of the examiner
  audio pipeline, so they must not download the neural voice or queue behind a
  test question.

  The Web Speech API owns one global queue. Before enqueuing a lookup word we
  check that another part of the app is not already speaking; this prevents a
  dictionary tap from interrupting a listening recording or examiner prompt.
*/

export type PronunciationStatus = "idle" | "starting" | "playing" | "busy" | "unavailable";

export interface PronunciationSnapshot {
  status: PronunciationStatus;
  term: string | null;
}

const IDLE: PronunciationSnapshot = Object.freeze({ status: "idle", term: null });

let current: PronunciationSnapshot = IDLE;
const listeners = new Set<() => void>();
let sequence = 0;

type BrowserResult = "completed" | "not-started" | "interrupted";

let activeBrowser:
  | {
      synthesis: SpeechSynthesis;
      utterance: SpeechSynthesisUtterance;
      finish: (result: BrowserResult) => void;
    }
  | null = null;
let activeNative: { sequence: number; stop: () => Promise<void> } | null = null;
// Kokoro is shared with the examiner. This identity means a Stop button only
// stops a local pronunciation that this module started; it must never cut off
// an unrelated examiner question.
let activeNaturalFallback: number | null = null;

function publish(next: PronunciationSnapshot): void {
  if (current.status === next.status && current.term === next.term) return;
  current = Object.freeze(next);
  for (const listener of listeners) listener();
}

export function subscribePronunciation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable client snapshot for useSyncExternalStore. */
export function pronunciationSnapshot(): PronunciationSnapshot {
  return current;
}

/** Server and initial-client snapshot: never attempt speech while rendering. */
export function serverPronunciationSnapshot(): PronunciationSnapshot {
  return IDLE;
}

function cleanTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ");
}

function browserCandidates(voices: SpeechSynthesisVoice[]): (SpeechSynthesisVoice | undefined)[] {
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  // A listed cloud voice can silently fail while offline. Prefer a genuine
  // local voice for this short utility, then try remote/default voices.
  const localBritish = english.filter((voice) => voice.localService && voice.lang.toLowerCase().startsWith("en-gb"));
  const localEnglish = english.filter((voice) => voice.localService && !voice.lang.toLowerCase().startsWith("en-gb"));
  const remoteBritish = english.filter((voice) => !voice.localService && voice.lang.toLowerCase().startsWith("en-gb"));
  const remoteEnglish = english.filter((voice) => !voice.localService && !voice.lang.toLowerCase().startsWith("en-gb"));
  const defaultVoice = voices.find((voice) => voice.default);
  const candidates = [...localBritish, ...localEnglish, ...remoteBritish, ...remoteEnglish, defaultVoice, undefined];
  return candidates.filter(
    (voice, index) => candidates.indexOf(voice) === index,
  );
}

function playBrowserTerm(
  synthesis: SpeechSynthesis,
  text: string,
  voice: SpeechSynthesisVoice | undefined,
  onStart: () => void,
): Promise<BrowserResult> {
  return new Promise((resolve) => {
    let finished = false;
    let started = false;
    let startTimer = 0;
    let completionTimer = 0;
    let utterance: SpeechSynthesisUtterance | null = null;

    const finish = (result: BrowserResult) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(completionTimer);
      if (activeBrowser?.utterance === utterance) activeBrowser = null;
      resolve(result);
    };

    try {
      utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-GB";
      utterance.rate = 0.88;
      utterance.pitch = 1;
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        started = true;
        onStart();
        window.clearTimeout(startTimer);
        completionTimer = window.setTimeout(() => {
          // Resolve first: Safari may synchronously emit `end` after cancel().
          finish("interrupted");
          synthesis.cancel();
        }, Math.min(12_000, Math.max(4_500, 2_500 + text.length * 170)));
      };
      utterance.onend = () => finish(started ? "completed" : "not-started");
      utterance.onerror = () => finish(started ? "interrupted" : "not-started");
      activeBrowser = { synthesis, utterance, finish };
      // Browsers occasionally accept an utterance but never start it. A short
      // timeout lets us fall back to the next installed English voice instead
      // of leaving a permanent Stop button on screen.
      startTimer = window.setTimeout(() => {
        finish("not-started");
        synthesis.cancel();
      }, 1_500);
      synthesis.resume();
      synthesis.speak(utterance);
    } catch {
      finish("not-started");
    }
  });
}

async function speakInBrowser(term: string, job: number): Promise<boolean> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return false;
  }

  const synthesis = window.speechSynthesis;
  // There is no per-utterance cancel in the Web Speech API. Do not queue into
  // (or later cancel) an examiner/listening utterance owned by another view.
  if (synthesis.speaking || synthesis.pending) {
    if (job === sequence) publish({ status: "busy", term });
    return false;
  }

  let voices: SpeechSynthesisVoice[] = [];
  try {
    voices = synthesis.getVoices();
  } catch {
    // The browser default below remains a useful, zero-network fallback.
  }

  for (const voice of browserCandidates(voices)) {
    const result = await playBrowserTerm(synthesis, term, voice, () => {
      if (job === sequence) publish({ status: "playing", term });
    });
    if (job !== sequence) return false;
    if (result === "completed") {
      publish(IDLE);
      return true;
    }
    if (result === "interrupted") {
      publish(IDLE);
      return false;
    }
  }

  return false;
}

/**
 * A few embedded browsers expose neither a usable voice list nor a working
 * default voice. Prime the already-vendored local British voice while the
 * original press is still trusted, but only for that small group: downloading
 * a neural fallback for every successful device pronunciation would be a
 * waste of the learner's bandwidth.
 */
function shouldPrimeLocalFallback(): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return true;
  try {
    return !window.speechSynthesis
      .getVoices()
      .some((voice) => voice.lang.toLowerCase().startsWith("en"));
  } catch {
    return true;
  }
}

async function speakWithLocalFallback(term: string, job: number): Promise<boolean> {
  if (job !== sequence) return false;
  if (naturalExaminerVoiceBusy()) {
    publish({ status: "busy", term });
    return false;
  }

  /*
    `prepareNaturalExaminerVoice` is kicked off synchronously from the press
    below. Waiting here is therefore a recovery path, not the first attempt to
    create WebAudio after user activation has already expired.
  */
  if (!(await waitForNaturalExaminerVoice()) || job !== sequence) {
    if (job === sequence) publish({ status: "unavailable", term });
    return false;
  }
  if (naturalExaminerVoiceBusy()) {
    publish({ status: "busy", term });
    return false;
  }

  activeNaturalFallback = job;
  try {
    const result = await speakNaturalExaminer(term, 0.88);
    if (job !== sequence) return false;
    if (result === "completed") {
      publish(IDLE);
      return true;
    }
    if (result !== "cancelled") publish({ status: "unavailable", term });
    return false;
  } finally {
    if (activeNaturalFallback === job) activeNaturalFallback = null;
  }
}

function browserAudioIsBusy(): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  return window.speechSynthesis.speaking || window.speechSynthesis.pending;
}

/**
 * Pronounce a looked-up word or phrase in British English. This is always
 * invoked from an explicit control; no definition begins speaking by itself.
 */
export async function speakPronunciation(term: string): Promise<boolean> {
  const clean = cleanTerm(term);
  if (!clean) return false;

  // Choosing another word is an explicit request to replace the one that is
  // currently playing, not to make two pronunciations overlap.
  if (current.status === "playing") stopPronunciation();
  const job = ++sequence;
  publish({ status: "starting", term: clean });

  if (browserAudioIsBusy()) {
    publish({ status: "busy", term: clean });
    return false;
  }
  // The examiner/listening fallback uses WebAudio rather than the browser's
  // speech queue, so it needs its own busy guard to avoid two clips speaking
  // over one another.
  if (naturalExaminerVoiceBusy()) {
    publish({ status: "busy", term: clean });
    return false;
  }

  const needsLocalFallback = !isNative() && shouldPrimeLocalFallback();
  if (needsLocalFallback && !naturalExaminerVoiceBusy()) {
    // Do not await: waking WebAudio has to happen in the original button
    // press, while the model itself may continue downloading in the background.
    void prepareNaturalExaminerVoice();
  }

  // On web, start SpeechSynthesis in the original tap task. Awaiting even a
  // resolved Capacitor probe first loses user activation in some Safari and
  // embedded-browser implementations, yielding a silent utterance.
  if (!isNative()) {
    if (await speakInBrowser(clean, job)) return true;
    if (job !== sequence) return false;
    return speakWithLocalFallback(clean, job);
  }

  const native = await nativeTTS();
  if (job !== sequence) return false;
  if (native) {
    // Recheck after the asynchronous plugin lookup. A browser recording may
    // have started while the bridge was loading, and a lookup must not cut it
    // off by taking the shared device audio route.
    if (browserAudioIsBusy()) {
      publish({ status: "busy", term: clean });
      return false;
    }
    activeNative = { sequence: job, stop: () => native.stop() };
    try {
      if (job === sequence) publish({ status: "playing", term: clean });
      await native.speak({ text: clean, lang: "en-GB", rate: 0.88, pitch: 1 });
      if (job !== sequence) return false;
      publish(IDLE);
      return true;
    } catch {
      // A native bridge can be present but unavailable (for example after its
      // audio route has changed). The ordinary browser voice is still worth a
      // safe, no-network attempt before reporting that pronunciation failed.
      const spoken = await speakInBrowser(clean, job);
      if (!spoken && job === sequence) publish({ status: "unavailable", term: clean });
      return spoken;
    } finally {
      if (activeNative?.sequence === job) activeNative = null;
    }
  }

  const spoken = await speakInBrowser(clean, job);
  if (!spoken && job === sequence) publish({ status: "unavailable", term: clean });
  return spoken;
}

/** Stop only a pronunciation this module started; never cancel unrelated audio. */
export function stopPronunciation(): void {
  sequence += 1;
  const browser = activeBrowser;
  activeBrowser = null;
  browser?.finish("interrupted");
  if (browser) {
    try {
      browser.synthesis.cancel();
    } catch {
      // Some embedded browsers throw if the queue has already disappeared.
    }
  }

  const native = activeNative;
  activeNative = null;
  if (native) void native.stop().catch(() => {});
  if (activeNaturalFallback !== null) {
    activeNaturalFallback = null;
    cancelNaturalExaminerVoice();
  }
  if (current.status !== "idle") publish(IDLE);
}
