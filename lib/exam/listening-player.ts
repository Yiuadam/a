"use client";

import { apiUrl } from "../api";
import { LISTENING_PART } from "./mock";
import { listeningSequence, type ListeningSequenceStep } from "../listening-frame-audio";

/*
  Playing a reviewed listening paper as the recordings it actually has.

  A canonical paper is not a script to be read aloud by whatever the device
  keeps in its voice list. It is a set of MP3s — the narrator's frame around
  it and the dialogue itself, both generated once by Deepgram Aura and stored
  in R2 under immutable keys, cast per speaker, British throughout, and
  identical for every learner who sits it. Browser speech is the recovery
  path underneath that, not the plan.

  This exists as its own module because the practice page grew the whole
  machine inline and the mock exam then went without it entirely: the sitting
  called playScript and nothing else, so the one screen in the app that scores
  a candidate against real IELTS was the one screen read by whichever accents
  the device happened to ship. lib/exam/playback.ts already made this argument
  about browser speech — a second copy of scheduling is not a thing to own —
  and it applies with more force here, where the bugs are all timing bugs.
  app/practice/listening/page.tsx still holds its own older copy, wrapped in a
  transcript, a speed control and a progress bar it does not export; this is
  the shape those parts should eventually move behind. It plays the bare
  dialogue rather than this module's framed sequence — the frame is written
  for a timed sitting a candidate sits once, and practice's own replay button
  already gives a learner control the frame does not add anything to.

  ---------------------------------------------------------------------------
  Steps, not turns

  What this module walks is no longer "the dialogue, turn by turn". It is the
  full spoken plan lib/listening-frame-audio.ts builds: an introduction, a
  reading-time cue, a scripted silence, a resume cue, the dialogue itself, the
  same pause-and-resume partway through Parts 1 to 3, and a line that closes
  the part. Two kinds of step exist. An *audio* step is a URL to play, exactly
  as a dialogue turn always was. A *silence* step plays nothing at all — it is
  the reading time itself, and the two hooks below (`onSilenceStart`,
  `onSilenceEnd`) exist so a caller can say so on screen, because a scripted
  silence and a broken recording look identical to a candidate unless
  something on screen tells them apart.

  Two elements, alternately active and standby, exactly as before. Whichever
  is not audible sits with the next *audio* step already assigned and
  load()ed — a silence step is skipped when priming ahead, because there is
  nothing to fetch for it — so a turn boundary hands play() to a decoder that
  is already running instead of tearing one down and building another, and a
  silence's own twenty-five seconds is used to warm whatever plays when it
  ends rather than left idle.
*/

// Far enough ahead that a cold paper generates while earlier steps play, and
// short enough that opening a paper does not commission all of it at once.
const PREFETCH_AHEAD = 3;

export interface ListeningPlaybackFailure {
  /** Whether any of this recording was genuinely audible before it broke. */
  heard: boolean;
  /** The dialogue turn playback had reached, so speech can carry on from it. */
  turnIndex: number;
}

export interface ListeningPlaybackHooks {
  /** The first moment the browser confirms real sound, not a queued promise. */
  onAudible: () => void;
  /** A scripted silence has begun. Nothing is broken — this is reading time. */
  onSilenceStart: (info: { ms: number; label: string }) => void;
  /** The silence above has ended and an audio step is about to resume. */
  onSilenceEnd: () => void;
  onEnd: () => void;
  onFail: (failure: ListeningPlaybackFailure) => void;
}

export interface ListeningPlayback {
  stop: () => void;
}

/**
 * Start a bundled paper on its own recordings, framed the way the real test
 * frames a section.
 *
 * `questionsFrom` is this part's first sitting-relative question number —
 * `starts[index]` in components/exam/MockListening.tsx, which already has to
 * compute it for the on-screen numbering. Everything else the frame needs
 * (how many questions this paper asks, where its own reading-time pause
 * falls) is derived from the paper itself; see lib/listening-frame-audio.ts.
 *
 * Returns null when this paper has no server audio at all, so the caller can
 * fall back inside the same click rather than after an await — browsers only
 * grant audio to a user gesture, and a fallback that has left the gesture is
 * a fallback that is silently refused.
 */
