"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BandBadge from "@/components/BandBadge";
import ExplainText from "@/components/ExplainText";
import speakingData from "@/data/speaking-topics.json";
import { useMounted } from "@/lib/hooks";
import {
  cancelSpeech,
  getSpeechRecognition,
  speechRecognitionSupported,
  speak,
  type SpeechRecognitionEvent,
  type SpeechRecognitionLike,
} from "@/lib/speech";
import { addResult } from "@/lib/store";
import type { SpeakingCueCard, SpeakingGrade, SpeakingTopicsData } from "@/lib/types";

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

export default function SpeakingPage() {
  const [stage, setStage] = useState<"intro" | "interview" | "grading" | "result">("intro");
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
  const mounted = useMounted();
  const micSupported = mounted && speechRecognitionSupported() && !micBlocked;

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRecordingRef = useRef(false);
  const answerRef = useRef("");

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
    };
  }, []);

  // Elapsed-time ticker while the candidate is answering.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // One-minute preparation countdown for Part 2.
  useEffect(() => {
    if (prepSeconds <= 0) return;
    const t = setTimeout(() => setPrepSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [prepSeconds]);

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

  const askCurrent = useCallback(
    async (index: number, list: Step[]) => {
      const s = list[index];
      if (!s) return;
      const intro = index === 0 || list[index - 1].part !== s.part ? PART_INTRO[s.part] + " " : "";
      setExaminerSpeaking(true);
      await speak(intro + s.question, 0.95);
      setExaminerSpeaking(false);
      if (s.part === 2) {
        setPrepSeconds(60);
      }
    },
    [],
  );

  /** Leave the interview: silence the examiner and release the microphone. */
  const endTest = useCallback(() => {
    cancelSpeech();
    wantRecordingRef.current = false;
    recRef.current?.abort();
    recRef.current = null;
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
    setStage("interview");
    await askCurrent(0, list);
  }, [askCurrent]);

  const gradeInterview = useCallback(
    async (finalTranscript: Turn[]) => {
      setStage("grading");
      setError(null);
      try {
        const res = await fetch("/api/grade/speaking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: finalTranscript }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error ?? "Grading failed.");
        setGrade(payload as SpeakingGrade);
        setStage("result");
        addResult({
          module: "speaking",
          testId: "mock-speaking",
          testTitle: "Mock speaking interview",
          band: (payload as SpeakingGrade).overallBand,
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
    stopRecording();
    const spoken = (answerRef.current + " " + interim).trim();
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
      await gradeInterview(updated);
      return;
    }
    setStepIndex(nextIndex);
    await askCurrent(nextIndex, steps);
  }, [step, stepIndex, steps, transcript, interim, stopRecording, askCurrent, gradeInterview]);

  // ---------- Screens ----------

  if (stage === "intro") {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-4 text-center">
          <div className="text-4xl" aria-hidden>
            🗣️
          </div>
          <h1 className="text-[26px] font-semibold text-slate-900">Mock speaking test</h1>
          <p className="text-[15px] leading-7 text-slate-600">
            An AI examiner asks you questions out loud, you answer out loud, and at the end you
            get a band score with feedback on all four speaking criteria.
          </p>
          <ol className="mx-auto max-w-sm space-y-2 text-left text-sm text-slate-600">
            <li className="flex gap-3">
              <span className="font-semibold text-indigo-600">1</span> Short questions about you
              (about 4 minutes)
            </li>
            <li className="flex gap-3">
              <span className="font-semibold text-indigo-600">2</span> A topic card — 1 minute to
              prepare, then talk for 2 minutes
            </li>
            <li className="flex gap-3">
              <span className="font-semibold text-indigo-600">3</span> A discussion of bigger
              ideas around that topic
            </li>
          </ol>
          {!micSupported && (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Your browser can&apos;t record speech. You can still take the test by typing your
              answers — or switch to Chrome, Edge or Safari to speak them.
            </p>
          )}
          <button className="btn-primary w-full sm:w-auto" onClick={begin}>
            Start the interview
          </button>
          <p className="text-xs text-slate-400">
            Your voice is transcribed in your browser. Only the text transcript is sent for
            marking.
          </p>
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
      <div className="space-y-6">
        <div className="card flex flex-col items-center gap-6 text-center sm:flex-row sm:text-left">
          <BandBadge band={grade.overallBand} caption="Your speaking band" />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-slate-900">Interview complete</h1>
            <p className="text-[15px] leading-7 text-slate-600">
              Here&apos;s how each criterion scored, what you did well, and what to fix first.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {grade.criteria.map((c) => (
            <div key={c.name} className="card">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">{c.name}</h3>
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                  {c.band}
                </span>
              </div>
              <ExplainText
                text={c.comment}
                className="mt-2 block text-sm leading-6 text-slate-600"
              />
            </div>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="card">
            <h3 className="mb-3 text-sm font-semibold text-emerald-700">What you did well</h3>
            <ul className="space-y-2 text-sm leading-6 text-slate-700">
              {grade.strengths.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-emerald-600">✓</span>
                  <ExplainText text={s} />
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3 className="mb-3 text-sm font-semibold text-indigo-700">Fix these first</h3>
            <ol className="space-y-2 text-sm leading-6 text-slate-700">
              {grade.improvements.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-semibold text-indigo-600">{i + 1}</span>
                  <ExplainText text={s} />
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="card">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">
            One of your answers, at band 8
          </h3>
          <ExplainText
            text={grade.betterAnswerExample}
            className="block text-[15px] leading-7 text-slate-700"
          />
          <ExplainText
            text={grade.pronunciationNote}
            className="mt-4 block rounded-xl bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-500"
          />
        </div>

        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">
            Read the full transcript
          </summary>
          <div className="mt-4 space-y-3">
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
    <div className="mx-auto max-w-2xl space-y-5">
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
        <p className="rounded-2xl bg-indigo-50 px-5 py-3 text-sm leading-6 text-indigo-800">
          {PART_INTRO[step.part]}
        </p>
      )}

      <div className="card">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          Examiner {examinerSpeaking && <span className="animate-pulse">speaking…</span>}
        </div>
        <p className="text-[19px] leading-8 text-slate-900">{step?.question}</p>

        {step?.cueCard && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <p className="mb-2 text-sm font-medium text-slate-700">You should say:</p>
            <ul className="space-y-1.5 text-sm leading-6 text-slate-700">
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
          <div className="mt-4 flex items-center justify-between rounded-2xl bg-amber-50 px-5 py-3 text-sm text-amber-800">
            <span>Preparation time — make notes, don&apos;t speak yet.</span>
            <span className="font-mono text-base font-semibold">{prepSeconds}s</span>
          </div>
        )}
      </div>

      {/* One big, obvious control. */}
      <div className="card flex flex-col items-center gap-4 text-center">
        {micSupported ? (
          <>
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={examinerSpeaking || preparing}
              className={`flex h-24 w-24 items-center justify-center rounded-full text-3xl transition-all disabled:opacity-40 ${
                recording
                  ? "bg-rose-600 text-accent-fg shadow-lg ring-8 ring-rose-100"
                  : "bg-indigo-600 text-accent-fg shadow-md hover:bg-indigo-700 hover:shadow-lg"
              }`}
              aria-label={recording ? "Stop recording" : "Start recording"}
            >
              {recording ? "⏹" : "🎤"}
            </button>
            <p className="text-sm text-slate-600">
              {examinerSpeaking
                ? "Listen to the question…"
                : preparing
                  ? "Wait for the preparation minute to finish"
                  : recording
                    ? `Recording — ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}${
                        step?.part === 2 ? " (aim for 1–2 minutes)" : ""
                      }`
                    : "Tap to answer out loud"}
            </p>
          </>
        ) : null}

        <textarea
          className="input h-28 w-full resize-y text-left leading-7"
          placeholder={
            micSupported
              ? "Your speech appears here — you can also type or correct it."
              : "Type your answer here."
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
          disabled={examinerSpeaking}
        >
          {stepIndex + 1 >= totalSteps ? "Finish and get my band score" : "Next question"}
        </button>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </div>
    </div>
  );
}
