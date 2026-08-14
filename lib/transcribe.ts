"use client";

/*
  On-device transcription.

  The speech recogniser built into a browser is not necessarily a recogniser
  *in* the browser. Chrome streams the microphone to Google, and Apple's
  SFSpeechRecognizer decides for itself whether to run on the phone or in
  iCloud. For a learner practising their English out loud that is their voice
  going to a third party, and the app can only disclose it, never prevent it.

  This module is the alternative: whisper.cpp running locally, so the audio has
  nowhere to go. Two implementations sit behind one interface.

    Web    — whisper.cpp compiled to WebAssembly (@transcribe/shout), driven by
             @transcribe/transcriber. The model weights are fetched once from
             Hugging Face and kept in the Cache API; nothing is uploaded.
    iOS    — the same whisper.cpp, built natively, behind the Capacitor plugin
             in ios-plugins/local-transcription. Audio never leaves Swift.

  The trade is real and the UI has to carry it: a platform recogniser streams
  words as you speak, whereas whisper needs the whole answer before it starts.
  So a local session records first and transcribes on stop, and reports its
  progress while it does — see `LocalStatus`.

  Nothing here replaces the platform recogniser. lib/speech.ts owns the choice
  between them and the typed-answer fallback stays available in either case.
*/

import { isNative, nativeWhisper, nativeWhisperAvailable } from "./native";

export type LocalModelId = "tiny.en" | "base.en";

/** A failure before the model bytes were available, rather than a WASM error. */
export class LocalModelDownloadError extends Error {
  constructor() {
    super("Could not download the speech model.");
    this.name = "LocalModelDownloadError";
  }
}

export function isLocalModelDownloadError(error: unknown): error is LocalModelDownloadError {
  return error instanceof LocalModelDownloadError;
}

export interface LocalModel {
  id: LocalModelId;
  /** Whisper's own name for the weights file. */
  file: string;
  label: string;
  /** Approximate download size, used before Content-Length is known. */
  bytes: number;
  note: string;
}

/*
  English-only weights. The multilingual models of the same size are weaker on
  English, and every word in this test is English by definition. `base.en` is
  the accurate one and `tiny.en` the one that fits a phone.

  The notes below say only that one is more accurate than the other, which is
  what Whisper's published English word-error rates support. They do not say
  how the two compare on *accented* English, because nobody here has measured
  that. The temptation is real — the learners using this app are non-native
  speakers, so a claim about accented speech is the claim they would most want
  to hear — and that is exactly why it stays out until there is a measurement
  behind it. See TRANSCRIPTION.md.
*/
export const LOCAL_MODELS: Record<LocalModelId, LocalModel> = {
  "base.en": {
    id: "base.en",
    file: "ggml-base.en.bin",
    label: "Accurate",
    bytes: 147_964_211,
    note: "About 145 MB, downloaded once. The more accurate of the two.",
  },
  "tiny.en": {
    id: "tiny.en",
    file: "ggml-tiny.en.bin",
    label: "Light",
    bytes: 77_704_715,
    note: "About 75 MB and quicker, but it makes more mistakes.",
  },
};

export const DEFAULT_LOCAL_MODEL: LocalModelId = "base.en";

/*
  Where the weights come from. Hugging Face serves the canonical whisper.cpp
  ggml files with permissive CORS, which is what lets the browser fetch them
  directly. The public weights remain in ggerganov/whisper.cpp; a short-lived
  ggml-org mirror now returns an authenticated 401, so it must not be used as a
  fallback that turns one recoverable network interruption into a hard error.
*/
const MODEL_HOSTS = [...new Set([
  process.env.NEXT_PUBLIC_WHISPER_MODEL_BASE,
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
].filter((h): h is string => Boolean(h)))];

const CACHE_NAME = "bandup-whisper-v1";
const SHOUT_URL = "/whisper/shout.wasm.js";
const DOWNLOAD_ATTEMPTS = 3;

/**
 * Direct Hugging Face remains the normal path. The constrained same-origin
 * route is a fallback for a school, network or region that blocks that host.
 */
export function modelDownloadUrls(model: LocalModelId): string[] {
  const file = LOCAL_MODELS[model].file;
  const direct = MODEL_HOSTS.map((host) => `${host.replace(/\/+$/, "")}/${file}`);
  return [...direct, `/api/speech-model?model=${encodeURIComponent(file)}`];
}

