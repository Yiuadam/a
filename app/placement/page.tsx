"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import BandBadge from "@/components/BandBadge";
import Timer from "@/components/Timer";
import placementData from "@/data/placement.json";
import { LEVELS, SKILLS, scorePlacement } from "@/lib/band";
import { setPlacement, setTargetBand } from "@/lib/store";
import type { PlacementData, PlacementResult } from "@/lib/types";

const data = placementData as PlacementData;

export default function PlacementPage() {
  const questions = useMemo(() => data.questions, []);
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number | undefined>>({});
  const [result, setResult] = useState<PlacementResult | null>(null);
  const [target, setTarget] = useState(6.5);

  const finish = useCallback(
    (finalAnswers: Record<string, number | undefined>) => {
      const r = scorePlacement(questions, finalAnswers);
      setPlacement(r);
      setResult(r);
    },
    [questions],
  );

  const onExpire = useCallback(() => {
    finish(answers);
  }, [answers, finish]);

  if (result) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="card flex flex-col items-center gap-4 py-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">Your estimated IELTS band</h1>
          <BandBadge band={result.band} />
          <p className="max-w-md text-sm text-slate-600">
            This is a quick estimate from {questions.length} questions — full practice tests in
            each module will refine it. Set a target band and get your study plan.
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
            <Link
              href="/plan"
              className="btn-primary"
              onClick={() => setTargetBand(target)}
            >
              Build my study plan
            </Link>
          </div>
        </section>

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
                    <div
                      className="h-2 rounded-full bg-indigo-500"
                      style={{ width: `${pct}%` }}
                    />
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
                      {b.correct}/{b.total}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div
                      className="h-2 rounded-full bg-emerald-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-4 py-8 text-center">
          <h1 className="text-[26px] font-semibold text-slate-900">Placement test</h1>
          <p className="text-sm text-slate-600">
            {questions.length} questions, 5 minutes. Questions get progressively harder — from
            elementary to near-native. Answer what you can; guessing is fine. You get an
            estimated IELTS band (1–9) at the end.
          </p>
          <button className="btn-primary" onClick={() => setStarted(true)}>
            Start the test
          </button>
        </div>
      </div>
    );
  }

  const q = questions[index];
  const isLast = index === questions.length - 1;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-500">
          Question {index + 1} of {questions.length}
          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">{q.level}</span>
          <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs capitalize">
            {q.skill}
          </span>
        </span>
        <Timer minutes={5} running onExpire={onExpire} />
      </div>

      <div className="h-1.5 rounded-full bg-slate-100">
        <div
          className="h-1.5 rounded-full bg-indigo-500 transition-all"
          style={{ width: `${((index + 1) / questions.length) * 100}%` }}
        />
      </div>

      <div className="card">
        <p className="mb-4 whitespace-pre-line text-base font-medium text-slate-900">
          {q.question}
        </p>
        <div className="space-y-2">
          {q.options.map((opt, idx) => (
            <label
              key={idx}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                answers[q.id] === idx
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name={q.id}
                checked={answers[q.id] === idx}
                onChange={() => setAnswers((a) => ({ ...a, [q.id]: idx }))}
                className="accent-indigo-600"
              />
              <span className="text-slate-700">{opt}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex justify-between">
        <button
          className="btn-secondary"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Back
        </button>
        {isLast ? (
          <button className="btn-primary" onClick={() => finish(answers)}>
            Finish and see my band
          </button>
        ) : (
          <button className="btn-primary" onClick={() => setIndex((i) => i + 1)}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
