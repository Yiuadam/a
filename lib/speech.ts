"use client";

import { isNative, nativeSTT, nativeTTS } from "./native";
import {
  cancelNaturalExaminerVoice,
  disposeNaturalExaminerVoice,
  prepareNaturalExaminerVoice,
  speakNaturalExaminer,
} from "./neural-speech";
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS, type LocalModelId } from "./transcribe";

/*
  Two ways to turn speech into text, and the learner picks.

    "platform" — the recogniser built into the browser or the phone. It streams
                 words as they are spoken, and on Chrome it does that by
                 uploading the audio to Google.
    "local"    — whisper.cpp on the device (lib/transcribe.ts). Nothing is
                 uploaded, but nothing appears until the answer is finished.

  Neither is a prerequisite for sitting the test: the answer box is always
  editable, so someone with no working recogniser can type.
*/
export type SpeechEngine = "platform" | "local";

export interface SpeechPrefs {
  engine: SpeechEngine;
  model: LocalModelId;
}

/*
  "platform" is the default deliberately. On-device transcription is the more
  private option, but the users of this app are non-native speakers by
  definition, and a recogniser that mishears accented English costs them marks
  in a way a privacy footnote does not. See TRANSCRIPTION.md for what has and
  has not been measured.
*/
export const DEFAULT_SPEECH_PREFS: SpeechPrefs = {
  engine: "platform",
  model: DEFAULT_LOCAL_MODEL,
};

const PREFS_KEY = "bandup.speech.v1";

/** Read the saved choice out of raw storage text, tolerating anything. */
export function parseSpeechPrefs(raw: string | null): SpeechPrefs {
  if (!raw) return DEFAULT_SPEECH_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<SpeechPrefs>;
    return {
      engine: parsed.engine === "local" ? "local" : "platform",
      model:
        parsed.model && parsed.model in LOCAL_MODELS ? parsed.model : DEFAULT_SPEECH_PREFS.model,
    };
  } catch {
    return DEFAULT_SPEECH_PREFS;
  }
}

/*
  Exposed as an external store, the same way lib/store.ts exposes the profile,
  so a component can read the saved choice with `useSyncExternalStore` without
  a hydration mismatch and without setting state inside an effect.
*/
let cache: SpeechPrefs | null = null;
const listeners = new Set<() => void>();

export function subscribeSpeechPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved choice on the client. Cached, because the snapshot must be stable. */
export function speechPrefs(): SpeechPrefs {
  if (cache) return cache;
  if (typeof window === "undefined") return DEFAULT_SPEECH_PREFS;
  try {
    cache = parseSpeechPrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    cache = DEFAULT_SPEECH_PREFS;
  }
  return cache;
}

/** What the server renders, and what the first client render must match. */
export function serverSpeechPrefs(): SpeechPrefs {
  return DEFAULT_SPEECH_PREFS;
}

export function writeSpeechPrefs(prefs: SpeechPrefs): void {
  cache = prefs;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage can be full or blocked; the choice just will not persist.
    }
  }
  for (const listener of listeners) listener();
}

// Minimal typings for the Web Speech API, which TypeScript's DOM lib does not
// include. Only the members this app uses are declared.

export interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

export interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

export interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechWindow = {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export function speechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  // On iOS the Web Speech API has no recognition half; the native plugin does.
  if (isNative()) return true;
  const w = window as unknown as SpeechWindow;
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

/**
 * Adapts Apple's speech recogniser to the Web Speech API shape the UI expects,
 * so the speaking page has one code path on both platforms.
 */
function nativeRecognition(): SpeechRecognitionLike {
  const target = new EventTarget() as SpeechRecognitionLike;
  let removeListener: (() => Promise<void>) | null = null;
  let running = false;
  // The plugin reports the whole utterance each time, so emit it as a single
  // non-final result and let the caller replace rather than append.
  const emit = (text: string, isFinal: boolean) => {
    const alt = { transcript: text, confidence: 1 };
    const result = Object.assign([alt], { length: 1, isFinal, 0: alt });
    const results = Object.assign([result], { length: 1, 0: result });
    target.onresult?.({ resultIndex: 0, results } as unknown as SpeechRecognitionEvent);
  };

  target.lang = "en-GB";
  target.continuous = true;
  target.interimResults = true;
  target.maxAlternatives = 1;

  target.start = () => {
    if (running) return;
    running = true;
    void (async () => {
      const stt = await nativeSTT();
      if (!stt) {
        running = false;
        target.onerror?.({ error: "service-not-allowed" } as SpeechRecognitionErrorEvent);
        return;
      }
      try {
        const permission = await stt.requestPermissions();
        if (permission.speechRecognition !== "granted") {
          running = false;
          target.onerror?.({ error: "not-allowed" } as SpeechRecognitionErrorEvent);
          return;
        }
        const handle = await stt.addListener("partialResults", (data) => {
          const text = data.matches?.[0];
          if (text) emit(text, false);
        });
        removeListener = handle.remove;
        await stt.start({ language: "en-GB", partialResults: true, popup: false });
        // start() resolves when the recogniser stops on its own.
        running = false;
        target.onend?.();
      } catch {
        running = false;
        target.onerror?.({ error: "aborted" } as SpeechRecognitionErrorEvent);
        target.onend?.();
      }
    })();
  };

  const halt = () => {
    running = false;
    void (async () => {
      const stt = await nativeSTT();
      try {
        await stt?.stop();
      } catch {
        // Already stopped.
      }
      await removeListener?.();
      removeListener = null;
      target.onend?.();
    })();
  };
  target.stop = halt;
  target.abort = () => {
    target.onend = null;
    halt();
  };

  return target;
}

export function getSpeechRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  if (isNative()) return nativeRecognition();
  const w = window as unknown as SpeechWindow;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-GB";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}


/*
  Voice quality is the single biggest factor in whether playback sounds like a
  person or a robot. Browsers ship a wide range: modern neural voices alongside
  decades-old formant synthesisers and novelty voices. Ranking them explicitly
  beats taking whatever getVoices() returns first.
*/
const GOOD_VOICE = [
  /natural/i, /neural/i, /enhanced/i, /premium/i, /siri/i,
  /google uk english/i, /google us english/i,
  /samantha/i, /serena/i, /daniel/i, /karen/i, /moira/i, /arthur/i, /martha/i,
  /libby/i, /sonia/i, /ryan/i, /aria/i, /jenny/i, /guy/i,
];

// Novelty and legacy synthesisers that sound obviously artificial.
const BAD_VOICE = [
  /espeak/i, /compact/i, /eloquence/i,
  /albert/i, /fred/i, /zarvox/i, /whisper/i, /bells/i, /boing/i, /bubbles/i,
  /cellos/i, /deranged/i, /hysterical/i, /jester/i, /organ/i, /superstar/i,
  /trinoids/i, /wobble/i, /bahh/i, /grandma/i, /grandpa/i, /rocko/i, /shelley/i,
  /sandy/i, /flo/i, /junior/i, /kathy/i, /princess/i, /ralph/i, /bad news/i,
  /good news/i,
];

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name;
  if (BAD_VOICE.some((re) => re.test(name))) return -100;
  let score = 0;
  if (GOOD_VOICE.some((re) => re.test(name))) score += 10;
  // Cloud voices are usually the higher-quality ones.
  if (!v.localService) score += 3;
  // IELTS listening is predominantly British-accented.
  if (v.lang.toLowerCase().startsWith("en-gb")) score += 2;
  else if (v.lang.toLowerCase().startsWith("en-au") || v.lang.toLowerCase().startsWith("en-us")) score += 1;
  return score;
}

/** English voices, best-sounding first. */
export function rankedEnglishVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith("en") && scoreVoice(v) > -100)
    .sort((a, b) => scoreVoice(b) - scoreVoice(a));
}

/** Split into sentences so playback can breathe between them. */
export function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let speechSequence = 0;
let finishBrowserUtterance: (() => void) | null = null;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function browserVoices(): Promise<SpeechSynthesisVoice[]> {
  const immediate = rankedEnglishVoices();
  if (immediate.length > 0 || typeof window === "undefined" || !("speechSynthesis" in window)) {
    return immediate;
  }

  /* Safari and Chrome often populate the voice list after the first render.
     Waiting briefly prevents the browser's low-quality default voice from
     winning that race. */
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(done, 400);
    function done() {
      window.clearTimeout(timer);
      window.speechSynthesis.removeEventListener("voiceschanged", done);
      resolve();
    }
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
  });
  return rankedEnglishVoices();
}

function speakBrowserLine(
  text: string,
  voice: SpeechSynthesisVoice | undefined,
  rate: number,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (finishBrowserUtterance === done) finishBrowserUtterance = null;
      resolve();
    };
    finishBrowserUtterance = done;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = 0.98;
    utterance.lang = "en-GB";
    if (voice) utterance.voice = voice;
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.speak(utterance);
  });
}

/** Speak a line of text; resolves when finished (or immediately if unsupported). */
export async function speak(text: string, rate = 1): Promise<void> {
  const sequence = ++speechSequence;
  const lines = toSentences(text);
  if (lines.length === 0) return;
  const tts = await nativeTTS();
  if (tts) {
    for (let i = 0; i < lines.length && sequence === speechSequence; i += 1) {
      try {
        await tts.speak({
          text: lines[i],
          lang: "en-GB",
          rate: rate * (i % 2 === 0 ? 0.97 : 0.94),
          pitch: 0.98,
        });
      } catch {
        // A failed line should never strand the interview.
      }
    }
    return;
  }
  // The speaking page prepares Kokoro from its Start button. If it is ready,
  // prefer that consistent British neural voice over whichever system voice
  // this particular browser happens to expose.
  if (await speakNaturalExaminer(text, rate)) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  finishBrowserUtterance?.();
  const [voice] = await browserVoices();
  for (let i = 0; i < lines.length && sequence === speechSequence; i += 1) {
    await speakBrowserLine(lines[i], voice, rate * (i % 2 === 0 ? 0.97 : 0.94));
    if (i + 1 < lines.length && sequence === speechSequence) await pause(60);
  }
}

export function cancelSpeech(): void {
  speechSequence += 1;
  cancelNaturalExaminerVoice();
  finishBrowserUtterance?.();
  void nativeTTS().then((tts) => tts?.stop().catch(() => {}));
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

export { disposeNaturalExaminerVoice, prepareNaturalExaminerVoice };