export type LocalPhase = "recording" | "downloading" | "loading" | "transcribing";

export interface LocalStatus {
  phase: LocalPhase;
  /** 0–100, or null when the step cannot report a fraction. */
  percent: number | null;
}

export type StatusListener = (status: LocalStatus) => void;

/** Why on-device transcription is not usable here, or null if it is. */
export type LocalBlocker =
  | "server"
  | "no-microphone"
  | "no-recorder"
  | "no-wasm"
  | "no-simd"
  | "not-isolated"
  | "no-plugin";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/transcribe.test.mjs)
// ---------------------------------------------------------------------------

/*
  Whisper annotates what it hears that is not speech — `[BLANK_AUDIO]`,
  `(coughs)`, `*laughs*`, `♪` — and a stretch of silence transcribes to nothing
  but those markers. They are noise in an answer that is about to be marked for
  fluency, so they come out here. Round brackets are only removed when the whole
  bracket is a stage direction; a candidate saying "(I mean, sometimes)" is not
  what whisper writes, but an aside they typed might be.
*/
const NON_SPEECH = [
  /\[[^\]]*\]/g,
  /\((?:[^)]*(?:laugh|cough|sigh|music|silence|inaudible|applause|noise|blank)[^)]*)\)/gi,
  /\*[^*]*\*/g,
  /[♪♫]/g,
];

/** Turn whisper's segments into one clean answer. */
export function cleanTranscript(segments: string[]): string {
  let text = segments.join(" ");
  for (const re of NON_SPEECH) text = text.replace(re, " ");
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** Append a freshly transcribed chunk to whatever is already in the answer. */
export function mergeAnswer(existing: string, addition: string): string {
  const left = existing.trim();
  const right = addition.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

/** "145 MB" — for telling someone what they are about to download. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Plain-English label for what the recogniser is doing right now. */
export function describeStatus(status: LocalStatus): string {
  const pct = status.percent === null ? "" : ` ${Math.round(status.percent)}%`;
  switch (status.phase) {
    case "recording":
      return "Recording";
    case "downloading":
      return `Downloading the speech model${pct}`;
    case "loading":
      return "Starting the speech model";
    case "transcribing":
      return `Transcribing on your device${pct}`;
  }
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

// The canonical 30-byte module from wasm-feature-detect: i8x16.splat + popcnt.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
  253, 15, 253, 98, 11,
]);

/**
 * What stops on-device transcription from running here, or null if nothing
 * does. On iOS the native plugin answers for itself, so only the web path is
 * probed.
 */
export function localBlocker(): LocalBlocker | null {
  if (typeof window === "undefined") return "server";
  if (isNative()) return null;
  if (!navigator.mediaDevices?.getUserMedia) return "no-microphone";
  if (typeof window.MediaRecorder === "undefined") return "no-recorder";
  if (typeof WebAssembly === "undefined") return "no-wasm";
  if (!WebAssembly.validate(SIMD_PROBE)) return "no-simd";
  // whisper.cpp's WASM build uses pthreads, and threads need SharedArrayBuffer,
  // which a browser only hands out to a cross-origin-isolated document. The
  // COOP/COEP headers for /speaking are set in next.config.ts — a static export
  // has no server to send them, which is why the iOS app uses the native path.
  if (typeof SharedArrayBuffer === "undefined" || !window.crossOriginIsolated) return "not-isolated";
  return null;
}

/**
 * The same question, but able to wait for an answer from the native side. Use
 * this from the UI; `localBlocker` is the synchronous part of it.
 */
export async function localAvailability(): Promise<LocalBlocker | null> {
  const blocker = localBlocker();
  if (blocker) return blocker;
  if (isNative() && !(await nativeWhisperAvailable())) return "no-plugin";
  return null;
}

/** A sentence a learner can act on, for each way this can be unavailable. */
export function blockerMessage(blocker: LocalBlocker): string {
  switch (blocker) {
    case "no-microphone":
    case "no-recorder":
      return "This browser can't record audio, so on-device transcription isn't available here.";
    case "no-wasm":
    case "no-simd":
      return "This browser is too old to run the on-device speech model.";
    case "not-isolated":
      return "On-device transcription needs a page that browsers allow to use multiple threads. Reload the page, or use the device recogniser.";
    case "no-plugin":
      return "This version of the app doesn't include the on-device speech model yet.";
    case "server":
      return "On-device transcription runs in your browser and isn't ready yet.";
  }
}

// ---------------------------------------------------------------------------
// Model download and cache
// ---------------------------------------------------------------------------

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    // Private windows and insecure origins can refuse; downloading again is
    // slow but still correct.
    return null;
  }
}

