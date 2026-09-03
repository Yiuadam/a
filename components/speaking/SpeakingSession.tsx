"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import BandBadge from "@/components/BandBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import ExplainText from "@/components/ExplainText";
import UpgradePanel from "@/components/billing/UpgradePanel";
import { tierShows, useTier } from "@/lib/billing/useTier";
import VolumeMeter from "@/components/speaking/VolumeMeter";
import { apiUrl, postJSON } from "@/lib/api";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import { useSearchParams } from "next/navigation";
import speakingData from "@/data/speaking-topics.json";
import { useMounted } from "@/lib/hooks";
import {
  cancelSpeech,
  disposeNaturalExaminerVoice,
  getSpeechRecognition,
  serverSpeechPrefs,
  speechPrefs,
  speechRecognitionSupported,
  speak,
  subscribeSpeechPrefs,
  writeSpeechPrefs,
  type SpeechPrefs,
  type SpeechRecognitionEvent,
  type SpeechRecognitionLike,
} from "@/lib/speech";
import { addResult } from "@/lib/store";
import {
  LOCAL_MODELS,
  createLocalSession,
  deleteCachedModels,
  describeStatus,
  formatBytes,
  isModelCached,
  isLocalModelDownloadError,
  localAvailability,
  mergeAnswer,
  prepareLocal,
  type LocalBlocker,
  type LocalModelId,
  type LocalSession,
  type LocalStatus,
} from "@/lib/transcribe";
import type {
  SpeakingCueCard,
  SpeakingGrade,
  SpeakingTopicsData,
  SpeakingTranscriptTurn,
} from "@/lib/types";
import { SpeakingIcon } from "@/components/Icons";
import AssignedPracticeNotice from "@/components/organization/AssignedPracticeNotice";
import {
  countSpokenWords,
  decideNudge,
  decideTurnEnd,
  examinerFollowUp,
  examinerNudge,
  examinerQuestion,
  SPEAKING_PART_INTRO,
  type NudgeKind,
  type TurnEndReason,
} from "@/lib/speaking/turn-control";
import {
  bundledExaminerAudioUrl,
  examinerFollowUpAudioId,
  examinerNudgeAudioId,
  examinerQuestionAudioId,
} from "@/lib/examiner-audio";

const data = speakingData as SpeakingTopicsData;

type Turn = SpeakingTranscriptTurn;

interface Step {
  part: 1 | 2 | 3;
  question: string;
  cueCard?: SpeakingCueCard;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Build a shortened but structurally faithful mock interview. */
/*
  `cardId` is what the question library passes when somebody chooses a card
  rather than taking whichever one comes up.

  Only Part 2 is chosen. Parts 1 and 3 stay as they are — Part 1 because its
  small talk is not the thing anybody is browsing for, and Part 3 because it is
  a discussion *of the chosen topic* and is already picked to match the card.
  So choosing one card settles two thirds of the interview, which is what makes
  the choice worth offering.
*/
function buildInterview(cardId?: string | null): Step[] {
  const steps: Step[] = [];
  const topics = [...data.part1].sort(() => Math.random() - 0.5).slice(0, 2);
  for (const t of topics) {
    for (const q of t.questions.slice(0, 3)) steps.push({ part: 1, question: q });
  }
  /* An id that no longer exists falls back to a random card rather than
     failing: a stale link should still start an interview. */
  const card = (cardId ? data.part2.find((c) => c.id === cardId) : undefined) ?? pick(data.part2);
  steps.push({ part: 2, question: card.cueCard, cueCard: card });
  /*
    The rounding-off questions, which the real Part 2 always ends on and this
    interview was skipping.

    Every cue card in the bank carries two of them and nothing read the field —
    so a candidate went from two minutes of monologue straight into Part 3's
    abstract discussion, missing the beat an examiner uses to close the long
    turn. They are short by design ("Do you enjoy that?"), which is why one is
    enough: asking both would spend a minute of an interview that is already
    shorter than the real thing.

    Part 2 rather than part 3, because that is which part the examiner is still
    in when they ask it — and the part decides the pacing rules the turn is
    marked against (lib/speaking/turn-control.ts).
  */
  const roundingOff = card.followUp?.[0];
  if (roundingOff) steps.push({ part: 2, question: roundingOff });
  const part3 = data.part3.find((p) => p.topic === card.topic) ?? pick(data.part3);
  for (const q of part3.questions.slice(0, 4)) steps.push({ part: 3, question: q });
  return steps;
}

/**
 * The interview, on its own page or as the last module of a mock sitting.
 *
 * `exam` is what tells the two apart. On its own page the interview ends on a
 * band and a transcript, and records a speaking result; inside a sitting it
 * ends by handing the band back, because the sitting owns the result and shows
 * all four modules together. A null band means the interview happened and
 * could not be marked — the plan has no AI marking — and the sitting says so
 * rather than inventing a number.
 */
export default function SpeakingSession({
  exam,
}: {
  exam?: { onFinish: (band: number | null) => void };
} = {}) {
  /*
    Whether the interview gets marked, which is not the same as whether it can
    be taken. Standard unlocks the mock test — the examiner's questions, the
    clock, the recording, the transcript — and does not include the AI marking;
    Plus is where a band comes from.

    On this page that distinction matters more than anywhere else in the app. A
    speaking test is fourteen minutes of somebody talking into a microphone, and
    discovering at the end that there is no band would be the single worst
    moment BandUp could produce. So it is said on the intro card, before they
    start, and the interview ends on its transcript instead of on an error.

    Generous while the answer is unknown, like every other client-side gate
    here. The server refuses if it should — lib/billing/gate.ts.
  */
  const account = useTier();
  const marked =
    account.phase !== "ready" || !account.accountsEnabled || tierShows(account, "grade-speaking");

  const [stage, setStage] = useState<
    "intro" | "interview" | "grading" | "grade-error" | "result" | "unmarked"
  >("intro");
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState("");
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [examinerSpeaking, setExaminerSpeaking] = useState(false);
  const [answerWindowOpen, setAnswerWindowOpen] = useState(false);
  const [prepSeconds, setPrepSeconds] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [grade, setGrade] = useState<SpeakingGrade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  /*
    The microphone, held open for the whole interview.

    Opened once rather than per answer, for two reasons. A real sitting does not
    ask the candidate to press anything — the recorder runs, and this now works
    the same way. And the level meter has to be live between questions, because
    a microphone that is muted at the operating system is a fault a candidate
    must find before they talk for two minutes into nothing, not after.

    Separate from whatever the recogniser opens for itself: the Web Speech API
    manages its own microphone internally and hands out no stream, so there is
    nothing to share even when it is the one being used.
  */
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  const prefs = useSyncExternalStore(subscribeSpeechPrefs, speechPrefs, serverSpeechPrefs);
  /*
    Freeze the recogniser choice for a sitting. In particular, the one-tap
    recovery from an unavailable on-device model must take effect before the
    asynchronous `begin()` work continues; waiting for the external preference
    store to re-render could otherwise start a local recorder after the learner
    selected their device recogniser.
  */
  const [sessionEngine, setSessionEngine] = useState<SpeechPrefs["engine"] | null>(null);
  const [enginePreview, setEnginePreview] = useState<SpeechPrefs["engine"] | null>(null);
  const [localBlock, setLocalBlock] = useState<LocalBlocker | null>("server");
  const [modelCached, setModelCached] = useState(false);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [localSetupFailed, setLocalSetupFailed] = useState<"download" | "initializing" | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceProblem, setVoiceProblem] = useState(false);
  const mounted = useMounted();

