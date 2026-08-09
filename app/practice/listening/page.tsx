"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BandBadge from "@/components/BandBadge";
import ScoreFooter from "@/components/ScoreFooter";
import Review from "@/components/Review";
import TestQuestions, {
  type AnswerMap,
  type CheckedMap,
} from "@/components/TestQuestions";
import { testAdvice } from "@/lib/advice";
import { isCorrect, rawToBand } from "@/lib/band";
import { rankedEnglishVoices, toSentences } from "@/lib/speech";
import { useMounted, useProfile } from "@/lib/hooks";
import { flatQuestions, questionCount } from "@/lib/questions";
import { buildReview } from "@/lib/review";
import { addResult } from "@/lib/store";
import { LISTENING_TESTS } from "@/lib/tests";
import type { ListeningTest } from "@/lib/types";
import TestChooser from "@/components/TestChooser";

const bundled = LISTENING_TESTS;

interface PlaybackHooks {
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
function playScript(test: ListeningTest, from: number, hooks: PlaybackHooks): void {
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
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">{test.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-500">
            {mode === "timed" ? "Exam conditions · plays once" : "No time limit · replay freely"}
          </span>
          <select
            className="input"
            value={rate}
            onChange={(e) => {
              const r = Number(e.target.value);
              setRate(r);
              rateRef.current = r;
            }}
            title="Playback speed"
          >
            <option value={0.85}>0.85×</option>
            <option value={1}>1×</option>
            <option value={1.15}>1.15×</option>
          </select>
          {ttsSupported && !playing && (
            <button
              className="btn-primary"
              onClick={() => startAudio(0)}
              /* Under exam conditions the recording plays once, as in the real
                 test. Free practice may replay as often as it likes. */
              disabled={mode === "timed" && !submitted && (finishedAudio || turnIndex >= 0)}
            >
              {finishedAudio || turnIndex >= 0 ? "▶ Play again" : "▶ Play recording"}
            </button>
          )}
          {ttsSupported && playing && (
            <button className="btn-secondary" onClick={stopAudio}>
              ⏸ Stop
            </button>
          )}
        </div>
      </div>

      {playing && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-800">
          Playing turn {turnIndex + 1} of {test.script.length} —{" "}
          {test.script[Math.max(0, turnIndex)]?.speaker}
        </div>
      )}
      {finishedAudio && !submitted && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          Recording finished. Check your answers, then submit.
        </div>
      )}

      {submitted && band !== null && (
        <div className="card flex flex-col items-center gap-4 py-6 sm:flex-row sm:justify-center sm:gap-10">
          <BandBadge band={band} caption={`${raw}/${questionCount(test.questions)} correct`} />
          <div className="max-w-md text-sm text-slate-600">
            <p>
              Estimated listening band <span className="font-semibold">{band}</span>. Go through
              the review below with the transcript open — every answer you missed was audible,
              and finding where is what fixes it.
            </p>
            <div className="mt-3 flex gap-2">
              <Link href="/practice" className="btn-secondary">
                More tests
              </Link>
              <Link href="/plan" className="btn-primary">
                Study plan
              </Link>
            </div>
          </div>
        </div>
      )}

      {submitted && band !== null && (
        <Review
          items={buildReview(test.questions, answers)}
          advice={testAdvice(
            "listening",
            test.questions,
            buildReview(test.questions, answers).map((i) => i.id),
            band,
          )}
          total={questionCount(test.questions)}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <TestQuestions
            questions={test.questions}
            answers={answers}
            onAnswer={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))}
            submitted={submitted}
            checked={checked}
            onCheck={(id) => setChecked((c) => ({ ...c, [id]: true }))}
            mode={mode === "timed" ? "exam" : "practice"}
          />
          {!submitted && (
            <button className="btn-primary mt-5 w-full" onClick={submit}>
              Submit answers
            </button>
          )}
        </div>
        <div className="card max-h-[75vh] overflow-y-auto lg:sticky lg:top-20">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Transcript
            </h2>
            {!submitted && (
              <button
                className="text-xs text-indigo-600 hover:underline"
                onClick={() => setShowTranscript((s) => !s)}
              >
                {showTranscript
                  ? "Hide"
                  : mode === "free" || !ttsSupported
                    ? "Show transcript"
                    : "Show (spoiler!)"}
              </button>
            )}
          </div>
          {showTranscript ? (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">Select any word to look it up</p>
              {test.script.map((turn, i) => (
                <p key={i} className="text-sm leading-6 text-slate-700">
                  <span className="mr-1 font-semibold text-slate-500">{turn.speaker}:</span>
                  {turn.text}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              {mode === "timed"
                ? "Hidden during the test — just like the real exam. It unlocks automatically after you submit."
                : "You are practising without a clock, so open it whenever it helps. It unlocks automatically after you submit."}
            </p>
          )}
        </div>
      </div>

      {/*
        The score again, where the learner actually is when the paper is
        marked. The card at the top of the page heads the review; this closes
        the paper. See components/ScoreFooter.tsx.
      */}
      {submitted && band !== null && (
        <ScoreFooter
          module="listening"
          band={band}
          raw={raw}
          total={questionCount(test.questions)}
        />
      )}
    </div>
  );
}

export default function ListeningTestPage() {
  return (
    <Suspense fallback={null}>
      <ListeningTestPageRunner />
    </Suspense>
  );
}