/** True when the weights are already on the device and need no download. */
export async function isModelCached(model: LocalModelId): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  const hit = await cache.match(cacheKey(model));
  return Boolean(hit);
}

function cacheKey(model: LocalModelId): string {
  // A stable key of our own, so a change of host does not orphan the download.
  return `https://bandup.local/whisper/${LOCAL_MODELS[model].file}`;
}

function partialCacheKey(model: LocalModelId): string {
  return `${cacheKey(model)}?partial=1`;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
}

function contentRangeStart(value: string | null): { start: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-\d+\/(\d+)$/i);
  if (!match) return null;
  return { start: Number(match[1]), total: Number(match[2]) };
}

/**
 * Download one exact model file, retaining bytes already received when a
 * connection drops. Hugging Face's model CDN supports a single byte range, so
 * a retry asks only for the missing suffix rather than restarting a 148 MB
 * download. `checkpoint` lets the caller put that prefix in Cache Storage,
 * which also makes a second press of Retry resume the first press.
 */
export async function fetchModelWithProgress(
  url: string,
  expected: number,
  onStatus: StatusListener,
  initial: Blob | null = null,
  checkpoint?: (partial: Blob) => Promise<void>,
  attempts = DOWNLOAD_ATTEMPTS,
): Promise<Blob> {
  let chunks: BlobPart[] = initial && initial.size > 0 && initial.size < expected
    ? [initial]
    : [];
  let received = initial && initial.size > 0 && initial.size < expected ? initial.size : 0;
  let lastError: unknown = null;

  onStatus({ phase: "downloading", percent: Math.min(99, (received / expected) * 100) });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const resumeAt = received;
      const res = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        headers: resumeAt > 0 ? { Range: `bytes=${resumeAt}-${expected - 1}` } : undefined,
      });

      if (!res.ok || !res.body) {
        if (res.status === 416 && resumeAt > 0) {
          chunks = [];
          received = 0;
        }
        throw new Error(`model fetch failed: ${res.status}`);
      }

      if (resumeAt > 0 && res.status === 206) {
        const range = contentRangeStart(res.headers.get("content-range"));
        if (!range || range.start !== resumeAt || range.total !== expected) {
          chunks = [];
          received = 0;
          throw new Error("model server returned the wrong byte range");
        }
      } else if (resumeAt > 0) {
        // Some mirrors ignore Range and send the complete file with 200. That
        // is still usable, but the saved prefix must not be prepended twice.
        chunks = [];
        received = 0;
      }

      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > expected) {
          chunks = [];
          received = 0;
          throw new Error("speech model was larger than expected");
        }
        chunks.push(value);
        received += value.byteLength;
        onStatus({
          phase: "downloading",
          percent: Math.min(99, (received / expected) * 100),
        });
      }

      if (received !== expected) {
        throw new Error(`speech model download ended at ${received} of ${expected} bytes`);
      }
      onStatus({ phase: "downloading", percent: 100 });
      return new Blob(chunks, { type: "application/octet-stream" });
    } catch (error) {
      lastError = error;
      if (checkpoint && received >= 4 && received < expected) {
        try {
          await checkpoint(new Blob(chunks, { type: "application/octet-stream" }));
        } catch {
          // Private browsing or a full cache only removes cross-press resume;
          // the prefix is still retained in memory for the immediate retry.
        }
      }
      if (attempt + 1 < attempts) await retryDelay(attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("model fetch failed");
}

/**
 * The model weights, from the cache if they are there and from Hugging Face if
 * they are not. This is the only network request the local path ever makes,
 * and it carries no audio and nothing about the learner.
 */
/*
  Is this actually a whisper model?

  It is worth asking, because the failure it catches is silent otherwise: a
  captive-portal login page, a proxy error, or a download cut off halfway all
  produce a file, and handing one of those to the wasm module aborts it from
  inside C — the init promise never settles and the learner is left watching
  "Starting the speech model" for ever. Every ggml file opens with those four
  bytes, and none of them is a tenth of the size of the smallest real model.
*/
/**
 * GGML writes its 32-bit magic number little-endian. Its four bytes therefore
 * appear on disk as `lmgg`, not the human-readable `ggml`. Compare the
 * integer, rather than a byte-order-dependent string, so genuine Whisper
 * weights are not discarded after a successful download.
 */
export function isWhisperGgmlHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
    === 0x67676d6c;
}

