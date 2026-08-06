"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BandBadge from "@/components/BandBadge";
import TestQuestions, { type AnswerMap } from "@/components/TestQuestions";
import listeningOne from "@/data/listening-1.json";
import listeningTwo from "@/data/listening-2.json";
import { isCorrect, rawToBand } from "@/lib/band";
import { useMounted, useProfile } from "@/lib/hooks";
import { addResult } from "@/lib/store";
import type { ListeningTest } from "@/lib/types";

const bundled = [listeningOne, listeningTwo] as ListeningTest[];

interface PlaybackHooks {
  voices: SpeechSynthesisVoice[];
  rate: () => number;
  stillPlaying: () => boolean;
  onTurn: (index: number) => void;
  onEnd: () => void;
}

/**
 * Speak the script one turn at a time, chaining each utterance to the next so
 * turns never overlap. Each speaker gets its own voice where the browser offers
 * more than one, and a pitch shift otherwise.
 */
function playScript(test: ListeningTest, from: number, hooks: PlaybackHooks): void {
  const step = (index: number) => {
    if (!hooks.stillPlaying()) return;
    if (index >= test.script.length) {
      hooks.onEnd();
      return;
    }
    hooks.onTurn(index);
    const turn = test.script[index];
    const utter = new SpeechSynthesisUtterance(turn.text);
    const speakerIdx = Math.max(0, test.speakers.indexOf(turn.speaker));
    if (hooks.voices.length > 0) {
      utter.voice = hooks.voices[speakerIdx % hooks.voices.length];
    }
    utter.pitch = speakerIdx === 0 ? 1 : 0.8;
    utter.rate = hooks.rate();
    utter.onend = () => step(index + 1);
    utter.onerror = () => step(index + 1);
    window.speechSynthesis.speak(utter);
  };
  step(from);
}

export default function ListeningTestPage() {
  const params = useParams<{ id: string }>();
  const profile = useProfile();
  const mounted = useMounted();
  const [started, setStarted] = useState(false);
  const [answers, setAnswers] = useState<AnswerMap>({});
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
    const id = params.id;
    return (
      bundled.find((t) => t.id === id) ??
      (profile.genTests.find((g) => g.kind === "listening" && g.test.id === id)?.test as
        | ListeningTest
        | undefined) ??
      null
    );
  }, [params.id, profile.genTests]);

  const ttsSupported = mounted && typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!ttsSupported) return;
    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis
        .getVoices()
        .filter((v) => v.lang.toLowerCase().startsWith("en"));
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
    let correct = 0;
    for (const q of test.questions) {
      if (isCorrect(q, answers[q.id])) correct++;
    }
    const b = rawToBand(correct, test.questions.length, "listening");
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
      total: test.questions.length,
      date: new Date().toISOString(),
    });
  }, [test, answers, submitted, stopAudio]);

  // Generated tests are read from localStorage, so wait for hydration before
  // deciding a test is genuinely missing.
  if (!test) {
    if (!mounted) return null;
    return (
      <div className="card mx-auto mt-[10vh] max-w-xl text-center">
        <p className="text-slate-600">We couldn&apos;t find that test on this device.</p>
        <Link href="/practice" className="btn-primary mt-4">
          Back to practice tests
        </Link>
      </div>
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
            {test.questions.length} questions first, then press play and answer as you listen.
            In exam conditions you hear the recording <span className="font-medium">once</span> —
            but you can replay while practising.
          </p>
          {!ttsSupported && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Your browser does not support speech synthesis. Use Chrome, Edge or Safari for
              audio — or practise in transcript mode below.
            </p>
          )}
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
        <div className="flex items-center gap-2">
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
            <button className="btn-primary" onClick={() => startAudio(0)}>
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
          <BandBadge band={band} caption={`${raw}/${test.questions.length} correct`} />
          <div className="max-w-md text-sm text-slate-600">
            <p>
              Estimated listening band <span className="font-semibold">{band}</span>. Review your
              answers and the transcript below.
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

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <TestQuestions
            questions={test.questions}
            answers={answers}
            onAnswer={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))}
            submitted={submitted}
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
                {showTranscript ? "Hide" : ttsSupported ? "Show (spoiler!)" : "Show transcript"}
              </button>
            )}
          </div>
          {showTranscript ? (
            <div className="space-y-3">
              {test.script.map((turn, i) => (
                <p key={i} className="text-sm leading-6 text-slate-700">
                  <span className="mr-1 font-semibold text-slate-500">{turn.speaker}:</span>
                  {turn.text}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Hidden during the test — just like the real exam. It unlocks automatically after
              you submit.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
