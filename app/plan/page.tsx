"use client";

import Link from "next/link";
import { useMemo } from "react";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import { buildPlan, listJoin } from "@/lib/plan";
import { setTargetBand } from "@/lib/store";

/* Where a band sits on the 1–9 scale, as a percentage of the track. */
function scalePosition(band: number): number {
  return ((Math.max(1, Math.min(9, band)) - 1) / 8) * 100;
}

export default function PlanPage() {
  const profile = useProfile();
  const plan = useMemo(() => buildPlan(profile), [profile]);

  if (!plan) {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-4 py-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">No placement result yet</h1>
          <p className="text-sm leading-6 text-slate-600">
            Your study plan is personalised from your placement test result. Take the 5-minute
            test first.
          </p>
          <Link href="/placement" className="btn-primary">
            Take the placement test
          </Link>
        </div>
      </div>
    );
  }

  const from = scalePosition(plan.currentBand);
  const to = scalePosition(plan.targetBand);

  return (
    <div className="space-y-8">
      <section className="card space-y-7">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-start">
          <div className="min-w-0 max-w-xl space-y-2">
            <h1 className="text-[26px] font-semibold leading-snug text-slate-900">
              Your 4-week study plan
            </h1>
            <p className="text-[15px] leading-7 text-slate-600">{plan.headline}</p>
          </div>
          <div className="flex shrink-0 items-start gap-5">
            <BandBadge band={plan.currentBand} caption="Current estimate" />
            <BandBadge band={plan.targetBand} caption="Target" />
          </div>
        </div>

        {/*
          The gap, drawn. "Band 5.5, target 7" is two numbers a learner has to
          hold in their head; the same thing on a 1–9 track is a distance they
          can see, which is the whole reason the page exists.
        */}
        <div className="space-y-2">
          <div className="relative h-2.5 w-full rounded-full bg-slate-200">
            <span
              className="absolute top-0 h-2.5 rounded-full bg-gradient-to-r from-indigo-500 to-amber-400"
              style={{ left: `${from}%`, width: `${Math.max(0, to - from)}%` }}
            />
            {[from, to].map((pos, i) => (
              <span
                key={i}
                /*
                  `translate-x-[-50%]` is safe against the 375px overflow rule
                  because the track's own edges are inside the card's padding —
                  half a 14px dot cannot reach the viewport edge.
                */
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-indigo-600 shadow-sm"
                style={{ left: `${pos}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span>Band 1</span>
            <span className="text-slate-500">
              {plan.gap === 0
                ? "You are at your target"
                : `${plan.gap} band${plan.gap === 1 ? "" : "s"} to close`}
            </span>
            <span>Band 9</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-200 pt-5">
          <label htmlFor="target-band" className="text-sm font-medium text-slate-700">
            Aiming for
          </label>
          <select
            id="target-band"
            className="input"
            value={plan.targetBand}
            onChange={(e) => setTargetBand(Number(e.target.value))}
          >
            {[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((b) => (
              <option key={b} value={b}>
                Band {b}
              </option>
            ))}
          </select>
          <p className="text-xs leading-5 text-slate-500">The plan rewrites itself as you change this.</p>
        </div>
      </section>

      {plan.weakSkills.length > 0 && (
        <div className="flex gap-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <span className="mt-0.5 shrink-0 text-lg" aria-hidden>
            🎯
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold text-amber-900">Where the plan leans hardest</p>
            <p className="text-sm leading-6 text-amber-900">
              Your placement test showed{" "}
              <span className="font-semibold">{listJoin(plan.weakSkills)}</span> need
              {plan.weakSkills.length > 1 ? "" : "s"} the most work, so extra practice on{" "}
              {plan.weakSkills.length > 1 ? "those" : "that"} is built into the relevant weeks.
            </p>
          </div>
        </div>
      )}

      <section className="space-y-4">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Four weeks, weakest skill first
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {plan.weeks.map((w) => (
            <section key={w.week} className="card">
              <div className="mb-3 flex items-start gap-3">
                <span className="band-disc flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums text-accent-fg">
                  {w.week}
                </span>
                <div className="min-w-0">
                  <h3 className="font-semibold leading-tight text-slate-900">
                    Week {w.week}: {w.focus}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {w.tasks.length} {w.tasks.length === 1 ? "session" : "sessions"} suggested
                  </p>
                </div>
              </div>
              <p className="mb-4 text-sm leading-6 text-slate-600">{w.rationale}</p>
              <ul className="space-y-2">
                {w.tasks.map((t, i) => (
                  <li key={i}>
                    <Link
                      href={t.href}
                      className="group flex items-center gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm leading-6 text-slate-700 transition-colors hover:border-indigo-300 hover:bg-indigo-50/60 hover:text-slate-900"
                    >
                      <span
                        className="mt-px h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400 transition-colors group-hover:bg-indigo-600"
                        aria-hidden
                      />
                      <span className="min-w-0">{t.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>

      <section className="card flex flex-col items-center gap-3 text-center">
        <p className="text-[15px] leading-7 text-slate-700">
          Three to five sessions of 30–60 minutes a week is the rhythm this plan assumes. At the
          end of the cycle, re-take the placement test to see what moved.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/placement" className="btn-primary">
            Re-test my level
          </Link>
          <Link href="/resources" className="btn-secondary">
            Read the exam guides
          </Link>
        </div>
      </section>
    </div>
  );
}
