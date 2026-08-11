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
  LENGTHS,
  type TestLength,
  answeredCount,
  bandRange,
  finishAdaptive,
  nextQuestion,
  placementEvidence,
  recordAnswer,
  shouldStop,
  startAdaptive,
} from "@/lib/placement";
import { recentPlacementSittings, setPlacement, setTargetBand } from "@/lib/store";
import type {
  CEFRLevel,
  PlacementData,
  PlacementQuestion,
  PlacementResult,
} from "@/lib/types";

const bank = (placementData as PlacementData).questions;

/** A quiet cue that the test is tracking difficulty, without naming a level. */
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
  const [length, setLength] = useState<TestLength>(5);
  const [started, setStarted] = useState(false);
  const [state, setState] = useState<AdaptiveState>(() => startAdaptive(5));
  const [current, setCurrent] = useState<PlacementQuestion | null>(null);
  const [choice, setChoice] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<PlacementResult | null>(null);
  const [evidenceGap, setEvidenceGap] = useState<AdaptiveState | null>(null);
  const [accuracyMode, setAccuracyMode] = useState(false);
  const [target, setTarget] = useState(6.5);
  // Captured once at the start: saving the result rewrites the history, and the
  // sitting must keep excluding the questions it began by excluding.
  const excluded = useRef<string[][]>([]);

  const finish = useCallback((final: AdaptiveState) => {
    const evidence = placementEvidence(final);
    setState(final);
    setChoice(undefined);
    if (!evidence.reportable) {
      setCurrent(null);
      setEvidenceGap(final);
      return;
    }

    const r = finishAdaptive(final);
    setPlacement(
      r,
      final.asked.map((q) => q.id),
    );
    setState(final);
    setCurrent(null);
    setEvidenceGap(null);
    setResult(r);
  }, []);

  const start = useCallback(() => {
    const fresh = startAdaptive(length);
    excluded.current = recentPlacementSittings();
    setState(fresh);
    setCurrent(nextQuestion(bank, fresh, excluded.current));
    setChoice(undefined);
    setEvidenceGap(null);
    setAccuracyMode(false);
    setResult(null);
    setStarted(true);
  }, [length]);

  const restart = useCallback(() => {
    setStarted(false);
    setState(startAdaptive(length));
    setCurrent(null);
    setChoice(undefined);
    setEvidenceGap(null);
    setAccuracyMode(false);
    setResult(null);
  }, [length]);

  const continueForAccuracy = useCallback(() => {
    if (!evidenceGap) return;
    const q = nextQuestion(bank, evidenceGap, excluded.current);
    if (!q) {
      restart();
      return;
    }
    setState(evidenceGap);
    setCurrent(q);
    setChoice(undefined);
    setEvidenceGap(null);
    setAccuracyMode(true);
    setStarted(true);
  }, [evidenceGap, restart]);

  /** Fold the current answer in, then either serve the next question or stop. */
  const advance = useCallback(
    (picked: number | undefined) => {
      if (!current) return;
      const next = recordAnswer(state, current, picked);
      if (shouldStop(next)) {
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
    // A visible but unanswered item is not an incorrect answer. More
    // importantly, one answered item can never turn into a plausible-looking
    // band merely because the timer expired.
    const final = current && choice !== undefined ? recordAnswer(state, current, choice) : state;
    finish(final);
  }, [current, state, choice, finish]);

  if (evidenceGap) {
    const evidence = placementEvidence(evidenceGap);
    const remaining = Math.max(0, evidence.minimum - evidence.answered);
    const skillGap = evidence.missingSkills.map((skill) => skill).join(", ");

    return (
      <div className="mx-auto flex min-h-[40vh] max-w-xl items-center">
        <section className="card !p-5 w-full space-y-4 text-center" aria-live="polite">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
              No reliable score yet
            </p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">
              More answers are needed
            </h1>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            You answered {evidence.answered} question{evidence.answered === 1 ? "" : "s"}. A band
            based on that would be misleading, so BandUp has not saved one.
          </p>
          <div className="grid grid-cols-2 gap-2 text-left">
            <div className="rounded-xl border border-slate-200 bg-surface px-3 py-2.5">
              <span className="block text-xs text-slate-500">Still needed</span>
              <span className="text-sm font-semibold text-slate-900">
                {remaining > 0 ? `${remaining} answers` : "More consistency"}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-surface px-3 py-2.5">
              <span className="block text-xs text-slate-500">Skill coverage</span>
              <span className="text-sm font-semibold capitalize text-slate-900">
                {skillGap || "All covered"}
              </span>
            </div>
          </div>
          <p className="text-xs leading-5 text-slate-500">
            Continue without the countdown. The test will stop automatically as soon as the
            evidence is strong enough.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn-primary" onClick={continueForAccuracy}>
              Continue for an accurate result
            </button>
            <button className="btn-secondary" onClick={restart}>
              Start again
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (result) {
    const [low, high] = bandRange(state);
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
      /*
        The band, what to do about it, and both breakdowns above the fold. The
        result used to open with a 96px badge centred in an eight-line card,
        and everything that explains it started below the screen.
      */
      <div className="mx-auto max-w-3xl space-y-3">
        <section className="card !p-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-72 items-center gap-4">
            <BandBadge band={result.band} />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-900">Your estimated IELTS band</h1>
              {/* At the very top or bottom of the scale both ends round to the
                  same band, and "between 1 and 1" is worse than saying nothing. */}
              {low !== high && (
                <p className="text-sm text-slate-500">
                  Most likely between band {low} and {high}
                </p>
              )}
              <p className="mt-0.5 text-xs leading-5 text-slate-600">
                {placementEvidence(state).confidence === "high" ? "High" : "Moderate"} confidence
                from {answeredCount(state)} answered questions. Each item was chosen to narrow the
                estimate; full module tests can narrow it further.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-700" htmlFor="target">
              Target band
            </label>
            <select
              id="target"
              className="input !py-2"
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

        <section className="grid gap-3 sm:grid-cols-2">
          <div className="card !p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">By skill</h2>
            {SKILLS.map((s) => {
              const b = result.bySkill[s];
              const pct = b.total ? Math.round((b.correct / b.total) * 100) : 0;
              return (
                <div key={s} className="mb-1.5">
                  <div className="mb-0.5 flex justify-between text-xs text-slate-600">
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
          <div className="card !p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">By difficulty (CEFR)</h2>
            {LEVELS.map((l) => {
              const b = result.byLevel[l];
              const pct = b.total ? Math.round((b.correct / b.total) * 100) : 0;
              return (
                <div key={l} className="mb-1.5">
                  <div className="mb-0.5 flex justify-between text-xs text-slate-600">
                    <span>{l}</span>
                    <span>{b.total === 0 ? "not reached" : `${b.correct}/${b.total}`}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <Review items={wrong} advice={placementAdvice(result)} total={state.asked.length} />
      </div>
    );
  }

  if (!started || !current) {
    return (
      <div className="mx-auto flex min-h-[40vh] max-w-xl items-center">
        <div className="card !p-5 w-full space-y-3 text-center">
          <h1 className="text-xl font-semibold text-slate-900">Placement test</h1>
          <p className="text-sm leading-6 text-slate-600">
            This test estimates your level by choosing the most useful next question. A band is
            shown only after enough answers across grammar, vocabulary and reading — never from
            one lucky answer or an expired timer.
          </p>

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              How much time do you have?
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(LENGTHS) as unknown as TestLength[]).map((key) => {
                const value = Number(key) as TestLength;
                const active = length === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setLength(value)}
                    className={`rounded-xl border px-3 py-2.5 text-left transition-all ${
                      active
                        ? "border-indigo-500 bg-indigo-50"
                        : "border-slate-200 bg-surface hover:border-slate-300"
                    }`}
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {value} minutes
                    </span>
                    <span className="block text-xs text-slate-500">
                      at least {LENGTHS[value].min} answers · up to {LENGTHS[value].max}
                      {value === 10 ? " · more precise" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-slate-500">
            If time ends before the evidence is sufficient, BandUp shows no guessed band and lets
            you continue. Skipped questions do not count towards the minimum.
          </p>
          <button className="btn-primary" onClick={start}>
            Start the test
          </button>
        </div>
      </div>
    );
  }

  const number = state.asked.length + 1;
  const evidence = placementEvidence(state);
  const max = evidence.maximum;
  const nextAnswered = evidence.answered + (choice === undefined ? 0 : 1);

  return (
    <div className="mx-auto max-w-xl space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm text-slate-500">
          Question {number} · {evidence.answered}/{evidence.minimum} minimum answered
          <DifficultyMeter level={current.level} />
        </span>
        {accuracyMode ? (
          <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
            Accuracy mode
          </span>
        ) : (
          <Timer minutes={state.length} running onExpire={onExpire} />
        )}
      </div>

      <div className="h-1.5 rounded-full bg-slate-100">
        <div
          className="h-1.5 rounded-full bg-indigo-500 transition-all"
          style={{ width: `${Math.min(100, (evidence.answered / max) * 100)}%` }}
        />
      </div>

      <div className="card !p-4" data-lookupable>
        <p className="mb-3 whitespace-pre-line text-base font-medium text-slate-900">
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
        <button
          className="btn-primary"
          disabled={choice === undefined}
          onClick={() => advance(choice)}
        >
          {nextAnswered >= max ? "Finish and see my band" : "Next question"}
        </button>
      </div>

      <p className="text-center text-xs text-slate-400">
        You cannot go back — each question is chosen from your last answer. Every one you miss
        comes back with an explanation at the end.
      </p>
    </div>
  );
}
