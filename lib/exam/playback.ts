"use client";

import { spokenForm } from "../speech-text";
import { toSentences } from "../speech";
import type { ListeningTest } from "../types";

/*
  Reading a listening script aloud, for practice and for the mock exam.

  This was inside app/practice/listening/page.tsx, which was the right place
  while there was one listener. The sitting is a second one, and a second copy
  of speech scheduling is not a thing to own: the bugs here are all timing bugs
  — a chain that keeps speaking after the page has gone, a gap that swallows a
  turn — and they would be fixed once in whichever copy was noticed.
*/

export interface PlaybackHooks {
  voices: SpeechSynthesisVoice[];
  rate: () => number;
  stillPlaying: () => boolean;
  onTurn: (index: number) => void;
  /** Called only after the browser confirms that speech has actually begun. */
  onStart?: () => void;
  /**
   * Unlike an intentional stop, a browser voice failure leaves the learner
   * with a retryable recording rather than silently skipping the script.
   */
  onError?: (message: string) => void;
  onEnd: () => void;
}

const START_TIMEOUT_MS = 2_500;

function completionTimeout(text: string): number {
  // A listed remote voice can sometimes emit `start` and then never finish.
  // This is deliberately proportional to the sentence length, rather than a
  // fixed short cutoff that would interrupt a normal slower voice.
  return Math.min(25_000, Math.max(6_000, 3_000 + text.length * 120));
}

/**
 * Try the chosen voice first, then an installed local voice, then the device
 * default. A cloud voice may be listed even when it cannot play right now.
 *
 * The local fallback is picked by speaker index too, and that is the whole
 * point of the change: it used to be `find(localService)`, the same single
 * voice for every speaker in the script. So a cloud voice failing on the
 * receptionist's line put the receptionist onto the one local voice — which
 * was quite possibly already the caller's voice — and from that turn on the
 * two characters in the conversation were one person. A recording where the
 * speakers merge halfway through is worse than one that never had two voices,
 * because the learner has already learned to tell them apart.
 */
function voiceCandidates(
  voices: SpeechSynthesisVoice[],
  speakerIndex: number,
): Array<SpeechSynthesisVoice | undefined> {
  const preferred = voices.length > 0 ? voices[speakerIndex % voices.length] : undefined;
  const local = voices.filter((voice) => voice.localService && voice !== preferred);
  const localForSpeaker = local.length > 0 ? local[speakerIndex % local.length] : undefined;
  return [...new Set<SpeechSynthesisVoice | undefined>([preferred, localForSpeaker, undefined])];
}

/*
  How far apart two consecutive lines are, in milliseconds.

  These were one number — 420 for every turn boundary — and a turn boundary is
  two different events. In Parts 1 and 3 it is one person stopping and another
  starting; in Parts 2 and 4 it is the same lecturer beginning a new paragraph.
  Giving both the same beat is what makes a discussion sound like a document
  being read out.

  The speaker-change figure is not a guess: it is the median silence measured
  across the 35 speaker changes in the shipped Part 1 recording and the 26 in
  the shipped Part 3, taken from the MP3s the server path actually serves
  (median 320 ms, range 120-630). Matching it here means a learner who falls
  back to browser speech gets the same exam rather than a slower relative of
  it.

  The paragraph figure is deliberately left where it was. Nothing that could be
  measured without hearing the result says whether a lecturer's paragraph break
  wants 420 ms or a second, so it keeps the value it has always had, and it is
  named here so the next person changing it knows which of the two they are
  changing.
*/
const SENTENCE_GAP_MS = 180;
const SPEAKER_CHANGE_GAP_MS = 320;
const SAME_SPEAKER_TURN_GAP_MS = 420;

/*
  Pitches for the one case where a device has a single usable voice and the
  script has a cast. Four steps rather than two, because a Part 3 has three or
  four people in it. Kept narrow on purpose: this is the difference between
  "another person is speaking" and a chipmunk, and it is only ever reached when
  the alternative is one voice reading every part.
*/
const SINGLE_VOICE_PITCH = [1.06, 0.92, 1, 0.86];

/**
 * Speak the script a sentence at a time rather than a turn at a time.
 *
 * Reading a whole paragraph as one utterance is what makes synthesised speech
 * sound mechanical: the pace never varies and there is no breath between
 * thoughts. Sentence-level playback, with a gap whose length depends on what
 * kind of boundary it is, is much closer to a person reading aloud.
 */
