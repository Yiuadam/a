"use client";

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
 */
function voiceCandidates(
  voices: SpeechSynthesisVoice[],
  speakerIndex: number,
): Array<SpeechSynthesisVoice | undefined> {
  const preferred = voices.length > 0 ? voices[speakerIndex % voices.length] : undefined;
  const local = voices.find((voice) => voice.localService && voice !== preferred);
  return [...new Set<SpeechSynthesisVoice | undefined>([preferred, local, undefined])];
}

/**
 * Speak the script a sentence at a time rather than a turn at a time.
 *
 * Reading a whole paragraph as one utterance is what makes synthesised speech
 * sound mechanical: the pace never varies and there is no breath between
 * thoughts. Sentence-level playback with short gaps — longer when the speaker
 * changes, as in a real conversation — plus a little jitter in the rate, gets
 * much closer to a person reading aloud.
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
      // Turn-taking gap: a beat longer than the pause between sentences.
      const gap = turnIndex + 1 < test.script.length ? 420 : 0;
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
        const utter = new SpeechSynthesisUtterance(sentence);
        utter.lang = voice?.lang || "en-GB";
        if (voice) utter.voice = voice;
        // Only shift pitch when one voice has to cover several speakers.
        utter.pitch = hooks.voices.length > 1 ? 1 : speakerIndex === 0 ? 1.04 : 0.92;
        // ±3% keeps the delivery from sounding metronomic.
        utter.rate = hooks.rate() * (0.97 + Math.random() * 0.06);
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
          const gap = sentenceIndex + 1 < sentences.length ? 180 : 0;
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
