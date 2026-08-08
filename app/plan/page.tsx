"use client";

import Link from "next/link";
import { useMemo } from "react";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import { buildPlan, listJoin, PLAN_DURATIONS } from "@/lib/plan";
import { setPlanDays, setTargetBand } from "@/lib/store";

export default function PlanPage() {
  const profile = useProfile();
  const plan = useMemo(() => buildPlan(profile), [profile]);

  if (!plan) {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-4 py-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">No placement result yet</h1>
          <p className="text-sm text-slate-600">
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

  return (
    <div className="space-y-6">
      <section className="card flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <div className="max-w-xl space-y-2">
          <h1 className="text-[26px] font-semibold text-slate-900">
            Your {plan.duration.heading} study plan
          </h1>
          <p className="text-sm text-slate-600">{plan.headline}</p>
          {/*
            Two menus now, so each one says what it is for. They are <label>s
            rather than the loose <span> the target band had on its own: with a
            second combobox beside it, "select, select" is all a screen reader
            had left to go on.
          */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <span>Target band</span>
              <select
                className="input"
                value={plan.targetBand}
                onChange={(e) => setTargetBand(Number(e.target.value))}
              >
                {[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span>Plan length</span>
              <select
                className="input"
                value={plan.duration.days}
                onChange={(e) => setPlanDays(Number(e.target.value))}
              >
                {PLAN_DURATIONS.map((d) => (
                  <option key={d.days} value={d.days}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <BandBadge band={plan.currentBand} caption="Current estimate" />
          <span className="text-2xl text-slate-300">→</span>
          <BandBadge band={plan.targetBand} caption="Target" />
        </div>
      </section>

      {plan.weakSkills.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
          Your placement test showed{" "}
          <span className="font-semibold">{listJoin(plan.weakSkills)}</span> need
          {plan.weakSkills.length > 1 ? "" : "s"} the most work, so the plan builds extra
          practice on {plan.weakSkills.length > 1 ? "those" : "that"} into the parts of the
          window where it helps most.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {plan.blocks.map((b) => (
          <section key={b.step} className="card">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-accent-fg">
                {b.step}
              </span>
              <h2 className="font-semibold text-slate-900">{b.label}: {b.focus}</h2>
            </div>
            <p className="mb-3 text-sm text-slate-600">{b.rationale}</p>
            <ul className="space-y-2">
              {b.tasks.map((t, i) => (
                <li key={i}>
                  <Link
                    href={t.href}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/50"
                  >
                    <span className="text-indigo-500">→</span>
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="text-xs text-slate-400">{plan.rhythm}</p>
    </div>
  );
}
