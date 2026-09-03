"use client";

import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import CardIcon from "@/components/CardIcon";
import { buildPlan } from "@/lib/plan";
import type { Profile } from "@/lib/types";

/*
  What to do next, on the page a learner lands on.

  The plan already exists and is good; the trouble was that reaching it meant
  knowing it was there. This shows the first two blocks of it — enough to start
  an evening without deciding anything — and hands the rest to /plan.

  Two, not five. A dashboard that lists a whole week of study is a week of
  study to read before doing any of it, and the block after next is not a
  decision anybody makes tonight.
*/
export default function PlanCard({ profile }: { profile: Profile }) {
  const plan = buildPlan(profile);

  return (
    <section className="card flex h-full min-w-0 flex-col !p-4" aria-labelledby="dashboard-plan-heading">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dashboard-plan-heading" className="text-[0.9375rem] font-semibold text-slate-900">
            What to do next
          </h2>
          <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-5 text-slate-500">
            {plan
              ? plan.headline
              : "Sit a placement test and BandUp builds a plan around the band it finds."}
          </p>
        </div>
        <CardIcon name="plan" size={20} />
      </div>

      {plan ? (
        <>
          <ul className="mt-3 min-w-0 flex-1 space-y-1.5">
            {plan.blocks.slice(0, 2).map((block) => (
              <li
                key={block.step}
                className="min-w-0 rounded-lg px-1.5 py-1 text-[0.875rem] leading-5 text-slate-700"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-400">
                    {block.label}
                  </span>
                  <span className="truncate font-medium capitalize text-slate-900">{block.focus}</span>
                </span>
                <span className="mt-0.5 block truncate text-[0.8125rem] text-slate-500">
                  {block.tasks[0]?.label ?? plan.rhythm}
                </span>
              </li>
            ))}
          </ul>
          <IntentPrefetchLink href="/plan" className="btn-secondary mt-3 w-full !min-h-9 text-[0.875rem]">
            Open your plan
          </IntentPrefetchLink>
        </>
      ) : (
        <IntentPrefetchLink href="/placement" className="btn-primary mt-3 w-full !min-h-9 text-[0.875rem]">
          Find your band
        </IntentPrefetchLink>
      )}
    </section>
  );
}