async function hasGgmlMagic(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return isWhisperGgmlHeader(head);
}

async function looksLikeGgml(blob: Blob): Promise<boolean> {
  return blob.size >= 10_000_000 && await hasGgmlMagic(blob);
}

async function loadModelBlob(model: LocalModelId, onStatus: StatusListener): Promise<Blob> {
  const cache = await openCache();
  const key = cacheKey(model);
  const partialKey = partialCacheKey(model);
  const cached = await cache?.match(key);
  if (cached) {
    const blob = await cached.blob();
    if (await looksLikeGgml(blob)) return blob;
    // Whatever is in there, it is not a model. Throw it away and fetch again
    // rather than fail identically on every future attempt.
    await cache?.delete(key);
  }

  let partial: Blob | null = null;
  const savedPartial = await cache?.match(partialKey);
  if (savedPartial) {
    const candidate = await savedPartial.blob();
    if (
      candidate.size > 0
      && candidate.size < LOCAL_MODELS[model].bytes
      && await hasGgmlMagic(candidate)
    ) {
      partial = candidate;
    } else {
      await cache?.delete(partialKey);
    }
  }

  // Announce the download before asking for it: the first byte can be a second
  // or two away, and a silent second or two reads as nothing happening.
  onStatus({ phase: "downloading", percent: 0 });

  let lastError: unknown = null;
  for (const url of modelDownloadUrls(model)) {
    try {
      const blob = await fetchModelWithProgress(
        url,
        LOCAL_MODELS[model].bytes,
        onStatus,
        partial,
        async (checkpoint) => {
          partial = checkpoint;
          await cache?.put(partialKey, new Response(checkpoint));
        },
        // A blocked remote host should move promptly to the next route. The
        // same-origin fallback gets retries because it is under our control.
        url.startsWith("/api/speech-model?") ? DOWNLOAD_ATTEMPTS : 1,
      );
      if (!(await looksLikeGgml(blob))) {
        lastError = new Error("what came back is not a speech model");
        partial = null;
        await cache?.delete(partialKey);
        continue;
      }
      try {
        await cache?.put(key, new Response(blob));
        await cache?.delete(partialKey);
      } catch {
        // Out of quota: keep going with what is already in memory.
      }
      return blob;
    } catch (err) {
      lastError = err;
    }
  }
  // Keep upstream details out of the learner-facing UI. The caller still
  // distinguishes this from a later WASM/runtime-init failure.
  void lastError;
  throw new LocalModelDownloadError();
}

/** Forget the downloaded weights — offered in the UI so 145 MB is reclaimable. */
export async function deleteCachedModels(): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(CACHE_NAME);
  } catch {
    // Nothing cached, nothing to do.
  }
}

// ---------------------------------------------------------------------------
// The WASM transcriber
// ---------------------------------------------------------------------------

interface ShoutSegment {
  segment: { text: string };
}

interface ShoutResult {
  transcription: { text: string }[];
}

interface Whisper {
  init(): Promise<void>;
  transcribe(audio: File, opts: Record<string, unknown>): Promise<ShoutResult>;
  destroy(): void;
  onProgress: (percent: number) => void;
  onSegment: (segment: ShoutSegment) => void;
}

let whisper: Whisper | null = null;
let whisperModel: LocalModelId | null = null;
let whisperInit: Promise<Whisper> | null = null;

/*
  The Emscripten module is loaded from /whisper/shout.wasm.js rather than
  imported from node_modules: it inlines its own wasm binary and pthread worker
  and resolves them from `import.meta.url`, which bundlers mangle. The specifier
  is built at runtime so neither webpack nor Turbopack tries to follow it.
*/
async function loadShout(): Promise<(arg?: object) => Promise<unknown>> {
  const url = new URL(SHOUT_URL, window.location.href).href;
  const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as {
    default: (arg?: object) => Promise<unknown>;
  };
  return mod.default;
}

