"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import BandBadge from "@/components/BandBadge";
import Review, { type ReviewItem } from "@/components/Review";
import Timer from "@/components/Timer";
import placementData from "@/data/placement.json";
import { placementAdvice } from "@/lib/advice";
import { LEVELS, SKILLS } from "@/lib/band";
import {
  type AdaptiveState,
  TEST_LENGTH,
  finishAdaptive,
  nextQuestion,
  recordAnswer,
  startAdaptive,
} from "@/lib/placement";
import { recentPlacementQuestionIds, setPlacement, setTargetBand } from "@/lib/store";
import type {
  CEFRLevel,
  PlacementData,
  PlacementQuestion,
  PlacementResult,
} from "@/lib/types";

const bank = (placementData as PlacementData).questions;

/** A quiet visual cue that the test is tracking difficulty, without naming a level. */
function DifficultyMeter({ level }: { level: CEFRLevel }) {
  const filled = Math.max(1, LEVELS.indexOf(level) + 1);
  return (
    <span className="inline-flex items-center gap-1" title="Question difficulty">
      {LEVELS.map((_, i) => (
        <span
          key={i}
          className={`h-1.5 w-3 rounded-full ${i < filled ? "bg-amber-400" : "bg-slate-200"}`}
        />
      ))}
    </span>
  );
}

export default function PlacementPage() {
  const [started, setStarted] = useState(false);
  const [state, setState] = useState<AdaptiveState>(startAdaptive);
  const [current, setCurrent] = useState<PlacementQuestion | null>(null);
  const [choice, setChoice] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<PlacementResult | null>(null);
  const [target, setTarget] = useState(6.5);
  // Captured once at the start: saving the result rewrites the history, and the
  // sitting must keep excluding the questions it began by excluding.
  const excluded = useRef<string[]>([]);

  const finish = useCallback((final: AdaptiveState) => {
    const r = finishAdaptive(final);
    setPlacement(
      r,
      final.asked.map((q) => q.id),
    );
    setState(final);
    setCurrent(null);
    setResult(r);
  }, []);

  const start = useCallback(() => {
    const fresh = startAdaptive();
    excluded.current = recentPlacementQuestionIds();
    setState(fresh);
    setCurrent(nextQuestion(bank, fresh, excluded.current));
    setChoice(undefined);
    setStarted(true);
  }, []);

  /** Fold the current answer in, then either serve the next question or stop. */
  const advance = useCallback(
    (picked: number | undefined) => {
      if (!current) return;
      const next = recordAnswer(state, current, picked);
      if (next.asked.length >= TEST_LENGTH) {
        finish(next);
        return;
      }
      const q = nextQuestion(bank, next, excluded.current);
      if (!q) {
        finish(next);
        return;
      }
      setState(next);
      setCurrent(q);
      setChoice(undefined);
    },
    [current, state, finish],
  );

  const onExpire = useCallback(() => {
    // Time is up: bank whatever is on screen, then score what was answered.
    finish(current ? recordAnswer(state, current, choice) : state);
  }, [current, state, choice, finish]);

  if (result) {
    const wrong: ReviewItem[] = state.asked
      .filter((q) => state.answers[q.id] !== q.answer)
      .map((q) => ({
        id: q.id,
        prompt: q.question,
        yourAnswer:
          state.answers[q.id] === undefined ? "" : q.options[state.answers[q.id] as number],
        correctAnswer: q.options[q.answer],
        explanation: q.explanation,
        tag: `${q.skill} · ${q.level}`,
      }));

    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="card flex flex-col items-center gap-4 py-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">Your estimated IELTS band</h1>
          <BandBadge band={result.band} />
          <p className="max-w-md text-sm text-slate-600">
            The test adapted to you over {state.asked.length} questions, getting harder when you
            were right and easier when you were not. Full practice tests in each module will
            refine the estimate.
          </p>
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-700" htmlFor="target">
              Target band
            </label>
            <select
              id="target"
              className="input"
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
            >
              {[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <Link href="/plan" className="btn-primary" onClick={() => setTargetBand(target)}>
              Build my study plan
            </Link>
          </div>
        </section>

        <Review items={wrong} advice={placementAdvice(result)} total={state.asked.length} />

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="card">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">By skill</h2>
            {SKILLS.map((s) => {
              const b = result.bySkill[s];
              const pct = b.total ? Math.round((b.correct / b.total) * 100) : 0;
              return (
                <div key={s} className="mb-2">
                  <div className="mb-1 flex justify-between text-xs text-slate-600">
                    <span className="capitalize">{s}</span>
                    <span>
                      {b.correct}/{b.total}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="card">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">By difficulty (CEFR)</h2>
            {LEVELS.map((l) => {
              const b = result.byLevel[l];
              const pct = b.total ? Math.round((b.correct / b.total) * 100) : 0;
              return (
                <div key={l} className="mb-2">
                  <div className="mb-1 flex justify-between text-xs text-slate-600">
                    <span>{l}</span>
                    <span>
                      {b.total === 0 ? "not reached" : `${b.correct}/${b.total}`}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  if (!started || !current) {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-4 py-8 text-center">
          <h1 className="text-[26px] font-semibold text-slate-900">Placement test</h1>
          <p className="text-sm text-slate-600">
            {TEST_LENGTH} questions, 5 minutes. The test adapts as you go: get one right and the
            next is harder, get one wrong and the next is easier. It settles on your level far
            faster than a fixed paper, and you get an estimated IELTS band (1–9) at the end.
          </p>
          <p className="text-sm text-slate-500">
            Questions are drawn from a bank of {bank.length} and never repeat within three
            sittings, so retaking it is a real re-test rather than a memory test.
          </p>
          <button className="btn-primary" onClick={start}>
            Start the test
          </button>
        </div>
      </div>
    );
  }

  const number = state.asked.length + 1;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm text-slate-500">
          Question {number} of {TEST_LENGTH}
          <DifficultyMeter level={current.level} />
        </span>
        <Timer minutes={5} running onExpire={onExpire} />
      </div>

      <div className="h-1.5 rounded-full bg-slate-100">
        <div
          className="h-1.5 rounded-full bg-indigo-500 transition-all"
          style={{ width: `${(state.asked.length / TEST_LENGTH) * 100}%` }}
        />
      </div>

      <div className="card">
        <p className="mb-4 whitespace-pre-line text-base font-medium text-slate-900">
          {current.question}
        </p>
        <div className="space-y-2">
          {current.options.map((opt, idx) => (
            <label
              key={idx}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                choice === idx
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-slate-200 bg-surface hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name={current.id}
                checked={choice === idx}
                onChange={() => setChoice(idx)}
                className="accent-indigo-600"
              />
              <span className="text-slate-700">{opt}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        {/* No going back: the next question is chosen from this answer, so
            changing an earlier one would invalidate everything after it. */}
        <button className="btn-secondary" onClick={() => advance(undefined)}>
          Skip
        </button>
        <button className="btn-primary" disabled={choice === undefined} onClick={() => advance(choice)}>
          {number === TEST_LENGTH ? "Finish and see my band" : "Next question"}
        </button>
      </div>

      <p className="text-center text-xs text-slate-400">
        You cannot go back — each question is chosen from your last answer. Every one you miss
        comes back with an explanation at the end.
      </p>
    </div>
  );
}