  /*
    On the web the engine is not a choice, so it is not read as one either.

    The picker below is the app's, and hiding it alone would strand anyone who
    had already chosen Whisper on the web: the preference is stored per device,
    so it would survive with no control left to change it back, and every
    interview would keep waiting on a local transcription the reader could no
    longer turn off. Pinning the engine here means the stored value is simply
    not consulted outside the app, whatever it says.
  */
  const activeEngine = IS_MOBILE_BUILD ? (sessionEngine ?? prefs.engine) : "platform";
  const usingLocal = activeEngine === "local" && localBlock === null;
  /*
    Whether the introduction card has a second column at all. See the comment
    where it is used: the picker is app-only and appears only once the on-device
    plugin has answered, so the layout has to ask the same question the cell
    asks rather than assume the cell is there.
  */
  const showsEnginePicker = IS_MOBILE_BUILD && localBlock === null;
  /*
    Which cue card to build the interview around, when the question library sent
    somebody here to practise a particular one. Read once on mount rather than
    subscribed to: an interview is built when it starts, and a query string that
    changed halfway through would be describing an interview that is already
    under way.
  */
  const chosenCardId = useSearchParams().get("card");
  const micSupported =
    mounted && !micBlocked && (usingLocal || speechRecognitionSupported());

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRecordingRef = useRef(false);
  const answerRef = useRef("");
  const interimRef = useRef("");
  const sessionRef = useRef<LocalSession | null>(null);
  const answerStartedAtRef = useRef<number | null>(null);
  const lastVoiceAtRef = useRef<number | null>(null);
  const speechDetectedRef = useRef(false);
  const advancingRef = useRef(false);
  const promptGenerationRef = useRef(0);
  // How many times the examiner has nudged the turn in progress, and what it
  // said. Both belong to the turn, not the interview: nextQuestion reads
  // pendingNudgeTextRef once, to fold it into the transcript's question line,
  // then both reset for whatever question comes next.
  const nudgesUsedRef = useRef(0);
  const pendingNudgeTextRef = useRef("");
  const prepGenerationRef = useRef<number | null>(null);
  const answerWindowOpenRef = useRef(false);
  const beginningRef = useRef(false);
  const sessionEngineRef = useRef<SpeechPrefs["engine"] | null>(null);
  const examinerAudioRef = useRef<HTMLAudioElement | null>(null);
  const examinerAudioRunRef = useRef(0);
  const examinerAudioCreatedRef = useRef<HTMLAudioElement | null>(null);
  const [examinerAudioCurrentTime, setExaminerAudioCurrentTime] = useState(0);
  const [examinerAudioDuration, setExaminerAudioDuration] = useState(0);

  const updateAnswerWindow = useCallback((open: boolean) => {
    answerWindowOpenRef.current = open;
    setAnswerWindowOpen(open);
  }, []);