async function getWhisper(model: LocalModelId, onStatus: StatusListener): Promise<Whisper> {
  if (whisper && whisperModel === model) return whisper;
  if (whisperInit && whisperModel === model) return whisperInit;

  // A different model was asked for: drop the old one before loading 145 MB more.
  if (whisper) {
    whisper.destroy();
    whisper = null;
  }
  whisperModel = model;

  whisperInit = (async () => {
    const blob = await loadModelBlob(model, onStatus);
    onStatus({ phase: "loading", percent: null });
    const [createModule, { FileTranscriber }] = await Promise.all([
      loadShout(),
      import("@transcribe/transcriber"),
    ]);
    const instance = new FileTranscriber({
      createModule,
      model: new File([blob], LOCAL_MODELS[model].file),
      // The wasm build is chatty on stdout; that belongs in the console at most.
      print: () => {},
      printErr: () => {},
    }) as unknown as Whisper;
    await instance.init();
    whisper = instance;
    return instance;
  })();

  try {
    return await whisperInit;
  } catch (err) {
    whisperInit = null;
    whisperModel = null;
    throw err;
  }
}

/**
 * Download and warm up the model without transcribing anything, so the wait
 * happens while the examiner is talking rather than after the first answer.
 */
export async function prepareLocal(model: LocalModelId, onStatus: StatusListener): Promise<void> {
  if (isNative()) {
    const plugin = await nativeWhisper();
    if (!plugin) throw new Error("On-device transcription is not built into this app.");
    await plugin.prepare({ model });
    return;
  }
  await getWhisper(model, onStatus);
}

async function transcribeBlob(
  blob: Blob,
  model: LocalModelId,
  onStatus: StatusListener,
): Promise<string> {
  const instance = await getWhisper(model, onStatus);
  onStatus({ phase: "transcribing", percent: 0 });
  instance.onProgress = (percent: number) =>
    onStatus({ phase: "transcribing", percent: Math.max(0, Math.min(100, percent)) });
  const file = new File([blob], "answer", { type: blob.type || "audio/webm" });
  const result = await instance.transcribe(file, {
    lang: "en",
    suppress_non_speech: true,
    token_timestamps: false,
  });
  return cleanTranscript((result?.transcription ?? []).map((s) => s.text ?? ""));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface LocalSession {
  /** Begin capturing. Rejects if the microphone is refused. */
  start(): Promise<void>;
  /** Stop capturing and return the transcript. */
  stop(): Promise<string>;
  /** Abandon the answer: release the microphone, transcribe nothing. */
  abort(): void;
}

function webSession(model: LocalModelId, onStatus: StatusListener): LocalSession {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  const chunks: Blob[] = [];
  let stopped: Promise<void> | null = null;

  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
  };

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      recorder = new MediaRecorder(stream);
      chunks.length = 0;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      stopped = new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
      });
      recorder.start();
      onStatus({ phase: "recording", percent: null });
    },
    async stop() {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
        await stopped;
      }
      release();
      if (chunks.length === 0) return "";
      const blob = new Blob(chunks, { type: chunks[0].type });
      return await transcribeBlob(blob, model, onStatus);
    },
    abort() {
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        // Already stopped.
      }
      chunks.length = 0;
      release();
    },
  };
}

function nativeSession(model: LocalModelId, onStatus: StatusListener): LocalSession {
  let removeProgress: (() => Promise<void>) | null = null;

  return {
    async start() {
      const plugin = await nativeWhisper();
      if (!plugin) throw new Error("On-device transcription is not built into this app.");
      const permission = await plugin.requestPermissions();
      if (permission.microphone !== "granted") throw new Error("mic-denied");
      const handle = await plugin.addListener("progress", (e) => {
        onStatus({ phase: "transcribing", percent: e.percent });
      });
      removeProgress = handle.remove;
      await plugin.start({ model });
      onStatus({ phase: "recording", percent: null });
    },
    async stop() {
      const plugin = await nativeWhisper();
      if (!plugin) return "";
      onStatus({ phase: "transcribing", percent: 0 });
      try {
        const { text } = await plugin.stop();
        return cleanTranscript([text ?? ""]);
      } finally {
        await removeProgress?.();
        removeProgress = null;
      }
    },
    abort() {
      void (async () => {
        const plugin = await nativeWhisper();
        await plugin?.cancel().catch(() => {});
        await removeProgress?.();
        removeProgress = null;
      })();
    },
  };
}

/** One answer, recorded and then transcribed without leaving the device. */
export function createLocalSession(model: LocalModelId, onStatus: StatusListener): LocalSession {
  return isNative() ? nativeSession(model, onStatus) : webSession(model, onStatus);
}
