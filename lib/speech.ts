"use client";

import { isNative, nativeSTT, nativeTTS } from "./native";

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

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

export function speechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  // On iOS the Web Speech API has no recognition half; the native plugin does.
  if (isNative()) return true;
  const w = window as SpeechWindow;
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
  const w = window as SpeechWindow;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-GB";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

/** Speak a line of text; resolves when finished (or immediately if unsupported). */
export async function speak(text: string, rate = 1): Promise<void> {
  const tts = await nativeTTS();
  if (tts) {
    try {
      await tts.speak({ text, lang: "en-GB", rate, pitch: 1 });
    } catch {
      // A failed line should never strand the interview.
    }
    return;
  }
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    utter.lang = "en-GB";
    const voice = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang.toLowerCase().startsWith("en"));
    if (voice) utter.voice = voice;
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

export function cancelSpeech(): void {
  void nativeTTS().then((tts) => tts?.stop().catch(() => {}));
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}
