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
import { isCorrect, rawToBand } from "@/lib/band";
import { rankedEnglishVoices } from "@/lib/speech";
import { playScript } from "@/lib/exam/playback";
import { useMounted, useProfile } from "@/lib/hooks";
import { flatQuestions, questionCount } from "@/lib/questions";
import { buildReview } from "@/lib/review";
import { addResult } from "@/lib/store";
import { LISTENING_TESTS } from "@/lib/tests";
import type { ListeningTest } from "@/lib/types";
import TestChooser from "@/components/TestChooser";
import ExamShell from "@/components/exam/ExamShell";
import { useExamNavigation } from "@/lib/exam/navigation";
import styles from "./listening.module.css";

const bundled = LISTENING_TESTS;

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
  const [turnIndex, setTurnIndex] = useState(-1);
  const [finishedAudio, setFinishedAudio] = useState(false);
  const [rate, setRate] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);

  const playingRef = useRef(false);
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

  const flat = useMemo(() => (test ? flatQuestions(test.questions) : []), [test]);
  const nav = useExamNavigation(
    useMemo(
      () => flat.map((q) => ({ id: q.id, answered: answers[q.id] !== undefined })),
      [flat, answers],
    ),
  );

  const ttsSupported = mounted && typeof window !== "undefined" && "speechSynthesis" in window;

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
      playingRef.current = false;
      window.speechSynthesis.cancel();
    };
  }, [ttsSupported]);

  const startAudio = useCallback(
    (from: number) => {
      if (!test || !ttsSupported) return;
      window.speechSynthesis.cancel();
      playingRef.current = true;
      setPlaying(true);
      setFinishedAudio(false);
      playScript(test, from, {
        voices: voicesRef.current,
        rate: () => rateRef.current,
        stillPlaying: () => playingRef.current,
        onTurn: setTurnIndex,
        onEnd: () => {
          playingRef.current = false;
          setPlaying(false);
          setFinishedAudio(true);
          setTurnIndex(-1);
        },
      });
    },
    [test, ttsSupported],
  );

  const stopAudio = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const submit = useCallback(() => {
    if (!test || submitted) return;
    stopAudio();
    const asked = flatQuestions(test.questions);
    let correct = 0;
    for (const q of asked) {
      if (isCorrect(q, answers[q.id])) correct++;
    }
    const b = rawToBand(correct, asked.length, "listening");
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
      <div className="mx-auto flex min-h-[calc(100dvh-3.75rem)] max-w-xl items-center px-4">
        <div className="card w-full space-y-4 py-8 text-center">
          <h1 className="text-[26px] font-semibold text-slate-900">{test.title}</h1>
          <p className="text-sm text-slate-600">{test.context}</p>
          <p className="text-sm text-slate-600">
            The recording is read aloud by your browser ({test.script.length} turns,{" "}
            {test.speakers.length} speaker{test.speakers.length > 1 ? "s" : ""}). Read the{" "}
            {questionCount(test.questions)} questions first, then press play and answer as you listen.
            In exam conditions you hear the recording <span className="font-medium">once</span> —
            but you can replay while practising.
          </p>
          {!ttsSupported && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Your browser does not support speech synthesis. Use Chrome, Edge or Safari for
              audio — or practise in transcript mode below.
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
                  title: "Practice slowly",
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
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-left text-sm leading-6 text-amber-800">
              {mode === "timed"
                ? "Like the real exam: you cannot see any answers until you finish. When you finish, you get your band and every explanation."
                : "You can check one answer at a time and read why it is right. Once you check a question you cannot change it, so your band still means something."}
            </p>
          </div>
          <button className="btn-primary" onClick={() => setStarted(true)}>
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
      onNextFlagged={nav.nextFlagged}
      bottomLeft={submitted && band !== null ? `Band ${band} · ${raw}/${flat.length}` : "Practice complete"}
      topRight={
        <div className="flex items-center gap-1.5">
          <select
            className="input !h-8 !w-auto !px-1.5 !py-0 text-xs"
            value={rate}
            onChange={(e) => {
              const nextRate = Number(e.target.value);
              setRate(nextRate);
              rateRef.current = nextRate;
            }}
            title="Playback speed"
          >
            <option value={0.85}>0.85×</option>
            <option value={1}>1×</option>
            <option value={1.15}>1.15×</option>
          </select>
          {ttsSupported && !playing ? (
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
              {finishedAudio ? "Replay" : "Play"}
            </button>
          ) : ttsSupported ? (
            <button type="button" className={styles.playbackControl} onClick={stopAudio}>
              Stop
            </button>
          ) : null}
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto" data-listening-paper>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--exam-line)] pb-2 text-xs text-[color:var(--exam-muted)]">
          <span>
            {playing
              ? `Playing ${turnIndex + 1} of ${test.script.length} · ${test.script[Math.max(0, turnIndex)]?.speaker}`
              : finishedAudio
                ? "Recording finished"
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
