"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BandBadge from "@/components/BandBadge";
import ScoreFooter from "@/components/ScoreFooter";
import PracticeLoading from "@/components/PracticeLoading";
import Review from "@/components/Review";
import TestQuestions, {
  type AnswerMap,
  type CheckedMap,
} from "@/components/TestQuestions";
import { testAdvice } from "@/lib/advice";
import { marksEarned, rawToBand } from "@/lib/band";
import { rankedEnglishVoices } from "@/lib/speech";
import { apiUrl } from "@/lib/api";
import { playScript } from "@/lib/exam/playback";
import { bundledListeningAudio, bundledListeningAudioUrl } from "@/lib/listening-audio";
import {
  bundledListeningFrameAudio,
  bundledListeningFrameAudioUrl,
} from "@/lib/listening-frame-audio";
import { LISTENING_PART } from "@/lib/exam/mock";
import { spokenForm } from "@/lib/speech-text";
import {
  cancelNaturalExaminerVoice,
  disposeNaturalExaminerVoice,
  naturalExaminerVoiceSupported,
  speakNaturalExaminer,
  waitForNaturalExaminerVoice,
} from "@/lib/neural-speech";
import { useMounted, useProfile } from "@/lib/hooks";
import { flatQuestions, questionCount, questionWidth } from "@/lib/questions";
import { buildReview } from "@/lib/review";
import { savedAnswers } from "@/lib/results";
import { addResult } from "@/lib/store";
import { LISTENING_TESTS } from "@/lib/tests";
import type { ListeningTest } from "@/lib/types";
import TestChooser from "@/components/TestChooser";
import ExamShell from "@/components/exam/ExamShell";
import { useExamNavigation } from "@/lib/exam/navigation";
import styles from "./listening.module.css";
import GlassSelect from "@/components/GlassSelect";
import AssignedPracticeNotice from "@/components/organization/AssignedPracticeNotice";