export function playScript(test: ListeningTest, from: number, hooks: PlaybackHooks): void {
  let failed = false;

  const fail = (message: string) => {
    if (failed || !hooks.stillPlaying()) return;
    failed = true;
    hooks.onError?.(message);
  };

  const speak = (turnIndex: number, sentenceIndex: number) => {
    if (failed || !hooks.stillPlaying()) return;
    if (turnIndex >= test.script.length) {
      hooks.onEnd();
      return;
    }
    const turn = test.script[turnIndex];
    const sentences = toSentences(turn.text);
    if (sentenceIndex >= sentences.length) {
      const next = test.script[turnIndex + 1];
      const gap = !next
        ? 0
        : next.speaker !== turn.speaker
          ? SPEAKER_CHANGE_GAP_MS
          : SAME_SPEAKER_TURN_GAP_MS;
      window.setTimeout(() => speak(turnIndex + 1, 0), gap);
      return;
    }

    const speakerIndex = Math.max(0, test.speakers.indexOf(turn.speaker));
    const candidates = voiceCandidates(hooks.voices, speakerIndex);
    const sentence = sentences[sentenceIndex];

    const attempt = (candidateIndex: number) => {
      if (failed || !hooks.stillPlaying()) return;
      const voice = candidates[candidateIndex];
      let settled = false;
      let started = false;
      let startTimer = 0;
      let endTimer = 0;

      const clearTimers = () => {
        window.clearTimeout(startTimer);
        window.clearTimeout(endTimer);
      };

      const tryFallback = () => {
        clearTimers();
        if (!hooks.stillPlaying()) return;
        if (candidateIndex + 1 >= candidates.length) {
          fail("The browser could not start this recording. Check its sound permission, then try again.");
          return;
        }
        // Clear a stuck or rejected queue before putting the next voice in it.
        // `settled` is already true, so the cancellation event cannot advance
        // the script underneath the fallback attempt.
        try {
          window.speechSynthesis.cancel();
          window.speechSynthesis.resume();
        } catch {
          // The next candidate may still start in browsers that reject cancel.
        }
        attempt(candidateIndex + 1);
      };

      try {
        const utter = new SpeechSynthesisUtterance(spokenForm(sentence));
        utter.lang = voice?.lang || "en-GB";
        if (voice) utter.voice = voice;
        /* Only shift pitch when one voice has to cover several speakers, and
           then give every speaker its own step rather than sorting the cast
           into "the first one" and "everybody else". A Part 3 has three or
           four people in it, and on a device with a single installed voice the
           old pair of pitches left two of them identical. */
        utter.pitch = hooks.voices.length > 1 ? 1 : SINGLE_VOICE_PITCH[speakerIndex % SINGLE_VOICE_PITCH.length];
        /* One rate for the whole recording. This was `rate * (0.97 +
           Math.random() * 0.06)`, meaning a fresh speed within a 6% band at
           every full stop. lib/speech.ts already worked out why that is not
           expression — the variation is between sentences rather than inside
           them, so what a listener hears is a delivery that will not settle —
           and removed the same trick from the examiner voice. It had no better
           claim here, and it also made the recording a different length on
           every play, which put a measurement of this pipeline out of reach. */
        utter.rate = hooks.rate();
        utter.onstart = () => {
          if (settled || !hooks.stillPlaying()) return;
          started = true;
          window.clearTimeout(startTimer);
          if (sentenceIndex === 0) hooks.onTurn(turnIndex);
          hooks.onStart?.();
          // Some engines say they started, then never call end or error. Stop
          // in that case rather than leaving a permanently spinning control.
          endTimer = window.setTimeout(() => {
            if (settled || !hooks.stillPlaying()) return;
            settled = true;
            try {
              window.speechSynthesis.cancel();
            } catch {
              // It may already be unavailable; the retry state is still valid.
            }
            fail("The recording stopped before it finished. Try playing it again.");
          }, completionTimeout(sentence));
        };
        utter.onend = () => {
          if (settled || !hooks.stillPlaying()) return;
          settled = true;
          clearTimers();
          // An `end` event without `start` is a known silent browser failure;
          // never treat it as an audible completed sentence.
          if (!started) {
            tryFallback();
            return;
          }
          const gap = sentenceIndex + 1 < sentences.length ? SENTENCE_GAP_MS : 0;
          window.setTimeout(() => speak(turnIndex, sentenceIndex + 1), gap);
        };
        utter.onerror = () => {
          if (settled || !hooks.stillPlaying()) return;
          settled = true;
          clearTimers();
          // An unavailable cloud voice can be retried safely only when it did
          // not start. Retrying after partial audio would repeat an answer.
          if (!started) {
            tryFallback();
            return;
          }
          fail("The recording stopped before it finished. Try playing it again.");
        };

        // Resume in the same click task. This fixes Safari/Chrome pages whose
        // synthesiser survives navigation in a paused state.
        window.speechSynthesis.resume();
        startTimer = window.setTimeout(() => {
          if (settled || !hooks.stillPlaying()) return;
          settled = true;
          try {
            window.speechSynthesis.cancel();
          } catch {
            // A default/local fallback can still be attempted below.
          }
          tryFallback();
        }, START_TIMEOUT_MS);
        window.speechSynthesis.speak(utter);
      } catch {
        settled = true;
        tryFallback();
      }
    };

    attempt(0);
  };
  speak(from, 0);
}
