"use client";

import ExplainText from "@/components/ExplainText";
import type { Observation } from "@/lib/exam/breakdown";

/*
  What to work on, said only where the sitting supports saying it.

  The temptation on a results screen is a list that is always four items long,
  because four items look like a plan. What that produces is advice written
  before the candidate sat down — read the questions first, skim for keywords,
  practise every day — and a learner who has just given up an afternoon can
  tell the difference between being read and being handled.

  So the list here is as long as the evidence, and sometimes that is nothing.
  The empty case is a sentence saying the marks did not gather anywhere, which
  is itself a finding: it means there is no shortcut, and the question-by-
  question review below is where the work is.

  Each item is a fact and then a habit. The fact is arithmetic on this
  candidate's own paper — see lib/exam/breakdown.ts for what has to be true
  before one is printed — and the habit is attached to the task the fact named,
  never floated on its own.
*/

export interface PlanGroup {
  title: string;
  observations: Observation[];
}

export default function ImprovementPlan({
  groups,
  fallback,
}: {
  groups: PlanGroup[];
  /** Shown when nothing in the sitting supported an observation. */
  fallback: string;
}) {
  const found = groups.filter((group) => group.observations.length > 0);

  return (
    <section className="card space-y-4">
      <h2 className="text-sm font-semibold text-slate-900">What to work on next</h2>
      {found.length === 0 ? (
        <p className="text-sm leading-6 text-slate-600">{fallback}</p>
      ) : (
        found.map((group) => (
          <div
            key={group.title}
            className="space-y-3 border-t border-slate-100 pt-4 first:border-0 first:pt-0"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
              {group.title}
            </h3>
            <ul className="space-y-4">
              {group.observations.map((observation) => (
                <li key={observation.id}>
                  <p className="text-sm font-medium leading-6 text-slate-900">
                    {observation.fact}
                  </p>
                  {observation.fix && (
                    <ExplainText
                      text={observation.fix}
                      className="mt-1 block text-sm leading-6 text-slate-600"
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