const bundled = LISTENING_TESTS;
const NATIVE_AUDIO_PREFETCH_AHEAD = 3;

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function ListeningTestPageRunner() {
  const params = useSearchParams();
  const profile = useProfile();
  const mounted = useMounted();
  const [started, setStarted] = useState(false);
  // Exam practice and study practice are different activities; a clock helps
  // the first and gets in the way of the second.
  const [mode, setMode] = useState<"timed" | "free">("timed");
  const [answers, setAnswers] = useState<AnswerMap>({});
  // Questions the learner marked mid-test. Checking locks the answer, so a
  // checked question still counts exactly as it stood when it was checked.
  const [checked, setChecked] = useState<CheckedMap>({});
  const [submitted, setSubmitted] = useState(false);
  const [band, setBand] = useState<number | null>(null);
  const [raw, setRaw] = useState(0);
  const [playing, setPlaying] = useState(false);
  // SpeechSynthesis may accept an utterance without ever making a sound. Keep
  // "starting" separate from "playing" so that failure is visible instead of
  // looking like a completed listening recording.
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackTurn, setPlaybackTurn] = useState(0);
  const [turnIndex, setTurnIndex] = useState(-1);
  const [finishedAudio, setFinishedAudio] = useState(false);
  const [usingServerAudio, setUsingServerAudio] = useState(false);
  const [usingBuiltInAudio, setUsingBuiltInAudio] = useState(false);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioPartIndex, setAudioPartIndex] = useState(0);
  const [rate, setRate] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);

  const playingRef = useRef(false);
  const playbackRunRef = useRef(0);
  const nativeAudioRunRef = useRef(0);
  // Two elements, alternately active and standby, so a turn boundary never
  // has to tear down and rebuild a decode pipeline: whichever element is not
  // currently playing sits ready with the next part already loaded (see
  // nativeAudioActiveRef and primeNativeAudioBuffer below).
  const nativeAudioRef = useRef<HTMLAudioElement | null>(null);
  const nativeAudioBufferRef = useRef<HTMLAudioElement | null>(null);
  // Whichever of the two elements above is presently the one actually
  // playing. Every native-audio DOM event below is ignored unless it fired
  // on this exact element, so a stray/late event from the other element —
  // silently buffering, never played — can never resurrect playback or move
  // the part index. This is the same kind of protection the run-token guards
  // already give against a superseded run, applied to "which of the two
  // elements gets to speak" instead of "which run gets to speak".
  const nativeAudioActiveRef = useRef<HTMLAudioElement | null>(null);

  /*
    The spoken frame, or the two lines of it that mean anything here.

    A learner opening a listening paper from practice used to hear the dialogue
    with no introduction at all — straight into the middle of a conversation
    with no idea which part it is or who is speaking. The real test never does
    that, and the mock sitting already does not: lib/listening-frame-audio.ts
    builds the whole frame and MockListening speaks it.

    Only `intro` and `end` are spoken here, and that is a limit of the
    catalogue rather than a judgement about what a learner deserves. The middle
    of the frame is reading time — "you now have thirty seconds to look at
    questions twenty-one to thirty" — and those lines are built around
    sitting-relative question numbers. Practice renders every paper numbered
    from 1, so the narrator would read numbers that are not on the screen.
    `isReachableStart` refuses to resolve them for exactly that reason, and it
    is right to: a wrong number spoken with total confidence is worse than
    silence. `intro` and `end` carry no number, and resolve for all 32 papers.

    It plays on its own element rather than through the dialogue's pair. The
    part recording is a buffer-swapped playlist that also drives the progress
    bar, the time readout, the speed control and — in timed mode — the
    one-shot lock that stops a candidate replaying a part. Threading two
    narration lines through that machinery would put all of it at risk to add
    a sentence at each end. On its own element, none of it can be affected.
  */
  const frameAudioRef = useRef<HTMLAudioElement | null>(null);

  const nativeAudioPartRef = useRef(0);
  const nativeAudioPartCountRef = useRef(1);
  const nativeAudioFromRef = useRef(0);
  // The part index already assigned and load()ed on whichever element is not
  // currently active, or -1 if nothing is queued there yet.
  const nativeAudioBufferedPartRef = useRef(-1);
  const prefetchedNativeAudioPartsRef = useRef(new Set<number>());
  const rateRef = useRef(1);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  // AI-generated tests live in the profile, so resolve against both sources.
  const test = useMemo(() => {
    const id = params.get("id");
    return (
      bundled.find((t) => t.id === id) ??
      (profile.genTests.find((g) => g.kind === "listening" && g.test.id === id)?.test as
        | ListeningTest
        | undefined) ??
      null
    );
  }, [params, profile.genTests]);

  const frameLine = useCallback(
    (kind: "intro" | "end"): string | null => {
      const part = test ? LISTENING_PART[test.id] : undefined;
      if (!test || !part) return null;
      const line = bundledListeningFrameAudio(`${test.id}-p${part}-${kind}`);
      return line ? apiUrl(bundledListeningFrameAudioUrl(line.id)) : null;
    },
    [test],
  );

  /*
    Speak one frame line, then carry on regardless.

    `then` runs on `ended`, on `error`, and when there is no line to play — a
    paper outside the bundled set, a narration file that 404s, a phone that
    refuses to autoplay. The frame is an improvement to the recording, never a
    precondition for hearing it: every failure here has to fall through to the
    dialogue rather than leave a learner staring at a Play button that did
    nothing. The run token is re-checked at the moment of continuing, so Stop
    pressed during the introduction stops there instead of being followed by
    the recording it was introducing.
  */
  const playFrameLine = useCallback(
    (run: number, kind: "intro" | "end", then: () => void) => {
      const media = frameAudioRef.current;
      const url = frameLine(kind);
      const carryOn = () => {
        if (playbackRunRef.current !== run) return;
        then();
      };
      if (!media || !url) {
        carryOn();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        media.onended = null;
        media.onerror = null;
        carryOn();
      };
      media.onended = finish;
      media.onerror = finish;
      try {
        media.pause();
        media.src = url;
        media.load();
        /* The narrator is read at the paper's own pace, not the learner's: the
           speed control is for the dialogue, which is the thing being
           practised. A slowed-down introduction just delays the recording. */
        media.playbackRate = 1;
        void media.play().catch(finish);
      } catch {
        finish();
      }
    },
    [frameLine],
  );

  /*
    "That is the end of part three." Spoken every way a recording can finish —
    the bundled MP3 playlist on either element, the browser-speech reading, and
    the built-in fallback — because a learner should not be able to tell which
    of those they got. Nothing waits on it: the paper is already marked as
    heard and the questions are already answerable by the time it speaks.
  */
  const speakClosingLine = useCallback(
    (run: number) => {
      playFrameLine(run, "end", () => {});
    },
    [playFrameLine],
  );

  const flat = useMemo(() => (test ? flatQuestions(test.questions) : []), [test]);
  // Only the reviewed, canonical papers get the local neural recovery path.
  // Generated papers continue to use browser speech so an unexpectedly long
  // script never starts a large model download without an explicit choice.
  const isBundledTest = !!test && bundled.some((candidate) => candidate.id === test.id);
  const serverAudioParts = useMemo(
    () => (isBundledTest && test ? bundledListeningAudio(test.id)?.parts ?? [] : []),
    [isBundledTest, test],
  );
  const nav = useExamNavigation(
    useMemo(
      () =>
        flat.map((q) => ({
          id: q.id,
          answered: answers[q.id] !== undefined,
          width: questionWidth(q),
        })),
      [flat, answers],
    ),
  );

  const ttsSupported = mounted && typeof window !== "undefined" && "speechSynthesis" in window;
  const builtInAudioSupported = mounted && isBundledTest && naturalExaminerVoiceSupported();
  // A canonical paper can always try the same-origin MPEG route first. That
  // remains playable in embedded browsers that expose neither Web Speech nor
  // WebAudio, while generated papers keep their browser-only speech path.
  const audioSupported = ttsSupported || builtInAudioSupported || isBundledTest;
  const serverAudioPartCount = Math.max(1, serverAudioParts.length);
  const serverAudioProgress =
    audioDuration > 0
      ? Math.min(1, (audioPartIndex + audioCurrentTime / audioDuration) / serverAudioPartCount)
      : undefined;

  useEffect(() => {
    if (!ttsSupported) return;
    const loadVoices = () => {
      voicesRef.current = rankedEnglishVoices();
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      // Disarm the chain BEFORE cancelling: cancel() fires the current
      // utterance's end/error event, which would otherwise queue the next turn
      // and keep reading the script after the user has navigated away.
      playbackRunRef.current += 1;
      playingRef.current = false;
      window.speechSynthesis.cancel();
    };
  }, [ttsSupported]);

  useEffect(() => {
    return () => {
      playbackRunRef.current += 1;
      nativeAudioRunRef.current = 0;
      playingRef.current = false;
      cancelNaturalExaminerVoice();
      disposeNaturalExaminerVoice();
    };
  }, []);

  useEffect(() => {
    // The player does not exist on the chooser screen, so capture the actual
    // elements only after the test workspace mounts. This avoids leaving
    // media running if the learner returns to the chooser or navigates away.
    const elements = [nativeAudioRef.current, nativeAudioBufferRef.current];
    return () => {
      for (const media of elements) {
        if (!media) continue;
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
    };
  }, [started]);

  const startBuiltInAudio = useCallback(
    async (run: number) => {
      if (!test || !isBundledTest || !builtInAudioSupported) {
        if (playbackRunRef.current !== run) return;
        playingRef.current = false;
        setPlaying(false);
        setPlaybackStarted(false);
        setUsingBuiltInAudio(false);
        setPlaybackError("This recording could not be prepared. Use the transcript below instead.");
        return;
      }

      try {
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
      } catch {
        // WebAudio remains a valid recovery path when browser speech cannot cancel.
      }

      playingRef.current = true;
      setPlaying(true);
      setPlaybackStarted(false);
      setUsingBuiltInAudio(true);
      setPlaybackError(null);

      const ready = await waitForNaturalExaminerVoice();
      if (playbackRunRef.current !== run) return;
      if (!ready) {
        playingRef.current = false;
        setPlaying(false);
        setPlaybackStarted(false);
        setUsingBuiltInAudio(false);
        setPlaybackError(
          "BandUp could not prepare the built-in British audio. Check your connection and try again, or use the transcript.",
        );
        return;
      }

      // The local emergency recording intentionally uses one British voice.
      // It keeps the entire canonical paper audible when a browser exposes no
      // working SpeechSynthesis voice; normal browser playback still preserves
      // the multiple-speaker delivery first.
      setPlaybackStarted(true);
      const result = await speakNaturalExaminer(
        test.script.map((turn) => spokenForm(turn.text)).join("\n"),
        rateRef.current,
      );
      if (playbackRunRef.current !== run) return;
      if (result === "completed") {
        playingRef.current = false;
        setPlaying(false);
        setPlaybackStarted(false);
        setUsingBuiltInAudio(false);
        setFinishedAudio(true);
        setTurnIndex(-1);
        setPlaybackTurn(test.script.length);
        speakClosingLine(run);
        return;
      }
      if (result === "cancelled") return;

      playingRef.current = false;
      setPlaying(false);
      setPlaybackStarted(false);
      setUsingBuiltInAudio(false);
      setTurnIndex(-1);
      setPlaybackError(
        "The built-in British audio stopped before it finished. Check your connection and try again, or use the transcript.",
      );
    },
    [builtInAudioSupported, isBundledTest, speakClosingLine, test],
  );

  const startBrowserAudio = useCallback(
    (run: number, from: number) => {
      if (!test || playbackRunRef.current !== run) return;
      const freshVoices = rankedEnglishVoices();
      if (freshVoices.length > 0) voicesRef.current = freshVoices;
      setUsingServerAudio(false);
      setUsingBuiltInAudio(false);
      setAudioCurrentTime(0);
      setAudioDuration(0);
      if (!ttsSupported) {
        void startBuiltInAudio(run);
        return;
      }
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();
      } catch {
        if (builtInAudioSupported) {
          void startBuiltInAudio(run);
          return;
        }
        playingRef.current = false;
        setPlaying(false);
        setPlaybackError("Your browser could not prepare the recording. Check its sound permission, then try again.");
        return;
      }
      playingRef.current = true;
      setPlaying(true);
      playScript(test, from, {
        voices: voicesRef.current,
        rate: () => rateRef.current,
        stillPlaying: () => playingRef.current && playbackRunRef.current === run,
        onTurn: (index) => {
          setTurnIndex(index);
          setPlaybackTurn(index - from + 1);
        },
        onStart: () => {
          if (playbackRunRef.current !== run) return;
          setPlaybackStarted(true);
        },
        onError: (message) => {
          if (playbackRunRef.current !== run) return;
          if (builtInAudioSupported) {
            void startBuiltInAudio(run);
            return;
          }
          playingRef.current = false;
          setPlaying(false);
          setPlaybackStarted(false);
          setTurnIndex(-1);
          setPlaybackError(message);
        },
        onEnd: () => {
          if (playbackRunRef.current !== run) return;
          playingRef.current = false;
          setPlaying(false);
          setPlaybackStarted(false);
          setFinishedAudio(true);
          setTurnIndex(-1);
          setPlaybackTurn(test.script.length);
          speakClosingLine(run);
        },
      });
    },
    [builtInAudioSupported, speakClosingLine, startBuiltInAudio, test, ttsSupported],
  );

  const fallbackFromNativeAudio = useCallback(
    (run: number, from: number) => {
      if (nativeAudioRunRef.current !== run || playbackRunRef.current !== run) return;
      nativeAudioRunRef.current = 0;
      nativeAudioPartRef.current = 0;
      nativeAudioPartCountRef.current = 1;
      nativeAudioBufferedPartRef.current = -1;
      nativeAudioActiveRef.current = null;
      prefetchedNativeAudioPartsRef.current.clear();
      for (const media of [nativeAudioRef.current, nativeAudioBufferRef.current]) {
        if (!media) continue;
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      startBrowserAudio(run, from);
    },
    [startBrowserAudio],
  );

  const prefetchNativeAudioParts = useCallback(
    (currentPart: number) => {
      if (!test || !isBundledTest) return;
      const last = Math.min(serverAudioParts.length, currentPart + 1 + NATIVE_AUDIO_PREFETCH_AHEAD);
      for (let part = currentPart + 1; part < last; part += 1) {
        if (prefetchedNativeAudioPartsRef.current.has(part)) continue;
        prefetchedNativeAudioPartsRef.current.add(part);
        // The response is immutable and R2-backed. Reaching its headers means
        // the Worker has already stored a cacheable MP3; canceling the browser
        // body avoids downloading a second copy before its dialogue turn.
        void fetch(apiUrl(bundledListeningAudioUrl(test.id, part)))
          .then((response) => {
            if (!response.ok) throw new Error(`audio prefetch ${response.status}`);
            return response.body?.cancel();
          })
          .catch(() => {
            prefetchedNativeAudioPartsRef.current.delete(part);
          });
      }
    },
    [isBundledTest, serverAudioParts.length, test],
  );

  // Given one of the two native-audio elements (or null), returns the other.
  // Stable across renders — it only reads the two element refs, never a
  // reactive value — so it is safe for other callbacks below to depend on.
  const otherNativeAudioElement = useCallback(
    (element: HTMLAudioElement | null) =>
      element === nativeAudioRef.current ? nativeAudioBufferRef.current : nativeAudioRef.current,
    [],
  );

  /*
    Put the chosen speed on a media element.

    The speed control below has always fed `rateRef`, and `rateRef` has always
    reached the two speech paths — but never this one, which is the path a
    canonical paper actually takes. A learner who chose 0.85x got the recording
    at 1x and no indication that the control had done nothing. Both elements
    are set, not just the audible one: the standby element is already decoding
    the next turn, and a rate applied only at `play()` would step back to 1x on
    the very handoff this player exists to make seamless.

    `preservesPitch` is what makes a slower recording usable rather than a
    parody of one. It is the default in current browsers, and setting it
    explicitly costs nothing where it is already true and rescues the case
    where a browser has resampling as its default.
  */
  const applyPlaybackRate = useCallback((value: number) => {
    for (const media of [nativeAudioRef.current, nativeAudioBufferRef.current]) {
      if (!media) continue;
      try {
        media.preservesPitch = true;
        media.playbackRate = value;
      } catch {
        // A browser that rejects the rate still plays the recording at 1x,
        // which is the behaviour this replaces rather than a new failure.
      }
    }
  }, []);

  const primeNativeAudioBuffer = useCallback(
    (run: number, activePart: number) => {
      if (!test || nativeAudioRunRef.current !== run) return;
      const nextPart = activePart + 1;
      if (nextPart >= serverAudioParts.length) return;
      if (nativeAudioBufferedPartRef.current === nextPart) return;
      const standby = otherNativeAudioElement(nativeAudioActiveRef.current);
      if (!standby) return;
      try {
        standby.pause();
        standby.currentTime = 0;
        // Unlike the active element, this one benefits from preloading: it
        // is decoding a part nobody can hear yet, precisely so the eventual
        // switch to it is silent. `preload="none"` in the JSX below is right
        // for an element sitting idle; this overrides it for exactly as long
        // as this element is the one standing by.
        standby.preload = "auto";
        standby.src = apiUrl(bundledListeningAudioUrl(test.id, nextPart));
        standby.load();
        applyPlaybackRate(rateRef.current);
        nativeAudioBufferedPartRef.current = nextPart;
      } catch {
        // A failed preload of the part after this one is not a playback
        // failure — the audible part is unaffected. Just stop believing the
        // next part is ready, so playNativeAudioPart loads it cold instead
        // of handing play() to an element that never finished loading.
        nativeAudioBufferedPartRef.current = -1;
      }
    },
    [applyPlaybackRate, otherNativeAudioElement, serverAudioParts.length, test],
  );

  const playNativeAudioPart = useCallback(
    (run: number, from: number, part: number) => {
      if (!test || !isBundledTest || part < 0 || part >= serverAudioParts.length) {
        startBrowserAudio(run, from);
        return;
      }

      nativeAudioRunRef.current = run;
      nativeAudioPartRef.current = part;
      nativeAudioPartCountRef.current = serverAudioParts.length;
      nativeAudioFromRef.current = from;
      playingRef.current = true;
      setPlaying(true);
      setPlaybackStarted(false);
      setUsingServerAudio(true);
      setUsingBuiltInAudio(false);
      setAudioCurrentTime(0);
      setAudioDuration(0);
      setAudioPartIndex(part);

      // The element standing by already has this exact part decoded whenever
      // playback is advancing turn by turn in order: hand it play() directly
      // rather than reassigning `src`, because that reassignment is exactly
      // the decode-pipeline teardown/rebuild this second element exists to
      // avoid. Anything else — the first part of a run, a retry, a replay
      // from the start — has no ready buffer, so it falls through below and
      // loads cold, same as before this player had two elements.
      const standby = otherNativeAudioElement(nativeAudioActiveRef.current);
      if (nativeAudioBufferedPartRef.current === part && standby) {
        nativeAudioActiveRef.current = standby;
        nativeAudioBufferedPartRef.current = -1;
        try {
          applyPlaybackRate(rateRef.current);
          void standby.play().catch(() => fallbackFromNativeAudio(run, from));
        } catch {
          fallbackFromNativeAudio(run, from);
        }
        primeNativeAudioBuffer(run, part);
        return;
      }

      const media = nativeAudioActiveRef.current ?? nativeAudioRef.current;
      nativeAudioActiveRef.current = media;
      if (!media) {
        startBrowserAudio(run, from);
        return;
      }
      try {
        media.pause();
        media.currentTime = 0;
        media.src = apiUrl(bundledListeningAudioUrl(test.id, part));
        media.load();
        applyPlaybackRate(rateRef.current);
        // The first call is directly in the learner's click path. Each later
        // part is started synchronously by the previous media `ended` event,
        // so a long paper remains a normal, user-authorised audio playlist.
        void media.play().catch(() => fallbackFromNativeAudio(run, from));
      } catch {
        fallbackFromNativeAudio(run, from);
      }
      primeNativeAudioBuffer(run, part);
    },
    [
      applyPlaybackRate,
      fallbackFromNativeAudio,
      isBundledTest,
      otherNativeAudioElement,
      primeNativeAudioBuffer,
      serverAudioParts.length,
      startBrowserAudio,
      test,
    ],
  );

  const startNativeAudio = useCallback(
    (run: number, from: number) => {
      playNativeAudioPart(run, from, 0);
    },
    [playNativeAudioPart],
  );

  const startAudio = useCallback(
    (from: number) => {
      if (!test || !audioSupported) return;
      // A cancelled playback can synchronously emit `ended` or `error`. A run
      // identity makes that old callback harmless before a new recording starts.
      const run = ++playbackRunRef.current;
      nativeAudioRunRef.current = 0;
      nativeAudioPartRef.current = 0;
      nativeAudioPartCountRef.current = 1;
      nativeAudioFromRef.current = from;
      nativeAudioBufferedPartRef.current = -1;
      // Starting fresh always begins on nativeAudioRef (see playNativeAudioPart):
      // clearing this means a retry or replay can never mistake a stale
      // element left over from a previous run for an already-primed buffer.
      nativeAudioActiveRef.current = null;
      prefetchedNativeAudioPartsRef.current.clear();
      for (const media of [nativeAudioRef.current, nativeAudioBufferRef.current]) {
        if (!media) continue;
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      setPlaybackStarted(false);
      setPlaybackError(null);
      setPlaybackTurn(0);
      setTurnIndex(-1);
      setFinishedAudio(false);
      setUsingServerAudio(false);
      setUsingBuiltInAudio(false);
      setAudioCurrentTime(0);
      setAudioDuration(0);
      setAudioPartIndex(0);

      /* The introduction first, then whichever recording this paper has.
         playFrameLine calls straight through when there is no line, so a
         paper without one starts exactly as it did before. */
      playFrameLine(run, "intro", () => {
        if (isBundledTest) {
          startNativeAudio(run, from);
          return;
        }
        startBrowserAudio(run, from);
      });
    },
    [audioSupported, isBundledTest, playFrameLine, startBrowserAudio, startNativeAudio, test],
  );

  const stopAudio = useCallback(() => {
    playbackRunRef.current += 1;
    nativeAudioRunRef.current = 0;
    nativeAudioPartRef.current = 0;
    nativeAudioPartCountRef.current = 1;
    nativeAudioBufferedPartRef.current = -1;
    nativeAudioActiveRef.current = null;
    prefetchedNativeAudioPartsRef.current.clear();
    playingRef.current = false;
    for (const media of [nativeAudioRef.current, nativeAudioBufferRef.current]) {
      if (!media) continue;
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    /* Including mid-introduction. The run token above already stops the
       recording from following it, but the line itself is playing now and Stop
       has to mean stop. */
    if (frameAudioRef.current) {
      frameAudioRef.current.onended = null;
      frameAudioRef.current.onerror = null;
      frameAudioRef.current.pause();
      frameAudioRef.current.removeAttribute("src");
      frameAudioRef.current.load();
    }
    setPlaying(false);
    setPlaybackStarted(false);
    setUsingServerAudio(false);
    setUsingBuiltInAudio(false);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setAudioPartIndex(0);
    cancelNaturalExaminerVoice();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const openTest = useCallback(() => {
    // Canonical papers use the cached server recording first. Do not begin the
    // large on-device fallback download merely by opening a test; it is only
    // prepared if both native media and browser speech genuinely fail.
    setStarted(true);
  }, []);

  const submit = useCallback(() => {
    if (!test || submitted) return;
    stopAudio();
    const asked = flatQuestions(test.questions);
    /*
      Summed as marks, not as questions answered right — see the identical
      comment in app/practice/reading/page.tsx. A multi-select can earn one of
      its two marks without earning both.
    */
    let correct = 0;
    for (const q of asked) {
      correct += marksEarned(q, answers[q.id]);
    }
    const b = rawToBand(correct, questionCount(test.questions), "listening");
    const reviewItems = buildReview(test.questions, answers);
    const advice = testAdvice(
      "listening",
      test.questions,
      reviewItems.map((item) => item.id),
      b,
    );
    setRaw(correct);
    setBand(b);
    setSubmitted(true);
    setShowTranscript(true);
    addResult({
      module: "listening",
      testId: test.id,
      testTitle: test.title,
      band: b,
      raw: correct,
      total: asked.length,
      date: new Date().toISOString(),
      review: {
        kind: "objective",
        questions: test.questions,
        answers: savedAnswers(answers),
        advice,
        source: { kind: "listening", script: test.script },
      },
    });
  }, [test, answers, submitted, stopAudio]);

  // Generated tests are read from localStorage, so wait for hydration before
  // deciding a test is genuinely missing.
  /*
    No id in the URL is not an error — it is the header's "Listening" link,
    which is how most people arrive. It used to answer "we couldn't find that
    test on this device", which is a dead end wearing an error message: a
    learner who clicked Listening gets told something is missing and is sent
    to a page listing all four skills.

    So it lists the listening papers, and only those. An id that genuinely does
    not resolve — a stale bookmark, a generated test cleared from this browser
    — still says so, because that one is a real miss.
  */
  if (!test) {
    if (!mounted) return null;
    const asked = params.get("id");
    return (
      <TestChooser
        kind="listening"
        tests={bundled}
        missingId={asked}
      />
    );
  }

  if (!started) {
    return (
      <div className="mx-auto flex min-h-[calc(100dvh-var(--header-h))] max-w-xl items-center px-4">
        <div className="card w-full space-y-4 py-8 text-center">
          <AssignedPracticeNotice />
          <h1 className="text-[1.625rem] font-semibold text-slate-900">{test.title}</h1>
          <p className="text-sm text-slate-600">{test.context}</p>
          <p className="text-sm text-slate-600">
            The recording is read aloud with BandUp audio, with your browser as a fallback ({test.script.length} turns,{" "}
            {test.speakers.length} speaker{test.speakers.length > 1 ? "s" : ""}). Read the{" "}
            {questionCount(test.questions)} questions first, then press play and answer as you listen.
            In exam conditions you hear the recording <span className="font-medium">once</span> —
            but you can replay while practising.
          </p>
          {!ttsSupported && !builtInAudioSupported && !isBundledTest && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Your browser does not support speech synthesis. Use Chrome, Edge or Safari for
              audio — or practise in transcript mode below.
            </p>
          )}
          {!ttsSupported && isBundledTest && (
            <p className="text-inset-compact rounded-lg bg-indigo-50 py-2 text-sm text-indigo-800">
              BandUp will prepare a playable recording when you open this paper.
            </p>
          )}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              How do you want to do this test?
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  id: "timed" as const,
                  title: "Like the real exam",
                  blurb: `${test.timeMinutes} minutes. You cannot check answers`,
                },
                {
                  id: "free" as const,
                  title: "Practise slowly",
                  blurb: "No clock. Replay, pause and check answers",
                },
              ]).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setMode(option.id)}
                  className={`rounded-xl border px-4 py-3 text-left transition-all ${
                    mode === option.id
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-slate-200 bg-surface hover:border-slate-300"
                  }`}
                >
                  <span className="block text-sm font-semibold text-slate-900">
                    {option.title}
                  </span>
                  <span className="block text-xs text-slate-500">{option.blurb}</span>
                </button>
              ))}
            </div>
            {/*
              Under the choice, not above it, and describing the option that is
              actually selected. It used to sit above and describe checking as
              though it applied to both — next to a button labelled "Exam
              conditions", which is where the contradiction came from.
            */}
            <p className="text-inset-compact mt-2 rounded-lg bg-indigo-50 py-2 text-left text-sm leading-6 text-indigo-800">
              {mode === "timed"
                ? "Like the real exam: you cannot see any answers until you finish. When you finish, you get your band and every explanation."
                : "You can check one answer at a time and read why it is right. Once you check a question you cannot change it, so your band still means something."}
            </p>
          </div>
          <button className="btn-primary" onClick={openTest}>
            Open the test
          </button>
        </div>
      </div>
    );
  }

  return (
    <ExamShell
      section="Listening"
      paper={test.title}
      minutes={test.timeMinutes}
      running={mode === "timed" && !submitted}
      onExpire={submit}
      palette={submitted ? [] : nav.items}
      currentId={nav.currentId}
      onJump={nav.jump}
      onPrev={nav.prev}
      onNext={nav.next}
      onToggleReview={nav.toggleReview}
      topSummary={submitted && band !== null ? `Band ${band} · ${raw}/${flat.length}` : undefined}
      topRight={
        <div className="flex items-center gap-1.5">
          <GlassSelect
            label="Playback speed"
            value={String(rate)}
            options={[{ value: "0.85", label: "0.85×" }, { value: "1", label: "1×" }, { value: "1.15", label: "1.15×" }]}
            onValueChange={(value) => {
              const nextRate = Number(value);
              setRate(nextRate);
              rateRef.current = nextRate;
              /* The two speech paths read `rateRef` at each sentence, so they
                 pick this up on their own. A media element does not ask: it
                 has to be told, and telling it mid-recording is the point —
                 the learner who reaches for this control is usually already
                 losing the turn that is playing. */
              applyPlaybackRate(nextRate);
            }}
            compact
            className="w-[5.5rem]"
            minMenuWidth={96}
          />
          {audioSupported && !playing ? (
            <button
              type="button"
              className={styles.playbackControl}
              onClick={() => startAudio(0)}
              disabled={mode === "timed" && !submitted && (finishedAudio || turnIndex >= 0)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                className={styles.playbackIcon}
              >
                <path d="M2.5 1.5v9l7-4.5-7-4.5Z" />
              </svg>
              {playbackError ? "Retry audio" : finishedAudio ? "Replay" : "Play"}
            </button>
          ) : audioSupported ? (
            <button type="button" className={styles.playbackControl} onClick={stopAudio}>
              Stop
            </button>
          ) : null}
        </div>
      }
    >
      {/*
        Two elements, not one. While one plays the current part, the other
        sits standing by with the next part already assigned and load()ed
        (see primeNativeAudioBuffer), so the `ended` handler below only ever
        has to call play() on an element that is already decoding — never
        reassign `src` on the critical path, which is the decode-pipeline
        teardown/rebuild that used to leave an audible, variable-length gap
        at every turn boundary.

        Both elements carry the full set of handlers because either one can
        be active or standby at any moment depending on parity. Each handler
        still opens with the existing run-token guard — a stale or superseded
        run must stay harmless exactly as it always has — and now also checks
        that the event fired on nativeAudioActiveRef.current specifically, so
        a late event from the silently-buffering element can never resurrect
        playback or move the part index.
      */}
      {/*
        The narrator. One element, no buffer twin, and none of the handlers the
        pair below carry: it plays one short line at a time and its only two
        outcomes — finished, or failed — are wired up per play in playFrameLine
        rather than declared here, because what happens next differs between
        the introduction and the closing line.
      */}
      <audio ref={frameAudioRef} data-listening-frame-audio preload="none" aria-hidden="true" />

      <audio
        ref={nativeAudioRef}
        data-listening-native-audio
        preload="none"
        aria-hidden="true"
        onLoadedMetadata={(event) => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (event.currentTarget !== nativeAudioActiveRef.current) return;
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) setAudioDuration(duration);
        }}
        onPlaying={() => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (nativeAudioRef.current !== nativeAudioActiveRef.current) return;
          playingRef.current = true;
          setPlaying(true);
          setPlaybackStarted(true);
          setUsingServerAudio(true);
          setPlaybackError(null);
          prefetchNativeAudioParts(nativeAudioPartRef.current);
        }}
        onTimeUpdate={(event) => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (event.currentTarget !== nativeAudioActiveRef.current) return;
          const { currentTime, duration } = event.currentTarget;
          if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return;
          setAudioCurrentTime(currentTime);
          setAudioDuration(duration);
          const partProgress = nativeAudioPartRef.current + currentTime / duration;
          const paperProgress = partProgress / nativeAudioPartCountRef.current;
          const turn = Math.min(
            test.script.length,
            Math.max(1, Math.ceil(paperProgress * test.script.length)),
          );
          setPlaybackTurn(turn);
          setTurnIndex(Math.min(test.script.length - 1, turn - 1));
        }}
        onEnded={(event) => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (event.currentTarget !== nativeAudioActiveRef.current) return;
          const nextPart = nativeAudioPartRef.current + 1;
          if (nextPart < nativeAudioPartCountRef.current) {
            // The other element already has this next part buffered, so this
            // hands off rather than loading — advance before browser speech
            // is considered, so the full recording remains a media playlist.
            playNativeAudioPart(run, nativeAudioFromRef.current, nextPart);
            return;
          }
          nativeAudioRunRef.current = 0;
          playingRef.current = false;
          setPlaying(false);
          setPlaybackStarted(false);
          setUsingServerAudio(false);
          setUsingBuiltInAudio(false);
          setFinishedAudio(true);
          setTurnIndex(-1);
          setPlaybackTurn(test.script.length);
          speakClosingLine(run);
          if (Number.isFinite(event.currentTarget.duration)) {
            setAudioDuration(event.currentTarget.duration);
            setAudioCurrentTime(event.currentTarget.duration);
          }
        }}
        onError={() => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (nativeAudioRef.current !== nativeAudioActiveRef.current) {
            // The element that failed is standing by, not playing: the
            // audible part is unaffected. Stop believing the next part is
            // ready, so the following turn loads it fresh instead of handing
            // play() to an element that never finished loading.
            nativeAudioBufferedPartRef.current = -1;
            return;
          }
          fallbackFromNativeAudio(run, 0);
        }}
      />
      <audio
        ref={nativeAudioBufferRef}
        data-listening-native-audio-buffer
        preload="none"
        aria-hidden="true"
        onLoadedMetadata={(event) => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (event.currentTarget !== nativeAudioActiveRef.current) return;
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) setAudioDuration(duration);
        }}
        onPlaying={() => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (nativeAudioBufferRef.current !== nativeAudioActiveRef.current) return;
          playingRef.current = true;
          setPlaying(true);
          setPlaybackStarted(true);
          setUsingServerAudio(true);
          setPlaybackError(null);
          prefetchNativeAudioParts(nativeAudioPartRef.current);
        }}
        onTimeUpdate={(event) => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (event.currentTarget !== nativeAudioActiveRef.current) return;
          const { currentTime, duration } = event.currentTarget;
          if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return;
          setAudioCurrentTime(currentTime);
          setAudioDuration(duration);
          const partProgress = nativeAudioPartRef.current + currentTime / duration;
          const paperProgress = partProgress / nativeAudioPartCountRef.current;
          const turn = Math.min(
            test.script.length,
            Math.max(1, Math.ceil(paperProgress * test.script.length)),
          );
          setPlaybackTurn(turn);
          setTurnIndex(Math.min(test.script.length - 1, turn - 1));
        }}
        onEnded={(event) => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (event.currentTarget !== nativeAudioActiveRef.current) return;
          const nextPart = nativeAudioPartRef.current + 1;
          if (nextPart < nativeAudioPartCountRef.current) {
            // The other element already has this next part buffered, so this
            // hands off rather than loading — advance before browser speech
            // is considered, so the full recording remains a media playlist.
            playNativeAudioPart(run, nativeAudioFromRef.current, nextPart);
            return;
          }
          nativeAudioRunRef.current = 0;
          playingRef.current = false;
          setPlaying(false);
          setPlaybackStarted(false);
          setUsingServerAudio(false);
          setUsingBuiltInAudio(false);
          setFinishedAudio(true);
          setTurnIndex(-1);
          setPlaybackTurn(test.script.length);
          speakClosingLine(run);
          if (Number.isFinite(event.currentTarget.duration)) {
            setAudioDuration(event.currentTarget.duration);
            setAudioCurrentTime(event.currentTarget.duration);
          }
        }}
        onError={() => {
          const run = nativeAudioRunRef.current;
          if (!run || run !== playbackRunRef.current) return;
          if (nativeAudioBufferRef.current !== nativeAudioActiveRef.current) {
            // The element that failed is standing by, not playing: the
            // audible part is unaffected. Stop believing the next part is
            // ready, so the following turn loads it fresh instead of handing
            // play() to an element that never finished loading.
            nativeAudioBufferedPartRef.current = -1;
            return;
          }
          fallbackFromNativeAudio(run, 0);
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto" data-listening-paper>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--exam-line)] pb-2 text-xs text-[color:var(--exam-muted)]">
          <span>
            {playing
              ? usingServerAudio
                ? playbackStarted
                  ? "Playing BandUp audio…"
                  : "Preparing BandUp audio…"
                : usingBuiltInAudio
                ? playbackStarted
                  ? "Playing the built-in British audio…"
                  : "Preparing the built-in British audio…"
                : playbackStarted
                  ? `Playing ${turnIndex + 1} of ${test.script.length} · ${test.script[Math.max(0, turnIndex)]?.speaker}`
                  : "Starting the recording…"
              : finishedAudio
                ? "Recording finished"
                : playbackError
                  ? "Recording needs to be restarted"
                : mode === "timed"
                  ? "The recording plays once"
                  : "Replay and pause while practising"}
          </span>
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => setShowTranscript((shown) => !shown)}
          >
            {showTranscript ? "Hide transcript" : submitted || mode === "free" ? "Show transcript" : "Show transcript (spoiler)"}
          </button>
        </div>

        <div className="mb-4 space-y-2" data-listening-audio>
          <div className="flex items-center justify-between gap-3 text-xs text-[color:var(--exam-muted)]">
            <span className="font-medium text-[color:var(--exam-fg)]">Audio progress</span>
            <span aria-live="polite">
              {finishedAudio
                ? `Complete · ${test.script.length} of ${test.script.length} turns`
                : usingServerAudio && audioDuration > 0
                  ? `${formatAudioTime(audioCurrentTime)} of ${formatAudioTime(audioDuration)} · recording ${audioPartIndex + 1} of ${serverAudioPartCount}`
                  : usingServerAudio && playing
                    ? "Preparing BandUp audio"
                : usingBuiltInAudio && playing
                  ? "Built-in audio is playing"
                : playbackTurn > 0
                  ? `Turn ${playbackTurn} of ${test.script.length}`
                  : `Turn 0 of ${test.script.length}`}
            </span>
          </div>
          <progress
            data-listening-playback-progress
            aria-label="Audio playback progress"
            aria-valuemin={0}
            aria-valuemax={usingServerAudio && audioDuration > 0 ? 1 : test.script.length}
            aria-valuenow={
              usingServerAudio && audioDuration > 0
                ? serverAudioProgress
                : usingServerAudio && playing
                  ? undefined
                : usingBuiltInAudio && playing
                ? undefined
                : finishedAudio
                  ? test.script.length
                  : playbackTurn
            }
            aria-valuetext={
              finishedAudio
                ? `Complete, ${test.script.length} of ${test.script.length} turns`
                : usingServerAudio && audioDuration > 0
                  ? `${formatAudioTime(audioCurrentTime)} of ${formatAudioTime(audioDuration)}, recording ${audioPartIndex + 1} of ${serverAudioPartCount}`
                  : usingServerAudio && playing
                    ? "Preparing BandUp audio"
                : usingBuiltInAudio && playing
                  ? "Built-in British audio is playing"
                : `Turn ${playbackTurn} of ${test.script.length}`
            }
            value={
              usingServerAudio && audioDuration > 0
                ? serverAudioProgress
                : usingServerAudio && playing
                  ? undefined
                : usingBuiltInAudio && playing
                ? undefined
                : finishedAudio
                  ? test.script.length
                  : playbackTurn
            }
            max={usingServerAudio && audioDuration > 0 ? 1 : test.script.length}
            className="block h-2 w-full overflow-hidden rounded-full accent-indigo-600"
          />
          {playbackError && (
            <div
              data-listening-playback-error
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              <span>{playbackError}</span>
              <button
                type="button"
                className="font-semibold underline underline-offset-4"
                onClick={() => startAudio(0)}
              >
                Retry audio
              </button>
            </div>
          )}
        </div>

        {submitted && band !== null && (
          <div className="mb-4 grid gap-4 lg:grid-cols-[auto_1fr]">
            <BandBadge band={band} caption={`${raw}/${questionCount(test.questions)} correct`} />
            <Review
              items={buildReview(test.questions, answers)}
              advice={testAdvice(
                "listening",
                test.questions,
                buildReview(test.questions, answers).map((item) => item.id),
                band,
              )}
              total={questionCount(test.questions)}
            />
          </div>
        )}

        <TestQuestions
          questions={test.questions}
          answers={answers}
          onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
          submitted={submitted}
          checked={checked}
          onCheck={(id) => setChecked((current) => ({ ...current, [id]: true }))}
          mode={mode === "timed" ? "exam" : "practice"}
        />

        {!submitted && (
          <button className="btn-primary my-5 w-full" onClick={submit}>
            Submit answers
          </button>
        )}

        {showTranscript && (
          <section className="mb-5 border-t border-[color:var(--exam-line)] pt-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Transcript</h2>
            <div className="space-y-3">
              {test.script.map((turn, index) => (
                <p key={index} className="text-sm leading-6">
                  <span className="mr-1 font-semibold">{turn.speaker}:</span>
                  {turn.text}
                </p>
              ))}
            </div>
          </section>
        )}

        {submitted && band !== null && (
          <div className="mb-5">
            <ScoreFooter module="listening" band={band} raw={raw} total={flat.length} />
          </div>
        )}
      </div>
    </ExamShell>
  );
}

export default function ListeningTestPage() {
  return (
    <Suspense fallback={<PracticeLoading kind="Listening" />}>
      <ListeningTestPageRunner />
    </Suspense>
  );
}
