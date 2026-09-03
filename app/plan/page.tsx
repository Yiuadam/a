"use client";

import Link from "next/link";
import { useMemo } from "react";
import BandBadge from "@/components/BandBadge";
import GlassSelect from "@/components/GlassSelect";
import { useProfile } from "@/lib/hooks";
import { buildPlan, listJoin, PLAN_DURATIONS } from "@/lib/plan";
import { setPlanDays, setTargetBand } from "@/lib/store";

export default function PlanPage() {
  const profile = useProfile();
  const plan = useMemo(() => buildPlan(profile), [profile]);

  if (!plan) {
    return (
      <div className="mx-auto flex min-h-[45vh] max-w-xl items-center">
        <div className="card w-full space-y-3 py-6 text-center">
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
    <div className="space-y-2.5">
      {/*
        Heading, both menus and the two bands on one line, the summary under
        them. The two bands used to be full-size circles with captions beneath,
        stacked beside a column of everything else — a third of a laptop screen
        spent on two numbers before the plan itself began.
      */}
      <section className="card !p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <h1 className="text-xl font-semibold text-slate-900 sm:text-[1.375rem]">
            Your {plan.duration.heading} study plan
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/*
              Two menus, each saying what it is for. They are <label>s rather
              than the loose <span> the target band had on its own: with a
              second combobox beside it, "select, select" is all a screen
              reader had left to go on.
            */}
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <span>Target band</span>
              <GlassSelect label="Target band" value={String(plan.targetBand)} options={[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((band) => ({ value: String(band), label: String(band) }))} onValueChange={(value) => setTargetBand(Number(value))} compact className="w-24" />
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <span>Plan length</span>
              <GlassSelect label="Plan length" value={String(plan.duration.days)} options={PLAN_DURATIONS.map((duration) => ({ value: String(duration.days), label: duration.label }))} onValueChange={(value) => setPlanDays(Number(value))} compact className="w-32" />
            </div>
            <span className="flex items-center gap-2">
              <BandBadge band={plan.currentBand} size="sm" />
              <span className="text-xs leading-4 text-slate-500">
                Current
                <br />
                estimate
              </span>
            </span>
            <span className="text-xl text-slate-300">→</span>
            <span className="flex items-center gap-2">
              <BandBadge band={plan.targetBand} size="sm" />
              <span className="text-xs leading-4 text-slate-500">Target</span>
            </span>
          </div>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">{plan.headline}</p>
      </section>

      {plan.weakSkills.length > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm leading-6 text-amber-900">
          Your placement showed <span className="font-semibold">{listJoin(plan.weakSkills)}</span>{" "}
          need{plan.weakSkills.length > 1 ? "" : "s"} the most work, so the plan puts extra practice
          there.
        </p>
      )}

      {/*
        Four blocks across a laptop rather than two rows of two: the plan is a
        sequence, and a sequence you can see all of at once is a plan rather
        than a scroll.
      */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {plan.blocks.map((b) => (
          <section key={b.step} className="card !p-4">
            <div className="flex items-baseline gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[0.6875rem] font-bold text-accent-fg">
                {b.step}
              </span>
              <h2 className="text-sm font-semibold text-slate-900">
                {b.label}: {b.focus}
              </h2>
            </div>
            <p className="mb-2 mt-1 text-xs leading-5 text-slate-600">{b.rationale}</p>
            <ul className="plan-task-list space-y-1.5">
              {b.tasks.map((t, i) => (
                <li key={i}>
                  <Link
                    href={t.href}
                    className="flex items-start gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs leading-5 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/50"
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

      <p className="text-xs leading-5 text-slate-400">{plan.rhythm}</p>
    </div>
  );
}
