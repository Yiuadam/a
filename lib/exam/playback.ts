"use client";

import { toSentences } from "@/lib/speech";
import type { ListeningTest } from "@/lib/types";

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
  onEnd: () => void;
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
  const speak = (turnIndex: number, sentenceIndex: number) => {
    if (!hooks.stillPlaying()) return;
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

    if (sentenceIndex === 0) hooks.onTurn(turnIndex);

    const utter = new SpeechSynthesisUtterance(sentences[sentenceIndex]);
    const speakerIdx = Math.max(0, test.speakers.indexOf(turn.speaker));
    if (hooks.voices.length > 0) {
      utter.voice = hooks.voices[speakerIdx % hooks.voices.length];
    }
    // Only shift pitch when one voice has to cover several speakers.
    utter.pitch = hooks.voices.length > 1 ? 1 : speakerIdx === 0 ? 1.04 : 0.92;
    // ±3% keeps the delivery from sounding metronomic.
    utter.rate = hooks.rate() * (0.97 + Math.random() * 0.06);
    const next = () => {
      if (!hooks.stillPlaying()) return;
      window.setTimeout(() => speak(turnIndex, sentenceIndex + 1), 180);
    };
    utter.onend = next;
    utter.onerror = next;
    window.speechSynthesis.speak(utter);
  };
  speak(from, 0);
}
