"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import BandBadge from "@/components/BandBadge";
import ExplainText from "@/components/ExplainText";
import SkillGate from "@/components/SkillGate";
import UpgradePanel from "@/components/billing/UpgradePanel";
import { tierShows, useTier } from "@/lib/billing/useTier";
import VolumeMeter from "@/components/speaking/VolumeMeter";
import { postJSON } from "@/lib/api";
import speakingData from "@/data/speaking-topics.json";
import { useMounted } from "@/lib/hooks";
import {
  cancelSpeech,
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
  blockerMessage,
  createLocalSession,
  deleteCachedModels,
  describeStatus,
  formatBytes,
  isModelCached,
  localAvailability,
  mergeAnswer,
  prepareLocal,
  type LocalBlocker,
  type LocalModelId,
  type LocalSession,
  type LocalStatus,
} from "@/lib/transcribe";
import type { SpeakingCueCard, SpeakingGrade, SpeakingTopicsData } from "@/lib/types";
import { SpeakingIcon } from "@/components/Icons";

const data = speakingData as SpeakingTopicsData;

interface Turn {
  role: "examiner" | "candidate";
  part: 1 | 2 | 3;
  text: string;
}

interface Step {
  part: 1 | 2 | 3;
  question: string;
  cueCard?: SpeakingCueCard;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Build a shortened but structurally faithful mock interview. */
function buildInterview(): Step[] {
  const steps: Step[] = [];
  const topics = [...data.part1].sort(() => Math.random() - 0.5).slice(0, 2);
  for (const t of topics) {
    for (const q of t.questions.slice(0, 3)) steps.push({ part: 1, question: q });
  }
  const card = pick(data.part2);
  steps.push({ part: 2, question: card.cueCard, cueCard: card });
  const part3 = data.part3.find((p) => p.topic === card.topic) ?? pick(data.part3);
  for (const q of part3.questions.slice(0, 4)) steps.push({ part: 3, question: q });
  return steps;
}

const PART_INTRO: Record<1 | 2 | 3, string> = {
  1: "Part 1. I'd like to ask you some questions about yourself.",
  2: "Part 2. I'm going to give you a topic card. You have one minute to prepare, then talk for one to two minutes.",
  3: "Part 3. We'll discuss some more general questions related to that topic.",
};

function SpeakingSession() {
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

  const [stage, setStage] = useState<"intro" | "interview" | "grading" | "result" | "unmarked">(
    "intro",
  );
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState("");
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [examinerSpeaking, setExaminerSpeaking] = useState(false);
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
  const [localBlock, setLocalBlock] = useState<LocalBlocker | null>("server");
  const [modelCached, setModelCached] = useState(false);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const mounted = useMounted();

  const usingLocal = prefs.engine === "local" && localBlock === null;
  const micSupported =
    mounted && !micBlocked && (usingLocal || speechRecognitionSupported());

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRecordingRef = useRef(false);
  const answerRef = useRef("");
  const sessionRef = useRef<LocalSession | null>(null);

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
      cancelSpeech();
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



  const stopRecording = useCallback(() => {
    wantRecordingRef.current = false;
    recRef.current?.stop();
    setRecording(false);
    setInterim("");
  }, []);

  const startRecording = useCallback(() => {
    const rec = getSpeechRecognition();
    if (!rec) {
      setMicBlocked(true);
      return;
    }
    recRef.current = rec;
    wantRecordingRef.current = true;
    setRecording(true);
    setElapsed(0);

    rec.onresult = (e: SpeechRecognitionEvent) => {
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
      setInterim(pending);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Microphone access was blocked. Allow it in your browser, or type your answer.");
        wantRecordingRef.current = false;
        setMicBlocked(true);
        setRecording(false);
      }
    };
    rec.onend = () => {
      // Browsers stop recognition periodically; restart while we still want it.
      // Check identity too: a recognizer replaced by a newer one must not
      // resurrect itself and double-transcribe into the same answer.
      if (wantRecordingRef.current && recRef.current === rec) {
        try {
          rec.start();
        } catch {
          setRecording(false);
        }
      }
    };
    try {
      rec.start();
    } catch {
      setRecording(false);
    }
  }, []);

  /*
    The local path is a different shape from the streaming one: it records the
    whole answer, then transcribes it. Nothing appears in the answer box while
    the candidate is talking, so the wait afterwards has to be visible — hence
    `localStatus`, which carries the download and transcription progress.
  */
  const startLocal = useCallback(async () => {
    const session = createLocalSession(prefs.model, setLocalStatus);
    sessionRef.current = session;
    setError(null);
    try {
      await session.start();
      setRecording(true);
      setElapsed(0);
    } catch {
      sessionRef.current = null;
      setLocalStatus(null);
      setRecording(false);
      setMicBlocked(true);
      setError("Microphone access was blocked. Allow it in your settings, or type your answer.");
    }
  }, [prefs.model]);

