"use client";

import { isNative } from "./native";
import type { TTSBackend } from "@omote/core";

/*
  Natural examiner speech

  Browser SpeechSynthesis is only a switchboard for whatever voices happen to
  be installed on a device. On many Windows and Android machines that means an
  old, distinctly synthetic voice. The speaking test therefore uses Kokoro
  (https://github.com/omoteai/omote, MIT) as its web examiner: the model and a
  British voice are downloaded once, cached by the engine, and inference runs
  in a worker on the learner's device.

  This file deliberately contains the dynamic import. The 92 MB model is not
  fetched — and the inference runtime is not added to the initial page chunk —
  until the learner presses Start. Native iOS keeps AVSpeechSynthesizer, whose
  system voices are already neural and do not need a second model in the app.
*/

const EXAMINER_VOICE = "bf_emma";
const SAMPLE_RATE = 24_000;
const LOAD_TIMEOUT_MS = 45_000;

let backend: TTSBackend | null = null;
let loading: Promise<boolean> | null = null;
let audioContext: AudioContext | null = null;
let activeAbort: AbortController | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let finishPlayback: (() => void) | null = null;
let unavailable = false;
let generation = 0;

function wakeAudio(): AudioContext | null {
  if (typeof window === "undefined" || isNative() || !("AudioContext" in window)) return null;
  try {
    audioContext ??= new AudioContext({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
    // Called synchronously from the Start button. This preserves the browser's
    // audio permission while the model continues loading asynchronously.
    void audioContext.resume();
    return audioContext;
  } catch {
    return null;
  }
}

/** Load the local British voice. False means the caller should use system TTS. */
export async function prepareNaturalExaminerVoice(): Promise<boolean> {
  if (typeof window === "undefined" || isNative() || unavailable) return false;
  if (!wakeAudio()) return false;
  if (backend?.isLoaded) return true;
  if (loading) return loading;

  loading = (async () => {
    let timedOut = false;
    let timer = 0;
    try {
      const { createKokoroTTS } = await import("@omote/core");
      const next = createKokoroTTS({
        defaultVoice: EXAMINER_VOICE,
        backend: "wasm",
        eagerLoad: true,
      });
      const loaded = next.load().then(() => true);
      const withinLimit = await Promise.race([
        loaded,
        new Promise<false>((resolve) => {
          timer = window.setTimeout(() => {
            timedOut = true;
            resolve(false);
          }, LOAD_TIMEOUT_MS);
        }),
      ]);
      window.clearTimeout(timer);
      if (!withinLimit) {
        // The model fetch itself cannot be aborted by this version of the
        // engine. Dispose it if it eventually completes, but let the interview
        // start with the device voice now rather than stranding the learner.
        void loaded.then(() => next.dispose()).catch(() => {});
        unavailable = true;
        return false;
      }
      backend = next;
      return true;
    } catch {
      unavailable = true;
      return false;
    } finally {
      if (!timedOut) window.clearTimeout(timer);
      loading = null;
    }
  })();

  return loading;
}

function play(samples: Float32Array, sequence: number): Promise<void> {
  const context = wakeAudio();
  if (!context || sequence !== generation) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (finishPlayback === done) finishPlayback = null;
      if (activeSource === source) activeSource = null;
      resolve();
    };

    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = done;
    activeSource = source;
    finishPlayback = done;
    source.start();
  });
}

/**
 * Speak with the local neural examiner.
 *
 * Returns false only when the caller should transparently fall back to the
 * browser voice. Cancellation counts as handled and must never restart the
 * sentence through a fallback voice after the learner has left the page.
 */
export async function speakNaturalExaminer(text: string, rate = 1): Promise<boolean> {
  if (!backend?.isLoaded || unavailable) return false;
  const sequence = ++generation;
  cancelActiveAudio(false);
  const abort = new AbortController();
  activeAbort = abort;

  try {
    for await (const chunk of backend.stream(text, {
      signal: abort.signal,
      voice: EXAMINER_VOICE,
      language: "en-gb",
      speed: Math.max(0.85, Math.min(1.1, rate)),
      // Examiner prompts are short. One inference avoids an artificial pause
      // while the next sentence is generated.
      singleShot: true,
    })) {
      if (abort.signal.aborted || sequence !== generation) return true;
      await play(chunk.audio, sequence);
    }
    return true;
  } catch {
    if (abort.signal.aborted || sequence !== generation) return true;
    unavailable = true;
    const failed = backend;
    backend = null;
    void failed.dispose().catch(() => {});
    return false;
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

function cancelActiveAudio(increment = true): void {
  if (increment) generation += 1;
  activeAbort?.abort();
  activeAbort = null;
  try {
    activeSource?.stop();
  } catch {
    // It may already have ended between the identity check and stop().
  }
  activeSource = null;
  finishPlayback?.();
  finishPlayback = null;
}

export function cancelNaturalExaminerVoice(): void {
  cancelActiveAudio();
}

/** Release the worker and audio graph when the speaking page is left. */
export function disposeNaturalExaminerVoice(): void {
  cancelActiveAudio();
  const currentBackend = backend;
  const currentContext = audioContext;
  backend = null;
  audioContext = null;
  loading = null;
  unavailable = false;
  void currentBackend?.dispose().catch(() => {});
  void currentContext?.close().catch(() => {});
}
