"use client";

import { apiUrl } from "../api";
import { bundledListeningAudio, bundledListeningAudioUrl } from "../listening-audio";

/*
  Playing a reviewed listening paper as the recordings it actually has.

  A canonical paper is not a script to be read aloud by whatever the device
  keeps in its voice list. It is a set of MP3s, one per dialogue turn, each
  generated once by Deepgram Aura and stored in R2 under an immutable key —
  cast per speaker, British throughout, and identical for every learner who
  sits it. Browser speech is the recovery path underneath that, not the plan.

  This exists as its own module because the practice page grew the whole
  machine inline and the mock exam then went without it entirely: the sitting
  called playScript and nothing else, so the one screen in the app that scores
  a candidate against real IELTS was the one screen read by whichever accents
  the device happened to ship. lib/exam/playback.ts already made this argument
  about browser speech — a second copy of scheduling is not a thing to own —
  and it applies with more force here, where the bugs are all timing bugs.
  app/practice/listening/page.tsx still holds its own older copy, wrapped in a
  transcript, a speed control and a progress bar it does not export; this is
  the shape those parts should eventually move behind.

  Two elements, alternately active and standby. Whichever is not audible sits
  with the next turn already assigned and load()ed, so a turn boundary hands
  play() to a decoder that is already running instead of tearing one down and
  building another — which is heard as a gap of unpredictable length in the
  middle of a conversation, and in a sitting it is heard exactly once.
*/

// Far enough ahead that a cold paper generates while earlier turns play, and
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
  onEnd: () => void;
  onFail: (failure: ListeningPlaybackFailure) => void;
}

export interface ListeningPlayback {
  stop: () => void;
}

/**
 * Start a bundled paper on its own recordings.
 *
 * Returns null when this paper has no server audio at all, so the caller can
 * fall back inside the same click rather than after an await — browsers only
 * grant audio to a user gesture, and a fallback that has left the gesture is
 * a fallback that is silently refused.
 */
export function playBundledListening(
  testId: string,
  elements: readonly [HTMLAudioElement | null, HTMLAudioElement | null],
  hooks: ListeningPlaybackHooks,
): ListeningPlayback | null {
  const parts = bundledListeningAudio(testId)?.parts ?? [];
  const [primary, secondary] = elements;
  if (!parts.length || !primary || !secondary) return null;

  let stopped = false;
  let audible = false;
  let partIndex = 0;
  let active: HTMLAudioElement = primary;
  // The part already assigned and load()ed on the standby element, or -1 when
  // nothing is waiting there. Believing a stale value would hand play() to an
  // element holding the wrong turn, which is worse than loading one cold.
  let buffered = -1;
  const prefetched = new Set<number>();

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
    release();
  };

  const fail = () => {
    if (stopped) return;
    const reached = parts[partIndex]?.turnIndex ?? 0;
    const heard = audible;
    stop();
    hooks.onFail({ heard, turnIndex: reached });
  };

  /*
    Ask the endpoint for turns nobody can hear yet.

    On a paper whose recordings are not in R2 yet, the first request for a turn
    is what commissions it, and a learner should not be waiting on Aura at
    every full stop. Reaching the response headers is enough — the Worker has
    written the MP3 by then — so the body is cancelled rather than downloaded
    twice.
  */
  const prefetch = (from: number) => {
    const last = Math.min(parts.length, from + 1 + PREFETCH_AHEAD);
    for (let part = from + 1; part < last; part += 1) {
      if (prefetched.has(part)) continue;
      prefetched.add(part);
      void fetch(apiUrl(bundledListeningAudioUrl(testId, part)))
        .then((response) => {
          if (!response.ok) throw new Error(`audio prefetch ${response.status}`);
          return response.body?.cancel();
        })
        .catch(() => {
          prefetched.delete(part);
        });
    }
  };

  const prime = (current: number) => {
    const next = current + 1;
    if (stopped || next >= parts.length || buffered === next) return;
    const standby = other(active);
    try {
      standby.pause();
      standby.currentTime = 0;
      // Right for exactly as long as this element is standing by: it is
      // decoding something inaudible, precisely so the switch to it is silent.
      standby.preload = "auto";
      standby.src = apiUrl(bundledListeningAudioUrl(testId, next));
      standby.load();
      buffered = next;
    } catch {
      // A failed preload is not a playback failure — the audible turn is
      // untouched. Just stop believing the next turn is ready.
      buffered = -1;
    }
  };

  const playPart = (part: number) => {
    if (stopped) return;
    partIndex = part;
    const standby = other(active);
    if (buffered === part) {
      active = standby;
      buffered = -1;
    } else {
      try {
        active.pause();
        active.currentTime = 0;
        active.src = apiUrl(bundledListeningAudioUrl(testId, part));
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
    prime(part);
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
    prefetch(partIndex);
    if (audible) return;
    audible = true;
    hooks.onAudible();
  }

  function handleEnded(event: Event): void {
    if (stopped || event.currentTarget !== active) return;
    const next = partIndex + 1;
    if (next < parts.length) {
      playPart(next);
      return;
    }
    stop();
    hooks.onEnd();
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

  playPart(0);
  return { stop };
}
