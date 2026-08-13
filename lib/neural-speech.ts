"use client";

import { isNative } from "./native";
import {
  playWithLookahead,
  speechPhrases,
  trimSpeechSilence,
} from "./speaking/audio-pipeline";

/*
  Natural examiner speech

  Browser SpeechSynthesis is only a switchboard for whatever voices happen to
  be installed on a device. On many Windows and Android machines that means an
  old, distinctly synthetic voice. The speaking test therefore uses Kokoro
  (https://github.com/hexgrad/kokoro, Apache 2.0) as its web examiner: the model and a
  British voice are downloaded once, cached by the engine, and inference runs
  in a worker on the learner's device.

  The pinned browser build is served as a static file rather than imported into
  Next's module graph. That is load-bearing: a client-only inference library in
  the graph was copied into OpenNext's Worker bundle and broke Cloudflare's
  3 MB upload limit. Nothing is fetched until the learner presses Start. Native
  iOS keeps AVSpeechSynthesizer, whose system voices are already neural and do
  not need a second model in the app.
*/

const EXAMINER_VOICE = "bf_emma";
const SAMPLE_RATE = 24_000;
const LOAD_TIMEOUT_MS = 45_000;
const FIRST_AUDIO_TIMEOUT_MS = 8_000;

interface RawAudio {
  audio: Float32Array;
}

interface KokoroEngine {
  stream(
    text: string,
    options: { voice: string; speed: number; split_pattern: RegExp },
  ): AsyncGenerator<{ audio: RawAudio }>;
}

interface KokoroModule {
  KokoroTTS: {
    from_pretrained(
      model: string,
      options: { dtype: "q8"; device: "wasm" },
    ): Promise<KokoroEngine>;
  };
}

const KOKORO_RUNTIME_URL = "/vendor/kokoro/kokoro.web.js";

let backend: KokoroEngine | null = null;
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
  if (backend) return true;
  if (loading) return loading;

  loading = (async () => {
    let timedOut = false;
    let timer = 0;
    try {
      // webpackIgnore keeps this URL out of the server/Worker graph. The file
      // is pinned in public/vendor/kokoro and is reviewed with the repository.
      const { KokoroTTS: Kokoro } = (await import(
        /* webpackIgnore: true */ KOKORO_RUNTIME_URL
      )) as KokoroModule;
      const loadedModel = Kokoro.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
        device: "wasm",
      });
      const loaded = loadedModel.then(() => true);
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
        unavailable = true;
        return false;
      }
      backend = await loadedModel;
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

async function play(
  samples: Float32Array,
  sequence: number,
  onStart: () => void,
): Promise<boolean> {
  const context = wakeAudio();
  if (!context || samples.length === 0 || sequence !== generation) return false;

  try {
    if (context.state === "suspended") await context.resume();
  } catch {
    return false;
  }
  if (context.state !== "running" || sequence !== generation) return false;

  return new Promise((resolve) => {
    let finished = false;
    let timer = 0;
    const done = (played: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      if (finishPlayback === cancel) finishPlayback = null;
      if (activeSource === source) activeSource = null;
      resolve(played);
    };
    const cancel = () => done(false);

    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => done(true);
    activeSource = source;
    finishPlayback = cancel;
    source.start();
    onStart();
    /* A suspended or buggy audio graph must not strand the interview forever.
       The buffer duration is known, so three seconds beyond it is a generous
       completion deadline rather than an arbitrary speech cutoff. */
    timer = window.setTimeout(() => {
      done(false);
      try {
        source.stop();
      } catch {
        // Already stopped between the timeout and cleanup.
      }
    }, Math.max(5_000, (samples.length / SAMPLE_RATE) * 1_000 + 3_000));
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
  if (!backend || unavailable) return false;
  const phrases = speechPhrases(text);
  if (phrases.length === 0) return false;
  const sequence = ++generation;
  cancelActiveAudio(false);
  const abort = new AbortController();
  activeAbort = abort;

  try {
    const stream = backend.stream(phrases.join("\n"), {
      voice: EXAMINER_VOICE,
      speed: Math.max(0.85, Math.min(1.1, rate)),
      split_pattern: /\n+/,
    });
    let firstAudioStarted = false;
    let playbackCompleted = true;
    let resolveFirstAudio!: (started: boolean) => void;
    const firstAudio = new Promise<boolean>((resolve) => {
      resolveFirstAudio = resolve;
    });
    const playback = playWithLookahead(
      stream,
      async (chunk) => {
        const played = await play(trimSpeechSilence(chunk.audio.audio, SAMPLE_RATE), sequence, () => {
          if (firstAudioStarted) return;
          firstAudioStarted = true;
          resolveFirstAudio(true);
        });
        playbackCompleted = playbackCompleted && played;
      },
      () => !abort.signal.aborted && sequence === generation,
    ).then(() => {
      if (!firstAudioStarted) resolveFirstAudio(false);
    });
    const started = await Promise.race([
      firstAudio,
      new Promise<false>((resolve) => window.setTimeout(() => resolve(false), FIRST_AUDIO_TIMEOUT_MS)),
    ]);
    if (!started) {
      unavailable = true;
      backend = null;
      cancelActiveAudio();
      void playback.catch(() => {});
      return false;
    }
    await playback;
    if (!playbackCompleted) {
      unavailable = true;
      backend = null;
      return false;
    }
    return true;
  } catch {
    if (abort.signal.aborted || sequence !== generation) return true;
    unavailable = true;
    backend = null;
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
  const currentContext = audioContext;
  backend = null;
  audioContext = null;
  loading = null;
  unavailable = false;
  void currentContext?.close().catch(() => {});
}