export function playBundledListening(
  testId: string,
  questionsFrom: number,
  elements: readonly [HTMLAudioElement | null, HTMLAudioElement | null],
  hooks: ListeningPlaybackHooks,
): ListeningPlayback | null {
  const partNumber = LISTENING_PART[testId];
  const steps = partNumber ? listeningSequence(testId, partNumber, questionsFrom) : null;
  const [primary, secondary] = elements;
  if (!steps?.length || !primary || !secondary) return null;

  let stopped = false;
  let audible = false;
  let stepIndex = 0;
  let active: HTMLAudioElement = primary;
  // The step already assigned and load()ed on the standby element, or -1 when
  // nothing is waiting there. Believing a stale value would hand play() to an
  // element holding the wrong step, which is worse than loading one cold.
  let buffered = -1;
  const prefetched = new Set<number>();
  let silenceTimer = 0;

  const other = (element: HTMLAudioElement) => (element === primary ? secondary : primary);

  const release = () => {
    for (const element of [primary, secondary]) {
      element.removeEventListener("playing", handlePlaying);
      element.removeEventListener("ended", handleEnded);
      element.removeEventListener("error", handleError);
      try {
        element.pause();
        element.removeAttribute("src");
        element.load();
      } catch {
        // A browser that will not release the element still stops receiving
        // events from it, which is the part that could corrupt a later run.
      }
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(silenceTimer);
    release();
  };

  const fail = () => {
    if (stopped) return;
    const step = steps[stepIndex];
    const reached = step?.kind === "audio" ? step.turnIndex : 0;
    const heard = audible;
    stop();
    hooks.onFail({ heard, turnIndex: reached });
  };

  /** The next *audio* step from (not including) `from`, or -1 past the end. */
  const nextAudioStep = (from: number): number => {
    for (let index = from + 1; index < steps.length; index += 1) {
      if (steps[index].kind === "audio") return index;
    }
    return -1;
  };

  /*
    Ask the endpoint for steps nobody can hear yet.

    On a paper whose recordings are not in R2 yet, the first request for a
    step is what commissions it, and a learner should not be waiting on Aura
    at every full stop. Reaching the response headers is enough — the Worker
    has written the MP3 by then — so the body is cancelled rather than
    downloaded twice. Silence steps are skipped: there is nothing to fetch
    for a wait.
  */
  const prefetch = (from: number) => {
    const last = Math.min(steps.length, from + 1 + PREFETCH_AHEAD);
    for (let index = from + 1; index < last; index += 1) {
      const step = steps[index];
      if (step.kind !== "audio" || prefetched.has(index)) continue;
      prefetched.add(index);
      void fetch(apiUrl(step.url))
        .then((response) => {
          if (!response.ok) throw new Error(`audio prefetch ${response.status}`);
          return response.body?.cancel();
        })
        .catch(() => {
          prefetched.delete(index);
        });
    }
  };

  const prime = (current: number) => {
    const next = nextAudioStep(current);
    if (stopped || next === -1 || buffered === next) return;
    const step = steps[next] as Extract<ListeningSequenceStep, { kind: "audio" }>;
    const standby = other(active);
    try {
      standby.pause();
      standby.currentTime = 0;
      // Right for exactly as long as this element is standing by: it is
      // decoding something inaudible, precisely so the switch to it is
      // silent. A silence step in between buys this a full twenty-five
      // seconds to finish rather than the usual single turn's worth.
      standby.preload = "auto";
      standby.src = apiUrl(step.url);
      standby.load();
      buffered = next;
    } catch {
      // A failed preload is not a playback failure — the audible step is
      // untouched. Just stop believing the next one is ready.
      buffered = -1;
    }
  };

  const playAudioStep = (index: number) => {
    if (stopped) return;
    stepIndex = index;
    const step = steps[index] as Extract<ListeningSequenceStep, { kind: "audio" }>;
    const standby = other(active);
    if (buffered === index) {
      active = standby;
      buffered = -1;
    } else {
      try {
        active.pause();
        active.currentTime = 0;
        active.src = apiUrl(step.url);
        active.load();
      } catch {
        fail();
        return;
      }
    }
    try {
      void active.play().catch(fail);
    } catch {
      fail();
      return;
    }
    prime(index);
  };

  /** Advance to `index`: play its audio, or begin its scripted silence. */
  const runStep = (index: number) => {
    if (stopped) return;
    const step = steps[index];
    if (!step) {
      stop();
      hooks.onEnd();
      return;
    }
    if (step.kind === "silence") {
      stepIndex = index;
      hooks.onSilenceStart({ ms: step.ms, label: step.label });
      // There is nothing to play for twenty-five seconds; spend the time
      // warming whatever comes after it instead of leaving both elements idle.
      prime(index);
      silenceTimer = window.setTimeout(() => {
        if (stopped) return;
        hooks.onSilenceEnd();
        runStep(index + 1);
      }, step.ms);
      return;
    }
    playAudioStep(index);
  };

  /*
    Both elements carry every handler, because either can be the audible one
    depending on parity. Each therefore checks that the event came from the
    element presently authoritative: a late or stale event from the element
    that is silently buffering must never advance the paper or resurrect a
    recording the sitting has finished with.
  */
  function handlePlaying(event: Event): void {
    if (stopped || event.currentTarget !== active) return;
    prefetch(stepIndex);
    if (audible) return;
    audible = true;
    hooks.onAudible();
  }

  function handleEnded(event: Event): void {
    if (stopped || event.currentTarget !== active) return;
    runStep(stepIndex + 1);
  }

  function handleError(event: Event): void {
    if (stopped) return;
    if (event.currentTarget !== active) {
      buffered = -1;
      return;
    }
    fail();
  }

  for (const element of [primary, secondary]) {
    element.addEventListener("playing", handlePlaying);
    element.addEventListener("ended", handleEnded);
    element.addEventListener("error", handleError);
  }

  runStep(0);
  return { stop };
}