  // Whether the local recogniser can actually run here.
  useEffect(() => {
    let alive = true;
    void localAvailability().then((blocker) => {
      if (alive) setLocalBlock(blocker);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Whether the weights are already downloaded, so the intro can say so.
  useEffect(() => {
    if (prefs.engine !== "local") return;
    let alive = true;
    void isModelCached(prefs.model).then((cached) => {
      if (alive) setModelCached(cached);
    });
    return () => {
      alive = false;
    };
  }, [prefs.engine, prefs.model]);

  const updatePrefs = useCallback((next: SpeechPrefs) => {
    writeSpeechPrefs(next);
    setMicBlocked(false);
    setLocalSetupFailed(null);
    setError(null);
  }, []);

  const step = steps[stepIndex];
  const isNewPart = useMemo(
    () => !!step && (stepIndex === 0 || steps[stepIndex - 1].part !== step.part),
    [step, stepIndex, steps],
  );

  useEffect(() => {
    // Stop any speech or recognition still running when the user navigates away.
    return () => {
      promptGenerationRef.current += 1;
      nudgesUsedRef.current = 0;
      pendingNudgeTextRef.current = "";
      examinerAudioRunRef.current += 1;
      cancelSpeech();
      disposeNaturalExaminerVoice();
      const media = examinerAudioRef.current;
      if (media) {
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      examinerAudioCreatedRef.current?.remove();
      examinerAudioCreatedRef.current = null;
      examinerAudioRef.current = null;
      wantRecordingRef.current = false;
      recRef.current?.abort();
      sessionRef.current?.abort();
      sessionRef.current = null;
    };
  }, []);

  /*
    Open the microphone when the interview begins and hold it until it ends.
    Failure is not fatal: the meter simply has nothing to draw, and the
    recogniser reports the problem in its own words when it tries.
  */
  useEffect(() => {
    if (stage !== "interview" || !micSupported) return;
    let cancelled = false;
    let opened: MediaStream | null = null;

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        opened = s;
        setMicStream(s);
      })
      .catch(() => {
        if (!cancelled) setMicBlocked(true);
      });

    return () => {
      cancelled = true;
      opened?.getTracks().forEach((t) => t.stop());
      setMicStream(null);
    };
  }, [stage, micSupported]);

  // Elapsed-time ticker while the candidate is answering.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);



  /*
    Restarting the recogniser after the browser has stopped it, which is a
    routine event rather than a fault — and on Android is a routine event every
    few seconds.

    Chrome does not honour `continuous` there, so `onend` fires at the end of
    almost every phrase, and `no-speech` fires during an ordinary thinking
    pause. The old code called `rec.start()` synchronously inside `onend` and,
    if that threw, called `setRecording(false)` and stopped. It throws readily:
    the engine has not finished releasing the microphone at the moment it tells
    you it has stopped. So on Android the microphone died part-way through an
    answer, silently, with the candidate still talking and the screen still
    saying it was listening.

    A frame's delay lets the engine settle, and a budget replaces the silent
    give-up: a few failures in a row are what a real fault looks like, and then
    the candidate is told rather than left talking to nothing. Any successful
    restart clears the budget, so a long interview does not accumulate its way
    into a false alarm.
  */
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartFailuresRef = useRef(0);
  const RESTART_DELAY_MS = 120;
  const RESTART_BUDGET = 5;

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    wantRecordingRef.current = false;
    clearRestartTimer();
    restartFailuresRef.current = 0;
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // It may already have stopped after its last result.
      }
    }
    setRecording(false);
    setInterim("");
    interimRef.current = "";
  }, [clearRestartTimer]);

  /*
    `resume` is what a nudge asks for: capture is starting again, but the turn
    itself is not. Skipping the reset of answerStartedAtRef and
    speechDetectedRef there is what keeps the hard limit counting from when
    the turn truly began, and what keeps a candidate who had already spoken
    from looking freshly silent to decideTurnEnd the moment they pause again.
    lastVoiceAtRef still moves to now either way — the silence clock always
    restarts when capture does.
  */
  const beginAnswerClock = useCallback((resume = false) => {
    const now = performance.now();
    if (!resume) {
      answerStartedAtRef.current = now;
      speechDetectedRef.current = false;
    }
    lastVoiceAtRef.current = now;
  }, []);

  const startRecording = useCallback((expectedGeneration: number, resume = false) => {
    if (
      expectedGeneration !== promptGenerationRef.current ||
      !answerWindowOpenRef.current
    ) return;
    const rec = getSpeechRecognition();
    if (!rec) {
      setMicBlocked(true);
      return;
    }
    recRef.current = rec;
    wantRecordingRef.current = true;
    setRecording(true);
    // A resume continues the same on-screen answer clock a nudge interrupted;
    // only a genuinely new turn snaps the display back to 0:00.
    if (!resume) setElapsed(0);
    beginAnswerClock(resume);

    rec.onresult = (e: SpeechRecognitionEvent) => {
      if (
        recRef.current !== rec ||
        expectedGeneration !== promptGenerationRef.current ||
        !answerWindowOpenRef.current
      ) return;
      let finalChunk = "";
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalChunk += result[0].transcript;
        else pending += result[0].transcript;
      }
      if (finalChunk) {
        answerRef.current = (answerRef.current + " " + finalChunk).trim();
        setAnswer(answerRef.current);
      }
      interimRef.current = pending;
      setInterim(pending);
      if (finalChunk || pending) {
        speechDetectedRef.current = true;
        lastVoiceAtRef.current = performance.now();
      }
    };
    rec.onerror = (e) => {
      if (recRef.current !== rec || expectedGeneration !== promptGenerationRef.current) return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Microphone access was blocked. Allow it in your browser, or type your answer.");
        wantRecordingRef.current = false;
        setMicBlocked(true);
        setRecording(false);
      }
    };
    // Browsers stop recognition periodically; restart while we still want it.
    // Check identity too: a recognizer replaced by a newer one must not
    // resurrect itself and double-transcribe into the same answer.
    const stillWanted = () =>
      wantRecordingRef.current &&
      recRef.current === rec &&
      expectedGeneration === promptGenerationRef.current &&
      answerWindowOpenRef.current;

    const scheduleRestart = () => {
      if (!stillWanted()) return;
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        // Re-checked rather than assumed: 120ms is long enough for the turn to
        // have ended, the recogniser to have been replaced, or the candidate
        // to have pressed stop.
        if (!stillWanted()) return;
        try {
          rec.start();
          restartFailuresRef.current = 0;
        } catch {
          restartFailuresRef.current += 1;
          if (restartFailuresRef.current >= RESTART_BUDGET) {
            restartFailuresRef.current = 0;
            setError(
              "The microphone stopped listening. Press record to start it again, or type your answer.",
            );
            setRecording(false);
            return;
          }
          scheduleRestart();
        }
      }, RESTART_DELAY_MS);
    };

    rec.onend = scheduleRestart;
    try {
      rec.start();
      restartFailuresRef.current = 0;
    } catch {
      setRecording(false);
    }
  }, [beginAnswerClock, clearRestartTimer]);

  /*
    The local path is a different shape from the streaming one: it records the
    whole answer, then transcribes it. Nothing appears in the answer box while
    the candidate is talking, so the wait afterwards has to be visible — hence
    `localStatus`, which carries the download and transcription progress.
  */
  const startLocal = useCallback(async (expectedGeneration: number, resume = false) => {
    if (
      expectedGeneration !== promptGenerationRef.current ||
      !answerWindowOpenRef.current
    ) return;
    const session = createLocalSession(prefs.model, setLocalStatus);
    sessionRef.current = session;
    setError(null);
    try {
      await session.start();
      if (
        sessionRef.current !== session ||
        expectedGeneration !== promptGenerationRef.current ||
        !answerWindowOpenRef.current
      ) {
        session.abort();
        if (sessionRef.current === session) sessionRef.current = null;
        return;
      }
      setRecording(true);
      if (!resume) setElapsed(0);
      beginAnswerClock(resume);
    } catch {
      if (sessionRef.current !== session || expectedGeneration !== promptGenerationRef.current) {
        return;
      }
      sessionRef.current = null;
      setLocalStatus(null);
      setRecording(false);
      setMicBlocked(true);
      setError("Microphone access was blocked. Allow it in your settings, or type your answer.");
    }
  }, [prefs.model, beginAnswerClock]);

  /** Stop the local recorder, transcribe, and fold the text into the answer. */
  const finishLocal = useCallback(async (): Promise<string> => {
    const expectedGeneration = promptGenerationRef.current;
    const session = sessionRef.current;
    sessionRef.current = null;
    setRecording(false);
    if (!session) return answerRef.current.trim();
    setTranscribing(true);
    try {
      const text = await session.stop();
      if (expectedGeneration !== promptGenerationRef.current) return answerRef.current.trim();
      answerRef.current = mergeAnswer(answerRef.current, text);
      setAnswer(answerRef.current);
    } catch {
      if (expectedGeneration === promptGenerationRef.current) {
        setError(
          "The on-device recogniser couldn't transcribe that answer. Type it here, or switch to the device recogniser before the next question.",
        );
      }
    } finally {
      if (expectedGeneration === promptGenerationRef.current) {
        setTranscribing(false);
        setLocalStatus(null);
      }
    }
    return answerRef.current.trim();
  }, []);

  /** Finish the current answer whichever recogniser produced it. */
  const stopAnswer = useCallback(async (): Promise<string> => {
    if (sessionEngineRef.current === "local" && localBlock === null) return await finishLocal();
    const captured = (answerRef.current + " " + interimRef.current).trim();
    stopRecording();
    return captured;
  }, [localBlock, finishLocal, stopRecording]);

  /*
    Get the model before the test, not during it.

    It used to be started alongside the first question and not waited for, on
    the reasoning that the download would finish while the examiner was
    talking. When it worked, it did. When it failed, the candidate was already
    in the exam, one question in, being told the speech model could not be
    downloaded — with no way back and nothing to do about it. A setup problem
    had been turned into an exam problem.

    So it is now a gate. Returns whether it succeeded, and the caller does not
    begin the interview unless it did.
  */
  const warmUpLocal = useCallback(async (): Promise<boolean> => {
    setLocalSetupFailed(null);
    try {
      await prepareLocal(prefs.model, setLocalStatus);
      setModelCached(true);
      return true;
    } catch (error) {
      const downloadFailed = isLocalModelDownloadError(error);
      setLocalSetupFailed(downloadFailed ? "download" : "initializing");
      setError(
        downloadFailed
          ? "Couldn't download the speech model for on-device transcription. We also tried the BandUp fallback. Check your connection and try again, or switch to your device's recogniser above — that needs no download."
          : "The speech model downloaded, but this device couldn't start it. Retry setup, or switch to your device's recogniser above — that needs no model download.",
      );
      return false;
    } finally {
      setLocalStatus(null);
    }
  }, [prefs.model]);

  /*
    Open the answer window.

    There is no button to press, because there is none in the exam: the
    examiner stops talking and you answer. So this is called when the question
    has finished being read, and — for Part 2 — when the preparation minute
    runs out.

    Deliberately not an effect watching `examinerSpeaking`. Starting a
    recogniser is a response to an event, and an effect that starts one on a
    render has to be guarded against every re-render that is not that event.
    It is also the shape react-hooks/set-state-in-effect exists to catch.
  */
  const openAnswerWindow = useCallback((expectedGeneration: number, resume = false) => {
    if (expectedGeneration !== promptGenerationRef.current || answerWindowOpenRef.current) return;
    updateAnswerWindow(true);
    if (!micSupported || micBlocked) return;
    if (sessionEngineRef.current === "local" && localBlock === null) {
      void startLocal(expectedGeneration, resume);
    }
    else startRecording(expectedGeneration, resume);
  }, [micSupported, micBlocked, localBlock, startLocal, startRecording, updateAnswerWindow]);

  const continueAfterQuestion = useCallback((current: Step, promptGeneration: number) => {
    if (promptGeneration !== promptGenerationRef.current) return;
    if (current.part === 2) {
      updateAnswerWindow(false);
      prepGenerationRef.current = promptGeneration;
      setPrepSeconds(60);
      return;
    }
    prepGenerationRef.current = null;
    openAnswerWindow(promptGeneration);
  }, [openAnswerWindow, updateAnswerWindow]);

  /*
    One-minute preparation countdown for Part 2. The moment it ends is the
    moment the candidate should start talking, so the last tick opens the
    answer window itself — inside the timeout, which is an event, rather than
    from an effect watching the number reach zero.
  */
  useEffect(() => {
    if (prepSeconds <= 0) return;
    const last = prepSeconds === 1;
    const expectedGeneration = prepGenerationRef.current;
    const t = setTimeout(() => {
      setPrepSeconds((n) => Math.max(0, n - 1));
      if (last && expectedGeneration !== null) {
        prepGenerationRef.current = null;
        openAnswerWindow(expectedGeneration);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [prepSeconds, openAnswerWindow]);

  const ensureExaminerAudio = useCallback((): HTMLAudioElement | null => {
    if (examinerAudioRef.current) return examinerAudioRef.current;
    if (typeof document === "undefined") return null;

    /*
      The first question starts from the same click as Start interview. React
      has not necessarily committed the interview screen's declarative player
      at that point, so make a real HTMLMediaElement synchronously here. It is
      the same native media path as the visible host below, and is kept until
      unmount so Safari and embedded browsers retain the play permission.
    */
    const media = document.createElement("audio");
    media.preload = "none";
    media.hidden = true;
    media.setAttribute("aria-hidden", "true");
    media.setAttribute("data-examiner-native-audio", "true");
    document.body.appendChild(media);
    examinerAudioCreatedRef.current = media;
    examinerAudioRef.current = media;
    return media;
  }, []);

  const stopExaminerAudio = useCallback(() => {
    examinerAudioRunRef.current += 1;
    const media = examinerAudioRef.current;
    if (media) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    setExaminerAudioCurrentTime(0);
    setExaminerAudioDuration(0);
  }, []);

  /*
    Built-in examiner prompts are served as real MP3s from our strict,
    reviewed catalogue. Normal media playback works in environments that have
    neither SpeechSynthesis nor WebAudio. The device voice remains a recovery
    only when that media request itself fails, never the primary answer.
  */
  const playExaminerPrompt = useCallback(
    async (
      audioId: string | null,
      fallbackText: string,
      rate: number,
      expectedGeneration: number,
    ): Promise<boolean> => {
      const media = ensureExaminerAudio();
      if (!audioId || !media) {
        return expectedGeneration === promptGenerationRef.current
          ? speak(fallbackText, rate).catch(() => false)
          : false;
      }

      const run = ++examinerAudioRunRef.current;
      cancelSpeech();
      setExaminerAudioCurrentTime(0);
      setExaminerAudioDuration(0);

      return new Promise((resolve) => {
        let finished = false;
        let started = false;
        let fallingBack = false;
        const isCurrent = () =>
          run === examinerAudioRunRef.current && expectedGeneration === promptGenerationRef.current;
        const cleanUp = () => {
          media.removeEventListener("loadedmetadata", onMetadata);
          media.removeEventListener("playing", onPlaying);
          media.removeEventListener("timeupdate", onTimeUpdate);
          media.removeEventListener("ended", onEnded);
          media.removeEventListener("error", onError);
        };
        const finish = (played: boolean) => {
          if (finished) return;
          finished = true;
          cleanUp();
          resolve(played && isCurrent());
        };
        const fallbackToDeviceAudio = () => {
          if (finished || fallingBack) return;
          fallingBack = true;
          cleanUp();
          if (!isCurrent()) {
            finish(false);
            return;
          }
          media.pause();
          media.removeAttribute("src");
          media.load();
          void speak(fallbackText, rate)
            .then((played) => finish(played))
            .catch(() => finish(false));
        };
        const onMetadata = () => {
          if (!isCurrent()) return;
          const duration = media.duration;
          if (Number.isFinite(duration) && duration > 0) setExaminerAudioDuration(duration);
        };
        const onPlaying = () => {
          if (!isCurrent()) return;
          started = true;
        };
        const onTimeUpdate = () => {
          if (!isCurrent()) return;
          if (Number.isFinite(media.currentTime)) setExaminerAudioCurrentTime(media.currentTime);
          if (Number.isFinite(media.duration) && media.duration > 0) {
            setExaminerAudioDuration(media.duration);
          }
        };
        const onEnded = () => {
          if (!isCurrent()) return;
          if (Number.isFinite(media.duration)) setExaminerAudioCurrentTime(media.duration);
          finish(started);
        };
        const onError = () => fallbackToDeviceAudio();

        media.addEventListener("loadedmetadata", onMetadata);
        media.addEventListener("playing", onPlaying);
        media.addEventListener("timeupdate", onTimeUpdate);
        media.addEventListener("ended", onEnded);
        media.addEventListener("error", onError);
        try {
          media.pause();
          media.currentTime = 0;
          media.src = apiUrl(bundledExaminerAudioUrl(audioId));
          media.load();
          void media.play().catch(fallbackToDeviceAudio);
        } catch {
          fallbackToDeviceAudio();
        }
      });
    },
    [ensureExaminerAudio],
  );

  const askCurrent = useCallback(
    async (index: number, list: Step[]) => {
      const s = list[index];
      if (!s) return;
      const promptGeneration = ++promptGenerationRef.current;
      nudgesUsedRef.current = 0;
      pendingNudgeTextRef.current = "";
      prepGenerationRef.current = null;
      updateAnswerWindow(false);
      setVoiceProblem(false);
      setExaminerSpeaking(true);
      const prompt = examinerQuestion(list, index);
      const spoken = await playExaminerPrompt(
        examinerQuestionAudioId(list, index),
        prompt,
        0.95,
        promptGeneration,
      );
      if (promptGeneration !== promptGenerationRef.current) return;
      setExaminerSpeaking(false);
      if (!spoken) {
        setVoiceProblem(true);
        setError("The complete examiner question did not play. Play it again, or use the written question below.");
        return;
      }
      continueAfterQuestion(s, promptGeneration);
    },
    [continueAfterQuestion, playExaminerPrompt, updateAnswerWindow],
  );

  const repeatQuestion = useCallback(async () => {
    if (!step || examinerSpeaking) return;
    const promptGeneration = ++promptGenerationRef.current;
    nudgesUsedRef.current = 0;
    pendingNudgeTextRef.current = "";
    cancelSpeech();
    prepGenerationRef.current = null;
    setPrepSeconds(0);
    updateAnswerWindow(false);
    setError(null);
    setVoiceProblem(false);

    /* Replaying while an answer is open must pause capture first. Otherwise the
       examiner's own voice is transcribed as the candidate's answer. Keep any
       words already captured so replay is non-destructive. */
    if (recording || sessionRef.current) {
      const retainedAnswer = await stopAnswer();
      if (promptGeneration !== promptGenerationRef.current) return;
      answerRef.current = retainedAnswer;
      interimRef.current = "";
      setAnswer(retainedAnswer);
      setInterim("");
    }

    setExaminerSpeaking(true);
    const prompt = examinerQuestion(steps, stepIndex);
    const spoken = await playExaminerPrompt(
      examinerQuestionAudioId(steps, stepIndex),
      prompt,
      0.95,
      promptGeneration,
    );
    if (promptGeneration !== promptGenerationRef.current) return;
    setExaminerSpeaking(false);
    if (!spoken) {
      setVoiceProblem(true);
      setError("The complete question still did not play. Check this tab's sound permission and volume, then try again.");
      return;
    }
    continueAfterQuestion(step, promptGeneration);
  }, [continueAfterQuestion, examinerSpeaking, playExaminerPrompt, recording, step, stepIndex, steps, stopAnswer, updateAnswerWindow]);

  /** Leave the interview: silence the examiner and release the microphone. */
  const endTest = useCallback(() => {
    promptGenerationRef.current += 1;
    nudgesUsedRef.current = 0;
    pendingNudgeTextRef.current = "";
    prepGenerationRef.current = null;
    beginningRef.current = false;
    advancingRef.current = false;
    cancelSpeech();
    stopExaminerAudio();
    wantRecordingRef.current = false;
    recRef.current?.abort();
    recRef.current = null;
    sessionRef.current?.abort();
    sessionRef.current = null;
    sessionEngineRef.current = null;
    setSessionEngine(null);
    setLocalStatus(null);
    setTranscribing(false);
    setRecording(false);
    setExaminerSpeaking(false);
    updateAnswerWindow(false);
    setPrepSeconds(0);
    setInterim("");
    interimRef.current = "";
    setAnswer("");
    answerRef.current = "";
    setStage("intro");
  }, [stopExaminerAudio, updateAnswerWindow]);

  const begin = useCallback(async (forcePlatform = false) => {
    if (beginningRef.current) return;
    beginningRef.current = true;
    const chosenEngine: SpeechPrefs["engine"] =
      forcePlatform || localBlock !== null ? "platform" : prefs.engine;
    sessionEngineRef.current = chosenEngine;
    setSessionEngine(chosenEngine);
    promptGenerationRef.current += 1;
    nudgesUsedRef.current = 0;
    pendingNudgeTextRef.current = "";
    prepGenerationRef.current = null;
    advancingRef.current = false;
    const list = buildInterview(chosenCardId);
    setSteps(list);
    setStepIndex(0);
    setTranscript([]);
    setPrepSeconds(0);
    setAnswer("");
    setInterim("");
    setError(null);
    setLocalSetupFailed(null);
    setVoiceProblem(false);
    updateAnswerWindow(false);
    answerRef.current = "";
    const transcriptionReady = chosenEngine === "local" ? await warmUpLocal() : true;
    if (!transcriptionReady) {
      beginningRef.current = false;
      return;
    }
    setStage("interview");
    await askCurrent(0, list);
    beginningRef.current = false;
  }, [askCurrent, localBlock, prefs.engine, updateAnswerWindow, warmUpLocal]);

  const gradeInterview = useCallback(
    async (finalTranscript: Turn[]) => {
      setStage("grading");
      setError(null);
      try {
        /* postJSON carries the session token and the iOS API base — see lib/api.ts. */
        const payload = await postJSON<SpeakingGrade>("/api/grade/speaking", {
          transcript: finalTranscript,
        });
        setGrade(payload);
        setStage("result");
        if (exam) {
          /*
            The sitting records one result covering four modules, so recording a
            speaking result here as well would put the same interview in the
            history twice — once on its own and once inside the exam.
          */
          exam.onFinish(payload.overallBand);
          return;
        }
        addResult({
          module: "speaking",
          testId: "mock-speaking",
          testTitle: "Mock speaking interview",
          band: payload.overallBand,
          date: new Date().toISOString(),
          review: {
            kind: "speaking",
            transcript: finalTranscript,
            grade: payload,
          },
        });
      } catch (err) {
        if (exam) {
          /*
            A provider outage must not trap a three-hour mock on its final
            button. The results page is explicitly able to report an unmarked
            module and withhold the overall band, which is the honest recovery.
            Standalone speaking keeps its retryable error below.
          */
          setStage("unmarked");
          exam.onFinish(null);
          return;
        }
        setError(err instanceof Error ? err.message : "Grading failed.");
        setStage("grade-error");
      }
    },
    [exam],
  );

  const nextQuestion = useCallback(async (reason: TurnEndReason = "natural-pause") => {
    if (!step || !answerWindowOpen || advancingRef.current) return;
    advancingRef.current = true;
    const promptGeneration = ++promptGenerationRef.current;
    // Read before resetting: this turn's nudge, if any, belongs on the
    // transcript line the code below is about to write for the question that
    // is ending, not on whatever comes next.
    const nudgeSpoken = pendingNudgeTextRef.current;
    nudgesUsedRef.current = 0;
    pendingNudgeTextRef.current = "";
    prepGenerationRef.current = null;
    updateAnswerWindow(false);
    const nextIndex = stepIndex + 1;
    const finalQuestion = nextIndex >= steps.length;

    try {
      /* Stop capture before the examiner speaks so its voice never lands in the
         candidate's answer. Local transcription and the short transition can
         then run together, avoiding a long robotic silence. */
      const spokenPromise = stopAnswer().then((spoken) => {
        if (promptGeneration === promptGenerationRef.current) {
          answerRef.current = "";
          interimRef.current = "";
          setAnswer("");
          setInterim("");
          setPrepSeconds(0);
          setElapsed(0);
          answerStartedAtRef.current = null;
        }
        return spoken;
      });
      if (!finalQuestion) setStepIndex(nextIndex);
      setVoiceProblem(false);
      setExaminerSpeaking(true);
      const prompt = examinerFollowUp(steps, stepIndex, reason);
      const promptPromise = playExaminerPrompt(
        examinerFollowUpAudioId(steps, stepIndex, reason),
        prompt,
        0.96,
        promptGeneration,
      );
      const [spoken, promptPlayed] = await Promise.all([spokenPromise, promptPromise]);
      if (promptGeneration !== promptGenerationRef.current) return;
      setExaminerSpeaking(false);
      if (!promptPlayed) {
        setVoiceProblem(true);
        setError("The complete examiner question did not play. Play it again, or use the written question below.");
      }

      const updated: Turn[] = [
        ...transcript,
        {
          role: "examiner",
          part: step.part,
          // A nudge and the question it followed are one examiner turn — the
          // same thing a transcript of a real interview would show for
          // "Where do you live?" ... "Manchester." ... "Why is that?".
          text: nudgeSpoken ? `${step.question} ${nudgeSpoken}` : step.question,
        },
        { role: "candidate", part: step.part, text: spoken || "(no answer given)" },
      ];
      setTranscript(updated);

      if (finalQuestion) {
        /*
          No marking on this plan, so no request. Calling the route anyway would
          spend fourteen minutes of somebody's afternoon and answer 402, and the
          transcript — which is the part that costs nothing and is genuinely
          useful — would be behind an error message.
        */
        if (!marked) {
          setStage("unmarked");
          exam?.onFinish(null);
          return;
        }
        await gradeInterview(updated);
        return;
      }
      if (!promptPlayed) return;
      const nextStep = steps[nextIndex];
      if (nextStep) continueAfterQuestion(nextStep, promptGeneration);
    } finally {
      if (promptGeneration === promptGenerationRef.current) setExaminerSpeaking(false);
      if (promptGeneration === promptGenerationRef.current) advancingRef.current = false;
    }
  }, [
    step,
    answerWindowOpen,
    stepIndex,
    steps,
    transcript,
    stopAnswer,
    gradeInterview,
    marked,
    exam,
    continueAfterQuestion,
    playExaminerPrompt,
    updateAnswerWindow,
  ]);

  const readMicrophoneLevel = useCallback(
    (rms: number) => {
      if (!recording || examinerSpeaking || prepSeconds > 0 || rms < 0.009) return;
      speechDetectedRef.current = true;
      lastVoiceAtRef.current = performance.now();
    },
    [recording, examinerSpeaking, prepSeconds],
  );

  /*
    A short spoken interruption when the turn has gone quiet — before the
    part's answer is long enough to count as developed, or before it has
    started at all. Unlike nextQuestion, this does not move the interview on:
    promptGenerationRef is left untouched, because the turn has not ended,
    only paused, and the words already given are captured into answerRef
    rather than cleared, so what the candidate says next lands on the same
    answer. One turn, one question, one merged answer — what a real
    examiner's "Why is that?" produces, and it needs no change to how the
    transcript or the grading route reads a turn.
  */
  const askNudge = useCallback(
    async (kind: NudgeKind) => {
      if (!step || !answerWindowOpen || advancingRef.current || nudgesUsedRef.current > 0) return;
      advancingRef.current = true;
      const promptGeneration = promptGenerationRef.current;

      try {
        setExaminerSpeaking(true);
        updateAnswerWindow(false);
        const captured = await stopAnswer();
        if (promptGeneration !== promptGenerationRef.current) return;
        answerRef.current = captured;
        setAnswer(captured);
        interimRef.current = "";
        setInterim("");

        const nudgeText = examinerNudge(step.part, stepIndex, kind);
        const spoken = await playExaminerPrompt(
          // A nudge belongs to a part rather than to a question, so it resolves
          // on its own id rather than through the bridge catalogue. A miss
          // still routes to the device voice, the same recovery every other
          // prompt already has, so this line is never mute.
          examinerNudgeAudioId(step.part, stepIndex, kind),
          nudgeText,
          0.96,
          promptGeneration,
        );
        if (promptGeneration !== promptGenerationRef.current) return;
        setExaminerSpeaking(false);

        nudgesUsedRef.current += 1;
        pendingNudgeTextRef.current = nudgeText;
        // resume=true: same turn, so the answer clock and speech-detected
        // flag ride through untouched — only the silence clock restarts.
        openAnswerWindow(promptGeneration, true);
        if (!spoken) setVoiceProblem(true);
      } finally {
        if (promptGeneration === promptGenerationRef.current) {
          setExaminerSpeaking(false);
          advancingRef.current = false;
        }
      }
    },
    [step, stepIndex, answerWindowOpen, stopAnswer, playExaminerPrompt, openAnswerWindow, updateAnswerWindow],
  );

  /*
    A quarter-second control loop makes the examiner responsive without asking
    React to re-render for every microphone sample. It never ends a normal turn
    in active speech: sufficient language must be followed by a natural pause.
    The hard limit is the deliberate IELTS-style interruption.
  */
  useEffect(() => {
    if (!recording || !step || examinerSpeaking || prepSeconds > 0) return;

    const timer = window.setInterval(() => {
      const startedAt = answerStartedAtRef.current;
      const lastVoiceAt = lastVoiceAtRef.current;
      if (startedAt === null || lastVoiceAt === null || advancingRef.current) return;
      const now = performance.now();
      const evidence = {
        part: step.part,
        elapsedSeconds: (now - startedAt) / 1_000,
        wordCount: countSpokenWords(`${answerRef.current} ${interimRef.current}`),
        speechDetected: speechDetectedRef.current,
        silenceMilliseconds: now - lastVoiceAt,
        liveTranscript: !usingLocal,
        nudgesUsed: nudgesUsedRef.current,
      };
      const decision = decideTurnEnd(evidence);
      if (decision) {
        void nextQuestion(decision);
        return;
      }
      const nudge = decideNudge(evidence);
      if (nudge) void askNudge(nudge);
    }, 250);

    return () => window.clearInterval(timer);
  }, [recording, step, examinerSpeaking, prepSeconds, usingLocal, nextQuestion, askNudge]);

  // ---------- Screens ----------

  if (stage === "intro") {
    return (
      /*
        What the test is on one side, how it hears you on the other. Stacked
        and centred, this screen ran past the fold before the start button —
        on the page whose entire job is to get someone talking.
      */
      <div className="mx-auto max-w-3xl">
        {/*
          Two columns only when there is a second column.

          The right-hand cell is the speech-engine picker, and it renders only
          inside the app and only once the on-device plugin has answered — so
          on the website it never rendered at all and the card kept a permanently
          empty half beside the introduction. On a wide screen that was most of
          a metre of nothing, which is what the owner saw.

          The condition is computed once and used twice, rather than the grid
          guessing: a layout that assumes a child exists and a child that
          decides for itself whether to exist have to be told the same thing.
        */}
        <div className={`card !p-4 grid gap-4 ${showsEnginePicker ? "sm:grid-cols-2" : ""}`}>
          <div className="min-w-0">
            {!exam && <AssignedPracticeNotice className="mb-3" />}
            <div className="flex items-center gap-2.5">
              <SpeakingIcon className="h-7 w-7 shrink-0 text-indigo-600" />
              <h1 className="text-xl font-semibold text-slate-900">Mock speaking test</h1>
            </div>
            <p className="mt-1.5 text-sm leading-6 text-slate-600">
              {marked
                ? "An AI examiner asks you questions out loud. You answer out loud. At the end you get a band and feedback on the four things the real exam marks you on."
                : "An examiner asks you questions out loud and you answer out loud, in exam order and against the exam clock. At the end you get your full transcript. AI marking is on Plus."}
            </p>
            <ol className="mt-2 space-y-1.5 text-sm leading-6 text-slate-600">
              <li className="flex gap-2.5">
                <span className="font-semibold text-indigo-600">1</span> Short questions about you
                (about 4 minutes)
              </li>
              <li className="flex gap-2.5">
                <span className="font-semibold text-indigo-600">2</span> A topic card — 1 minute to
                prepare, then talk for 2 minutes
              </li>
              <li className="flex gap-2.5">
                <span className="font-semibold text-indigo-600">3</span> A discussion of bigger
                ideas around that topic
              </li>
            </ol>
            {!micSupported && (
              <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                Your browser can&apos;t record speech. You can still take the test by typing your
                answers — or switch to Chrome, Edge or Safari to speak them.
              </p>
            )}
            {/* Disabled while the model comes down, and says so — the progress
                card below it is already showing how far along it is. */}
            <button
              className="btn-primary mt-3 w-full"
              onClick={() => void begin()}
              disabled={localStatus !== null}
            >
              {localStatus !== null
                ? <LoadingIndicator label="Getting ready…" announce={false} />
                : "Start the interview"}
            </button>
            {localStatus && (
              <div className="mt-3 rounded-2xl bg-indigo-50 px-4 py-3 text-left" aria-live="polite">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-indigo-800">
                  <LoadingIndicator label={describeStatus(localStatus)} announce={false} />
                  {localStatus.phase === "downloading" && (
                    <span className="text-xs text-indigo-700">once only</span>
                  )}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-100">
                  <div
                    className={`h-full rounded-full bg-indigo-500 transition-all duration-300 ${
                      localStatus.percent === null ? "animate-pulse" : ""
                    }`}
                    style={{ width: `${localStatus.percent ?? 100}%` }}
                  />
                </div>
                <p className="mt-2 text-xs leading-5 text-indigo-700">
                  This is happening on your device \u2014 no audio is being uploaded.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-left text-sm leading-6 text-rose-900">
                {error}
              </p>
            )}
            {localSetupFailed && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void begin()}
                >
                  {localSetupFailed === "download" ? "Retry the download" : "Retry setup"}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    updatePrefs({ ...prefs, engine: "platform" });
                    void begin(true);
                  }}
                >
                  Use my device recogniser
                </button>
              </div>
            )}
            <p className="mt-2 text-xs leading-5 text-slate-400">
              BandUp plays reviewed examiner audio for this interview. If a recording cannot be
              reached, it falls back to your device voice when one is available. {" "}
              {usingLocal
                ? "Your voice is transcribed on this device and never uploaded. Only the text transcript is sent for marking."
                : "Your voice is transcribed by your device's own recogniser, which may send the audio to its maker. Only the text transcript is sent for marking."}{" "}
              <Link href="/privacy" className="underline hover:text-slate-600">
                What that means
              </Link>
            </p>
          </div>
          {/*
            The app only, and only when the app can actually keep the promise.

            On the web this asks a question the reader has no reason to answer:
            the browser's own recogniser is the only path that works the way
            the interview needs — words appearing as they are spoken — and the
            Whisper option's whole argument is that the audio never leaves the
            device, which is a promise about an app rather than about a tab.

            Inside the app it is a real choice only once there is something to
            choose. The on-device model is a native plugin that has to be
            compiled into the build, and until it is, localAvailability()
            answers "no-plugin" — so offering the option would be offering a
            switch whose only reply is that this version cannot do it. That is
            an unfinished feature on screen, which is its own reason not to
            ship it and also the thing App Review calls incompleteness. Waiting
            for that answer costs one render: localBlock starts non-null, so
            the picker appears when the plugin does and never before, and the
            interview quietly uses the device recogniser in the meantime.
          */}
          {showsEnginePicker && (
          <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-left">
            <p className="text-sm font-semibold text-slate-800">How your speech becomes text</p>
            <div
              className="speaking-engine-picker relative mt-2 grid grid-rows-2 gap-2"
              role="radiogroup"
              aria-label="How your speech becomes text"
              onPointerLeave={() => setEnginePreview(null)}
              style={
                {
                  "--engine-index": (enginePreview ?? prefs.engine) === "local" ? 1 : 0,
                } as CSSProperties
              }
            >
              <span className="speaking-engine-selector" aria-hidden="true" />
              <EngineOption
                checked={prefs.engine === "platform"}
                onSelect={() => updatePrefs({ ...prefs, engine: "platform" })}
                onPreview={() => setEnginePreview("platform")}
                onPreviewEnd={() => setEnginePreview(null)}
                title="Your device's recogniser"
                blurb="Writes the words as you say them. Chrome, and some phones, do that by sending the audio to their maker."
              />
              <EngineOption
                checked={prefs.engine === "local"}
                onSelect={() => updatePrefs({ ...prefs, engine: "local" })}
                onPreview={() => setEnginePreview("local")}
                onPreviewEnd={() => setEnginePreview(null)}
                title="On this device only"
                blurb="Whisper runs inside the app, so the audio never leaves. It transcribes after you stop speaking rather than as you go."
              />
            </div>

            {prefs.engine === "local" && localBlock === null && (
              <div className="mt-2 border-t border-slate-200 pt-2">
                <p className="text-xs font-medium text-slate-600">Model</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {(Object.keys(LOCAL_MODELS) as LocalModelId[]).map((id) => (
                    <button
                      key={id}
                      onClick={() => updatePrefs({ ...prefs, model: id })}
                      className={`rounded-xl border px-3 py-2 text-left text-xs leading-5 ${
                        prefs.model === id
                          ? "border-indigo-500 bg-indigo-50 text-indigo-800"
                          : "border-slate-200 bg-surface text-slate-600"
                      }`}
                    >
                      <span className="block font-semibold">
                        {LOCAL_MODELS[id].label} · {formatBytes(LOCAL_MODELS[id].bytes)}
                      </span>
                      <span className="block max-w-[15rem]">{LOCAL_MODELS[id].note}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-slate-500">
                  {modelCached
                    ? "Already downloaded to this device."
                    : "Downloaded once, then kept for next time. It needs a connection the first time only."}{" "}
                  {modelCached && (
                    <button
                      className="underline hover:text-slate-700"
                      onClick={() => {
                        void deleteCachedModels().then(() => setModelCached(false));
                      }}
                    >
                      Delete it
                    </button>
                  )}
                </p>
              </div>
            )}
          </div>
          )}
        </div>
      </div>
    );
  }

  /*
    The end of an interview that this plan does not have marking for.

    It is a real ending rather than an apology: the transcript is here, it is the
    thing a learner can actually work from without a model, and it is presented
    first. The upgrade sits under it, once, without a countdown or a nag.
  */
  if (stage === "unmarked") {
    return (
      <div className="space-y-3">
        <div className="card !p-4">
          <h1 className="text-xl font-semibold text-slate-900">Interview complete</h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {marked
              ? "You answered every question, in exam order and against the clock. Here is everything you said. Marking could not be completed just now, but you can retry without repeating the interview."
              : "You answered every question, in exam order and against the clock. Here is everything you said. AI marking — a band for each criterion, and what to fix first — is part of Plus."}
          </p>
        </div>

        <div className="card !p-4">
          <h2 className="text-sm font-semibold text-slate-900">Your transcript</h2>
          <div className="mt-3 max-h-[24rem] space-y-2 overflow-y-auto">
            {transcript.map((t, i) => (
              <p key={i} className="text-sm leading-6">
                <span
                  className={
                    t.role === "examiner"
                      ? "font-semibold text-slate-500"
                      : "font-semibold text-indigo-700"
                  }
                >
                  {t.role === "examiner" ? "Examiner" : "You"}:
                </span>{" "}
                <span className="text-slate-700">{t.text}</span>
              </p>
            ))}
          </div>
        </div>

        {!marked && <UpgradePanel feature="have this marked" signedIn={account.signedIn} tier="plus" />}

        <div className="flex flex-wrap gap-2">
          {marked && (
            <button className="btn-primary" onClick={() => void gradeInterview(transcript)}>
              Retry marking
            </button>
          )}
          <button className={marked ? "btn-secondary" : "btn-primary"} onClick={() => setStage("intro")}>
            Take another interview
          </button>
          <Link href="/plan" className="btn-secondary">
            Back to my plan
          </Link>
        </div>
      </div>
    );
  }

  if (stage === "grading") {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-3 py-12 text-center">
          <p className="text-[0.9375rem] text-slate-700"><LoadingIndicator label="The examiner is marking your interview…" iconClassName="text-2xl text-indigo-600" /></p>
          <p className="text-sm text-slate-500">This usually takes under a minute.</p>
        </div>
      </div>
    );
  }

  if (stage === "grade-error") {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <div className="card !p-4">
          <h1 className="text-xl font-semibold text-slate-900">Your interview is safely recorded</h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            BandUp could not mark it just now. Your transcript is still here, so retrying will not
            make you repeat the speaking test.
          </p>
          {error && <p className="mt-2 text-sm leading-6 text-rose-600">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => void gradeInterview(transcript)}>
              Retry marking
            </button>
            <button className="btn-secondary" onClick={() => setStage("unmarked")}>
              View my transcript
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "result" && grade) {
    return (
      <div className="space-y-3">
        <div className="card !p-4 flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
          <BandBadge band={grade.overallBand} caption="Your speaking band" />
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Interview complete</h1>
            <p className="text-sm leading-6 text-slate-600">
              Here&apos;s how each criterion scored, what you did well, and what to fix first.
            </p>
          </div>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {grade.criteria.map((c) => (
            <div key={c.name} className="card !p-3 min-w-0">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">{c.name}</h3>
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                  {c.band}
                </span>
              </div>
              <ExplainText
                text={c.comment}
                className="mt-1 block text-xs leading-5 text-slate-600"
              />
            </div>
          ))}
        </div>

        <div className="grid gap-2.5 lg:grid-cols-3">
          <div className="card !p-4 min-w-0">
            <h3 className="mb-1.5 text-sm font-semibold text-emerald-700">What you did well</h3>
            <ul className="space-y-1.5 text-sm leading-6 text-slate-700">
              {grade.strengths.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-emerald-600">✓</span>
                  <ExplainText text={s} />
                </li>
              ))}
            </ul>
          </div>
          <div className="card !p-4 min-w-0">
            <h3 className="mb-1.5 text-sm font-semibold text-indigo-700">Fix these first</h3>
            <ol className="space-y-1.5 text-sm leading-6 text-slate-700">
              {grade.improvements.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-semibold text-indigo-600">{i + 1}</span>
                  <ExplainText text={s} />
                </li>
              ))}
            </ol>
          </div>

          <div className="card !p-4 min-w-0">
            <h3 className="mb-1.5 text-sm font-semibold text-slate-900">
              One of your answers, at band 8
            </h3>
            <ExplainText
              text={grade.betterAnswerExample}
              className="block text-sm leading-6 text-slate-700"
            />
            <ExplainText
              text={grade.pronunciationNote}
              className="mt-2 block rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500"
            />
          </div>
        </div>

        <details className="card !p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">
            Read the full transcript
          </summary>
          <div className="mt-3 max-h-[20rem] space-y-2 overflow-y-auto">
            {transcript.map((t, i) => (
              <p key={i} className="text-sm leading-6">
                <span
                  className={
                    t.role === "examiner"
                      ? "font-semibold text-slate-500"
                      : "font-semibold text-indigo-700"
                  }
                >
                  {t.role === "examiner" ? "Examiner" : "You"}:
                </span>{" "}
                <span className="text-slate-700">{t.text}</span>
              </p>
            ))}
          </div>
        </details>

        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary"
            onClick={() => {
              setGrade(null);
              setStage("intro");
            }}
          >
            Take another interview
          </button>
          <Link href="/plan" className="btn-secondary">
            Back to my plan
          </Link>
        </div>
      </div>
    );
  }

  // ---------- Interview ----------
  const totalSteps = steps.length;
  const preparing = prepSeconds > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      {/* The real player is created synchronously from Start when necessary,
          so first-question autoplay survives React's screen transition. This
          declarative host makes the native media affordance explicit in the
          interview DOM as well. */}
      <audio data-examiner-native-audio preload="none" aria-hidden="true" hidden />
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          Part {step?.part} · question {stepIndex + 1} of {totalSteps}
        </span>
        <button className="text-slate-400 hover:text-slate-700" onClick={endTest}>
          End test
        </button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all duration-500"
          style={{ width: `${((stepIndex + 1) / Math.max(1, totalSteps)) * 100}%` }}
        />
      </div>

      {examinerSpeaking && examinerAudioDuration > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-500" aria-live="polite">
          <progress
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full accent-indigo-600"
            max={examinerAudioDuration}
            value={Math.min(examinerAudioCurrentTime, examinerAudioDuration)}
            aria-label="Examiner audio progress"
          />
          <span>{Math.floor(examinerAudioCurrentTime)} / {Math.ceil(examinerAudioDuration)}s</span>
        </div>
      )}

      {isNewPart && (
        <p className="rounded-2xl bg-indigo-50 px-4 py-2 text-sm leading-6 text-indigo-800">
          {SPEAKING_PART_INTRO[step.part]}
        </p>
      )}

      <div className="card !p-4">
        <div className="mb-1 flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
          <span>
            Examiner {examinerSpeaking && (
              <LoadingIndicator
                label="speaking…"
                announce={false}
              />
            )}
          </span>
          <button
            type="button"
            className="normal-case tracking-normal text-indigo-700 underline decoration-indigo-300 underline-offset-2 disabled:cursor-wait disabled:text-slate-400 disabled:no-underline"
            onClick={() => void repeatQuestion()}
            disabled={examinerSpeaking}
          >
            {examinerSpeaking ? <LoadingIndicator label="Playing…" announce={false} /> : "Replay question"}
          </button>
        </div>
        <p className="text-[1.0625rem] leading-7 text-slate-900">{step?.question}</p>

        {voiceProblem && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void repeatQuestion()}
              disabled={examinerSpeaking}
            >
              {examinerSpeaking ? <LoadingIndicator label="Playing…" announce={false} /> : "Play question again"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setVoiceProblem(false);
                setError(null);
                if (step) continueAfterQuestion(step, promptGenerationRef.current);
              }}
            >
              Use written question
            </button>
          </div>
        )}

        {step?.cueCard && (
          <div className="mt-2.5 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <p className="mb-1 text-sm font-medium text-slate-700">You should say:</p>
            <ul className="space-y-1 text-sm leading-6 text-slate-700">
              {step.cueCard.bullets.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-slate-400">•</span>
                  {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        {preparing && (
          <div className="mt-2.5 flex items-center justify-between rounded-2xl bg-indigo-50 px-4 py-2 text-sm text-indigo-800">
            <span>Preparation time — make notes, don&apos;t speak yet.</span>
            <span className="font-mono text-base font-semibold">{prepSeconds}s</span>
          </div>
        )}
      </div>

      {/*
        No button. The recorder runs from the moment the question has been
        read, which is what a real sitting does — nobody presses anything, they
        just answer. What replaces it is a meter showing the microphone is
        genuinely hearing them, which is the reassurance the button was
        standing in for and never actually gave.
      */}
      <div className="card !p-4 flex flex-col items-center gap-2 text-center">
        {micSupported ? (
          <>
            <VolumeMeter
              stream={micStream}
              muted={examinerSpeaking || preparing}
              onLevel={readMicrophoneLevel}
            />
            <p className="text-sm text-slate-600">
              {examinerSpeaking
                ? "Listen to the question\u2026"
                : preparing
                  ? "Make notes \u2014 you will start speaking when the minute is up"
                  : transcribing
                    ? <LoadingIndicator label="Working out what you said…" />
                    : recording
                      ? `Answering \u2014 ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}${
                          step?.part === 2 ? " (aim for 1\u20132 minutes)" : ""
                        } · the examiner will move on at a natural pause`
                      : answerWindowOpen
                        ? "Speak your answer out loud"
                        : voiceProblem
                          ? "Play the question again, or use the written question"
                          : "Wait for the examiner's question"}
            </p>
          </>
        ) : null}

        {/* The local recogniser has nothing to show until it is finished, so it
            shows what it is doing instead of leaving a silent pause. */}
        {localStatus && (
          <div
            className="w-full rounded-2xl bg-indigo-50 px-4 py-3 text-left"
            aria-live="polite"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-indigo-800">
              <LoadingIndicator label={describeStatus(localStatus)} announce={false} />
              {localStatus.phase === "downloading" && (
                <span className="text-xs text-indigo-700">once only</span>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-100">
              <div
                className={`h-full rounded-full bg-indigo-500 transition-all duration-300 ${
                  localStatus.percent === null ? "animate-pulse" : ""
                }`}
                style={{ width: `${localStatus.percent ?? 100}%` }}
              />
            </div>
            <p className="mt-2 text-xs leading-5 text-indigo-700">
              This is happening on your device — no audio is being uploaded.
            </p>
          </div>
        )}

        <textarea
          className="input h-24 w-full resize-y text-left leading-7"
          placeholder={
            !answerWindowOpen
              ? voiceProblem
                ? "Choose Play question again or Use written question above."
                : "Your answer opens after the examiner finishes the question."
              : !micSupported
              ? "Type your answer here."
              : usingLocal
                ? "Speak, then stop — your words land here. You can also type or correct them."
                : "Your speech appears here — you can also type or correct it."
          }
          value={answer + (interim ? " " + interim : "")}
          disabled={!answerWindowOpen || examinerSpeaking || preparing || transcribing}
          onChange={(e) => {
            answerRef.current = e.target.value;
            interimRef.current = "";
            setAnswer(e.target.value);
            setInterim("");
          }}
        />

        <button
          className="btn-primary w-full sm:w-auto"
          onClick={() => void nextQuestion()}
          disabled={!answerWindowOpen || examinerSpeaking || transcribing}
        >
          {transcribing
            ? <LoadingIndicator label="Transcribing…" announce={false} />
            : stepIndex + 1 >= totalSteps
              ? "Finish and get my band score"
              : "Move on now"}
        </button>
        {error && <p className="text-sm leading-6 text-rose-600">{error}</p>}
      </div>
    </div>
  );
}

/** One of the two ways to turn speech into text, as a radio row. */
function EngineOption({
  checked,
  onSelect,
  onPreview,
  onPreviewEnd,
  title,
  blurb,
}: {
  checked: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onPreviewEnd: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      onPointerEnter={onPreview}
      onFocus={onPreview}
      onBlur={onPreviewEnd}
      className="speaking-engine-option relative z-10 flex min-h-0 cursor-pointer items-center rounded-2xl border border-transparent p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs leading-5 text-slate-600">{blurb}</span>
      </span>
    </button>
  );
}