  /** Stop the local recorder, transcribe, and fold the text into the answer. */
  const finishLocal = useCallback(async (): Promise<string> => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setRecording(false);
    if (!session) return answerRef.current.trim();
    setTranscribing(true);
    try {
      const text = await session.stop();
      answerRef.current = mergeAnswer(answerRef.current, text);
      setAnswer(answerRef.current);
    } catch {
      setError(
        "The on-device recogniser couldn't transcribe that answer. Type it here, or switch to the device recogniser before the next question.",
      );
    } finally {
      setTranscribing(false);
      setLocalStatus(null);
    }
    return answerRef.current.trim();
  }, []);

  /** Finish the current answer whichever recogniser produced it. */
  const stopAnswer = useCallback(async (): Promise<string> => {
    if (usingLocal) return await finishLocal();
    stopRecording();
    return (answerRef.current + " " + interim).trim();
  }, [usingLocal, finishLocal, stopRecording, interim]);

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
    try {
      await prepareLocal(prefs.model, setLocalStatus);
      setModelCached(true);
      return true;
    } catch {
      setError(
        "Couldn't download the speech model for on-device transcription. Check your connection and try again, or switch to your device's recogniser above — that needs no download.",
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
  const openAnswerWindow = useCallback(() => {
    if (!micSupported || micBlocked) return;
    if (usingLocal) void startLocal();
    else startRecording();
  }, [micSupported, micBlocked, usingLocal, startLocal, startRecording]);

  /*
    One-minute preparation countdown for Part 2. The moment it ends is the
    moment the candidate should start talking, so the last tick opens the
    answer window itself — inside the timeout, which is an event, rather than
    from an effect watching the number reach zero.
  */
  useEffect(() => {
    if (prepSeconds <= 0) return;
    const last = prepSeconds === 1;
    const t = setTimeout(() => {
      setPrepSeconds((n) => Math.max(0, n - 1));
      if (last) openAnswerWindow();
    }, 1000);
    return () => clearTimeout(t);
  }, [prepSeconds, openAnswerWindow]);

  const askCurrent = useCallback(
    async (index: number, list: Step[]) => {
      const s = list[index];
      if (!s) return;
      const intro = index === 0 || list[index - 1].part !== s.part ? PART_INTRO[s.part] + " " : "";
      setExaminerSpeaking(true);
      await speak(intro + s.question, 0.95);
      setExaminerSpeaking(false);
      if (s.part === 2) {
        /* The minute of preparation comes first; the window opens when it
           runs out, in the countdown below. */
        setPrepSeconds(60);
        return;
      }
      openAnswerWindow();
    },
    [openAnswerWindow],
  );

  /** Leave the interview: silence the examiner and release the microphone. */
  const endTest = useCallback(() => {
    cancelSpeech();
    wantRecordingRef.current = false;
    recRef.current?.abort();
    recRef.current = null;
    sessionRef.current?.abort();
    sessionRef.current = null;
    setLocalStatus(null);
    setTranscribing(false);
    setRecording(false);
    setExaminerSpeaking(false);
    setPrepSeconds(0);
    setInterim("");
    setAnswer("");
    answerRef.current = "";
    setStage("intro");
  }, []);

  const begin = useCallback(async () => {
    const list = buildInterview();
    setSteps(list);
    setStepIndex(0);
    setTranscript([]);
    setPrepSeconds(0);
    setAnswer("");
    setInterim("");
    answerRef.current = "";
    /*
      Downloaded and loaded before the interview begins, so a failure is
      something the candidate meets on the start screen — where switching
      recogniser is one tap away — rather than one question into the exam.
    */
    if (usingLocal) {
      const ready = await warmUpLocal();
      if (!ready) return;
    }
    setStage("interview");
    await askCurrent(0, list);
  }, [askCurrent, usingLocal, warmUpLocal]);

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
        addResult({
          module: "speaking",
          testId: "mock-speaking",
          testTitle: "Mock speaking interview",
          band: payload.overallBand,
          date: new Date().toISOString(),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Grading failed.");
        setStage("interview");
      }
    },
    [],
  );

  const nextQuestion = useCallback(async () => {
    if (!step) return;
    // With the local recogniser this waits for the transcription to land, so
    // the answer is never carried forward half-written.
    const spoken = await stopAnswer();
    const updated: Turn[] = [
      ...transcript,
      { role: "examiner", part: step.part, text: step.question },
      { role: "candidate", part: step.part, text: spoken || "(no answer given)" },
    ];
    setTranscript(updated);
    answerRef.current = "";
    setAnswer("");
    setInterim("");
    setPrepSeconds(0);
    setElapsed(0);

    const nextIndex = stepIndex + 1;
    if (nextIndex >= steps.length) {
      /*
        No marking on this plan, so no request. Calling the route anyway would
        spend fourteen minutes of somebody's afternoon and answer 402, and the
        transcript — which is the part that costs nothing and is genuinely
        useful — would be behind an error message.
      */
      if (!marked) {
        setStage("unmarked");
        return;
      }
      await gradeInterview(updated);
      return;
    }
    setStepIndex(nextIndex);
    await askCurrent(nextIndex, steps);
  }, [step, stepIndex, steps, transcript, stopAnswer, askCurrent, gradeInterview, marked]);

  // ---------- Screens ----------

  if (stage === "intro") {
    return (
      /*
        What the test is on one side, how it hears you on the other. Stacked
        and centred, this screen ran past the fold before the start button —
        on the page whose entire job is to get someone talking.
      */
      <div className="mx-auto max-w-3xl">
        <div className="card !p-4 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
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
              onClick={begin}
              disabled={localStatus !== null}
            >
              {localStatus !== null ? "Getting ready\u2026" : "Start the interview"}
            </button>
            {localStatus && (
              <div className="mt-3 rounded-2xl bg-indigo-50 px-4 py-3 text-left" aria-live="polite">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-indigo-800">
                  <span>{describeStatus(localStatus)}</span>
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
            <p className="mt-2 text-xs leading-5 text-slate-400">
              {usingLocal
                ? "Your voice is transcribed on this device and never uploaded. Only the text transcript is sent for marking."
                : "Your voice is transcribed by your device's own recogniser, which may send the audio to its maker. Only the text transcript is sent for marking."}{" "}
              <Link href="/privacy" className="underline hover:text-slate-600">
                What that means
              </Link>
            </p>
          </div>
          <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-left">
            <p className="text-sm font-semibold text-slate-800">How your speech becomes text</p>
            <div className="mt-2 space-y-2">
              <EngineOption
                checked={prefs.engine === "platform"}
                onSelect={() => updatePrefs({ ...prefs, engine: "platform" })}
                title="Your device's recogniser"
                blurb="Writes the words as you say them. Chrome, and some phones, do that by sending the audio to their maker."
              />
              <EngineOption
                checked={prefs.engine === "local"}
                onSelect={() => updatePrefs({ ...prefs, engine: "local" })}
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

            {prefs.engine === "local" && localBlock !== null && localBlock !== "server" && (
              <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                {blockerMessage(localBlock)}
              </p>
            )}
          </div>
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
            You answered every question, in exam order and against the clock. Here is everything
            you said. AI marking — a band for each criterion, and what to fix first — is part of
            Plus.
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

        <UpgradePanel feature="have this marked" signedIn={account.signedIn} tier="plus" />

        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => setStage("intro")}>
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
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
          <p className="text-[15px] text-slate-700">The examiner is marking your interview…</p>
          <p className="text-sm text-slate-500">This usually takes under a minute.</p>
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

      {isNewPart && (
        <p className="rounded-2xl bg-indigo-50 px-4 py-2 text-sm leading-6 text-indigo-800">
          {PART_INTRO[step.part]}
        </p>
      )}

      <div className="card !p-4">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          Examiner {examinerSpeaking && <span className="animate-pulse">speaking…</span>}
        </div>
        <p className="text-[17px] leading-7 text-slate-900">{step?.question}</p>

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
          <div className="mt-2.5 flex items-center justify-between rounded-2xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
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
            <VolumeMeter stream={micStream} muted={examinerSpeaking || preparing} />
            <p className="text-sm text-slate-600">
              {examinerSpeaking
                ? "Listen to the question\u2026"
                : preparing
                  ? "Make notes \u2014 you will start speaking when the minute is up"
                  : transcribing
                    ? "Working out what you said\u2026"
                    : recording
                      ? `Answering \u2014 ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}${
                          step?.part === 2 ? " (aim for 1\u20132 minutes)" : ""
                        }`
                      : "Speak your answer out loud"}
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
              <span>{describeStatus(localStatus)}</span>
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
            !micSupported
              ? "Type your answer here."
              : usingLocal
                ? "Speak, then stop — your words land here. You can also type or correct them."
                : "Your speech appears here — you can also type or correct it."
          }
          value={answer + (interim ? " " + interim : "")}
          onChange={(e) => {
            answerRef.current = e.target.value;
            setAnswer(e.target.value);
            setInterim("");
          }}
        />

        <button
          className="btn-primary w-full sm:w-auto"
          onClick={nextQuestion}
          disabled={examinerSpeaking || transcribing}
        >
          {transcribing
            ? "Transcribing…"
            : stepIndex + 1 >= totalSteps
              ? "Finish and get my band score"
              : "Next question"}
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
  title,
  blurb,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${
        checked ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-surface"
      }`}
    >
      <input
        type="radio"
        name="speech-engine"
        checked={checked}
        onChange={onSelect}
        className="mt-1 accent-indigo-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs leading-5 text-slate-600">{blurb}</span>
      </span>
    </label>
  );
}

/*
  Speaking is model-marked too, and a visitor gets no model at all — so the
  examiner would ask its questions and then have nothing to say about the
  answers. Locked at the door instead. See lib/entitlements/sessions.ts.
*/
export default function SpeakingPage() {
  return (
    /*
      The width is named here rather than in the gate, because this page is the
      only one whose opening card is narrower than the layout container — see
      the note on SkillGate's className. Locked, the lock is this wide; open,
      the intro card centres itself the same way and the gate adds nothing.
    */
    <SkillGate module="speaking" className="mx-auto max-w-3xl">
      <SpeakingSession />
    </SkillGate>
  );
}
