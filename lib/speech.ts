"use client";

import { isNative, nativeSTT, nativeTTS } from "./native";
import {
  cancelNaturalExaminerVoice,
  disposeNaturalExaminerVoice,
  naturalExaminerVoiceBusy,
  naturalExaminerVoiceReady,
  prepareNaturalExaminerVoice,
  speakNaturalExaminer,
  waitForNaturalExaminerVoice,
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

/*
  The plugin also emits `listeningState`, which lib/native.ts does not type
  because until now nothing listened for it. It is part of the community
  package's published contract all the same — see its
  `dist/esm/definitions.d.ts` — and our own native half emits it, so this is a
  narrowing of a real event rather than an invented one. Declared beside the
  single call site that needs it rather than widening the shared bridge type,
  which would put the assertion a file away from the reason for it.
*/
interface ListeningStateEvents {
  addListener(
    eventName: "listeningState",
    listenerFunc: (data: { status?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Adapts Apple's speech recogniser to the Web Speech API shape the UI expects,
 * so the speaking page has one code path on both platforms.
 */
function nativeRecognition(): SpeechRecognitionLike {
  const target = new EventTarget() as SpeechRecognitionLike;
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

  /*
    The listening session in progress, or null when there is none.

    Every step of the asynchronous setup below checks against it, because a
    `stop()` can land at any point during that setup — and if it does, the
    plugin call already queued behind it would open the microphone *after* the
    answer was over, with nothing left on this side that would ever close it.
  */
  type Listen = { remove: (() => Promise<void>) | null };
  let current: Listen | null = null;

  /*
    End the session once, however it ended.

    `onend` means "the microphone is closed" to the caller, and SpeakingSession
    answers it by starting the recogniser again — it has to, because a browser
    recogniser stops itself every few seconds and an answer must survive that.
    So firing `onend` early is not a cosmetic slip; it is an instruction to
    restart.

    Idempotent because the same ending can arrive twice: the plugin's teardown
    emits `listeningState: stopped`, and its give-up path (three fruitless
    segments in a row) emits a second one immediately after.
  */
  const finish = (listen: Listen) => {
    if (current !== listen) return;
    current = null;
    const remove = listen.remove;
    listen.remove = null;
    void remove?.();
    target.onend?.();
  };

  target.start = () => {
    if (current) return;
    const listen: Listen = { remove: null };
    current = listen;
    void (async () => {
      const stt = await nativeSTT();
      if (!stt) {
        if (current === listen) current = null;
        target.onerror?.({ error: "service-not-allowed" } as SpeechRecognitionErrorEvent);
        return;
      }
      try {
        const permission = await stt.requestPermissions();
        if (current !== listen) return;
        if (permission.speechRecognition !== "granted") {
          current = null;
          target.onerror?.({ error: "not-allowed" } as SpeechRecognitionErrorEvent);
          return;
        }
        const partial = await stt.addListener("partialResults", (data) => {
          if (current !== listen) return;
          const text = data.matches?.[0];
          if (text) emit(text, false);
        });
        /*
          Where the end of an answer actually comes from.

          The plugin holds one audio engine across Apple's own segment
          boundaries — Apple closes a recognition task after a minute or so,
          and a Part 2 answer runs longer than that — so a segment ending is
          not the answer ending, and nothing on this side can tell those two
          apart. `listeningState: stopped` is emitted only when the microphone
          is really closed. See ios/App/App/SpeechRecognitionPlugin.swift.
        */
        const state = await (stt as unknown as ListeningStateEvents).addListener(
          "listeningState",
          (data) => {
            if (data.status === "stopped") finish(listen);
          },
        );
        listen.remove = async () => {
          await partial.remove();
          await state.remove();
        };
        if (current !== listen) {
          await listen.remove();
          return;
        }
        await stt.start({ language: "en-GB", partialResults: true, popup: false });
        /*
          This resolves when listening *begins*, not when it ends: a
          partial-results start is answered as soon as the audio engine is up,
          and everything after that arrives as an event.

          Reading it as the end — which this used to do — fired `onend` with
          the microphone still live. The caller heard that as "restart", the
          plugin rejected the second start because it was already listening,
          the rejection below fired `onend` again, and the two spun against
          each other for the whole answer: a `requestPermissions` and a fresh,
          never-removed `partialResults` listener on every turn, so each word
          the learner spoke fanned out to more handlers than the last and the
          live transcript ground to a halt behind them.
        */
        if (current !== listen) {
          // A `stop()` overtook the start on the bridge. Nothing is coming to
          // close what this just opened, so close it here.
          await stt.stop();
        }
      } catch {
        if (current !== listen) return;
        current = null;
        void listen.remove?.();
        listen.remove = null;
        target.onerror?.({ error: "aborted" } as SpeechRecognitionErrorEvent);
        /* Listening never began, so no `listeningState` is coming. The caller
           still has to be told the attempt is over, or it waits for an answer
           that is not being recorded. */
        target.onend?.();
      }
    })();
  };

  const halt = () => {
    const listen = current;
    // Nothing listening and nothing starting, so nothing to end. A browser
    // recogniser emits no `end` for a session it never began either.
    if (!listen) return;
    void (async () => {
      const stt = await nativeSTT();
      try {
        await stt?.stop();
      } catch {
        // Already stopped.
      }
      /* Normally the plugin has emitted its `stopped` before this resolves and
         `finish` has already run, making this a no-op. It is here for the case
         where the plugin had nothing to stop — a start that never got as far
         as opening the microphone — because then no event is coming and the
         caller would wait for an `onend` that never arrives. */
      finish(listen);
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

/*
  Accent decides first, and quality only breaks ties inside an accent.

  This used to be a two-point bonus for en-GB added to a thirteen-point quality
  score, and two points does not survive that arithmetic: "Google US English",
  being a listed cloud voice with a name the table below likes, scored 14 while
  Daniel — installed, British, and named in the same table — scored 12. So the
  code carried a comment saying IELTS is predominantly British-accented and
  then handed the learner an American voice on any machine where the best
  American one was in the cloud and the best British one was not, which is most
  Windows and Android machines. Multiplying rather than adding is what makes
  the stated preference true: no amount of quality signal can lift an American
  voice past a British one, and between two British ones quality still decides.

  Irish, Australian, New Zealand and South African sit between the two for the
  same reason lib/listening-audio.ts casts its third and fourth speakers from
  Australian rather than American — they are accents a candidate meets in a
  real paper, and they are not the accent this app was asked to stop using.
*/
function accentRank(lang: string): number {
  const tag = lang.toLowerCase();
  if (tag.startsWith("en-gb")) return 3;
  if (["en-ie", "en-au", "en-nz", "en-za"].some((prefix) => tag.startsWith(prefix))) return 2;
  return 1;
}

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name;
  if (BAD_VOICE.some((re) => re.test(name))) return -100;
  let quality = 0;
  if (GOOD_VOICE.some((re) => re.test(name))) quality += 10;
  // Cloud voices are usually the higher-quality ones.
  if (!v.localService) quality += 3;
  // Strictly greater than any quality score, so the tiers cannot interleave.
  return accentRank(v.lang) * 20 + quality;
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
): Promise<"completed" | "not-started" | "interrupted"> {
  return new Promise((resolve) => {
    let finished = false;
    let started = false;
    let startTimer = 0;
    let completionTimer = 0;
    const done = (result: "completed" | "not-started" | "interrupted") => {
      if (finished) return;
      finished = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(completionTimer);
      if (finishBrowserUtterance === cancel) finishBrowserUtterance = null;
      resolve(result);
    };
    const cancel = () => done("interrupted");
    finishBrowserUtterance = cancel;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      utterance.pitch = 0.98;
      utterance.lang = "en-GB";
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        started = true;
        window.clearTimeout(startTimer);
        completionTimer = window.setTimeout(() => {
          // Resolve before cancelling: Safari may synchronously emit `end`
          // from cancel(), and that must not turn a timed-out line into a
          // successful one.
          done("interrupted");
          window.speechSynthesis.cancel();
        }, Math.min(25_000, Math.max(6_000, 3_000 + text.length * 120)));
      };
      // Some engines emit `end` for an utterance they never audibly started.
      // That is not a completed examiner question.
      utterance.onend = () => done(started ? "completed" : "not-started");
      utterance.onerror = () => done(started ? "interrupted" : "not-started");
      /* Chrome can accept an utterance but emit neither start, end nor error.
         Install this before enqueueing so a synchronous `start` can clear it. */
      startTimer = window.setTimeout(() => {
        done("not-started");
        window.speechSynthesis.cancel();
      }, 2_500);
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    } catch {
      done("not-started");
    }
  });
}

/**
 * A cloud/browser voice can be listed even when it cannot play on the current
 * connection. Try it first for quality, then a genuinely local English voice,
 * then the browser default. Only a line that never started is retried, so an
 * interrupted audible sentence is never spoken twice.
 */
function browserVoiceCandidates(
  voices: SpeechSynthesisVoice[],
): (SpeechSynthesisVoice | undefined)[] {
  const preferred = voices[0];
  const local = voices.find((voice) => voice.localService && voice !== preferred);
  const candidates: (SpeechSynthesisVoice | undefined)[] = [];
  if (preferred) candidates.push(preferred);
  if (local) candidates.push(local);
  candidates.push(undefined);
  return candidates;
}

function candidatesForLine(
  workingVoice: { value: SpeechSynthesisVoice | undefined } | null,
  fallback: (SpeechSynthesisVoice | undefined)[],
): (SpeechSynthesisVoice | undefined)[] {
  return workingVoice === null ? fallback : [workingVoice.value];
}

/**
 * Start the first fallback utterance before awaiting `voiceschanged`.
 *
 * Safari and embedded browsers can report an empty voice list just after a
 * user taps Start. The former implementation waited up to 400 ms for that
 * list, which meant the first real `speechSynthesis.speak()` happened outside
 * the user interaction and could be silently refused. The browser default is
 * safe to ask for immediately; delayed voice discovery is only a retry when
 * that first direct attempt never starts.
 */
async function speakBrowserPrompt(
  lines: string[],
  rate: number,
  sequence: number,
): Promise<"completed" | "not-started" | "interrupted"> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return "not-started";

  // Resolve the old job as cancelled before the platform has a chance to emit
  // a synchronous `end` event for it. Both calls run before the first await,
  // keeping the replacement utterance in the original click task.
  finishBrowserUtterance?.();
  window.speechSynthesis.cancel();

  const immediateCandidates = browserVoiceCandidates(rankedEnglishVoices());
  let workingVoice: { value: SpeechSynthesisVoice | undefined } | null = null;

  for (let i = 0; i < lines.length && sequence === speechSequence; i += 1) {
    const tried = new Set<SpeechSynthesisVoice | undefined>();
    let completed = false;
    let interrupted = false;

    const tryCandidates = async (candidates: (SpeechSynthesisVoice | undefined)[]) => {
      for (const voice of candidates) {
        if (tried.has(voice) || sequence !== speechSequence) continue;
        tried.add(voice);
        /* One rate for the whole prompt. This alternated 0.97/0.94 by sentence
           index, so an examiner speeding up and slowing down every sentence was
           the intended effect; what it actually produces is a 3% speed change
           at each full stop, which is heard as the delivery being unsteady
           rather than as natural variation. Real prosodic variation lives
           inside a sentence, not between consecutive ones. */
        const result = await speakBrowserLine(lines[i], voice, rate * 0.96);
        if (sequence !== speechSequence) return;
        if (result === "completed") {
          workingVoice = { value: voice };
          completed = true;
          return;
        }
        if (result === "interrupted") {
          interrupted = true;
          return;
        }
      }
    };

    // This invokes `speechSynthesis.speak()` synchronously for the first line
    // even when `getVoices()` has not populated yet.
    await tryCandidates(candidatesForLine(workingVoice, immediateCandidates));
    if (sequence !== speechSequence || interrupted) return "interrupted";

    if (!completed) {
      // A device may expose voices just after the immediate default failed.
      // Waiting is acceptable now: the direct attempt already had its chance
      // in the user gesture, and this is a recovery path rather than the only
      // way an examiner question can start.
      await tryCandidates(browserVoiceCandidates(await browserVoices()));
    }
    if (sequence !== speechSequence || interrupted) return "interrupted";
    if (!completed) {
      // Once a previous sentence has reached a listener, replaying the whole
      // prompt through another engine would repeat part of an exam question.
      return i === 0 ? "not-started" : "interrupted";
    }
    /* No added gap between sentences. Each sentence is already a separate
       utterance, so the engine's own stop and start is the pause; 60ms was
       being spent on top of a silence that was there anyway, which is why
       consecutive sentences of one question sounded further apart than the
       full stop between them warrants. */
  }
  return sequence === speechSequence ? "completed" : "interrupted";
}

/** Preserve the Start button's audio permission across asynchronous setup. */
export function primeSpeechPlayback(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.resume();
    const primer = new SpeechSynthesisUtterance(".");
    primer.volume = 0;
    primer.rate = 10;
    window.speechSynthesis.speak(primer);
  } catch {
    // Neural/native speech may still work; the caller handles final failure.
  }
}

/** Speak a prompt and return true only after every sentence has completed. */
export async function speak(text: string, rate = 1): Promise<boolean> {
  const sequence = ++speechSequence;
  const lines = toSentences(text);
  if (lines.length === 0) return false;
  if (isNative()) {
    const tts = await nativeTTS();
    if (sequence !== speechSequence) return false;
    if (tts) {
      for (let i = 0; i < lines.length && sequence === speechSequence; i += 1) {
        try {
          await tts.speak({
            text: lines[i],
            lang: "en-GB",
            // One rate for the whole prompt, for the reason given on the
            // browser path above: alternating it by sentence index is heard as
            // unsteadiness, not as expression.
            rate: rate * 0.96,
            pitch: 0.98,
          });
        } catch {
          return false;
        }
        // The iOS bridge resolves a cancelled utterance, so sequence identity is
        // what distinguishes a completed line from `stop()` resolving it.
        if (sequence !== speechSequence) return false;
      }
      return sequence === speechSequence;
    }
  }
  // The speaking page prepares Kokoro from its Start button. If it is ready,
  // prefer that consistent British neural voice over whichever system voice
  // this particular browser happens to expose. Do not await an unavailable
  // model on the first question: the direct browser fallback needs to begin
  // while the Start click is still a trusted user interaction.
  const naturalResult = naturalExaminerVoiceReady()
    ? await speakNaturalExaminer(text, rate)
    : "unavailable";
  if (sequence !== speechSequence || naturalResult === "cancelled") return false;
  if (naturalResult === "completed") return true;
  const browserResult = await speakBrowserPrompt(lines, rate, sequence);
  if (sequence !== speechSequence || browserResult === "interrupted") return false;
  if (browserResult === "completed") return true;

  // `prepareNaturalExaminerVoice` was kicked off in the Start button handler.
  // The browser only reaches this branch when its very first sentence never
  // started, so the full prompt has not been heard and it is safe to retry it
  // once through the already user-gesture-primed WebAudio voice.
  if (!(await waitForNaturalExaminerVoice()) || sequence !== speechSequence) return false;
  const recovered = await speakNaturalExaminer(text, rate);
  return sequence === speechSequence && recovered === "completed";
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

export {
  disposeNaturalExaminerVoice,
  naturalExaminerVoiceBusy,
  prepareNaturalExaminerVoice,
  waitForNaturalExaminerVoice,
};
