"use client";

import ExplainText from "@/components/ExplainText";
import type { CriterionGrade, WritingResultAttempt, WritingTask } from "@/lib/types";

/*
  The two modules a person marks, reported at the same weight as the two a
  table marks.

  Listening and Reading get forty verdicts and two tallies each, and it would
  be easy for Writing and Speaking to end up as a band and a shrug underneath
  them. They are half the exam. So the examiner's four criteria are printed
  with their bands and its own comment on each, its strengths and improvements
  are printed whole, and the rewritten excerpt — the one place a learner is
  shown their own sentence done better — is given a box of its own rather than
  a line at the bottom.

  Nothing here is written by this screen. Every sentence in it came back from
  the marker about this candidate's essay, which is the same rule the objective
  modules follow: the report says what the sitting said.
*/

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function Criteria({ criteria }: { criteria: CriterionGrade[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {criteria.map((criterion) => (
        <li key={criterion.name} className="rounded-xl border border-slate-200 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <strong className="text-sm text-slate-900">{criterion.name}</strong>
            <span className="font-semibold tabular-nums text-slate-900">{criterion.band}</span>
          </div>
          <ExplainText
            text={criterion.comment}
            className="mt-1 block text-sm leading-6 text-slate-600"
          />
        </li>
      ))}
    </ul>
  );
}

function Lists({ strengths, improvements }: { strengths: string[]; improvements: string[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
          ✓ Going well
        </h4>
        <ul className="mt-2 space-y-1.5">
          {strengths.map((item) => (
            <li key={item} className="text-sm leading-6 text-slate-700">
              {item}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          → Work on
        </h4>
        <ul className="mt-2 space-y-1.5">
          {improvements.map((item) => (
            <li key={item} className="text-sm leading-6 text-slate-700">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function WritingReport({
  tasks,
  attempts,
  essays,
  unmarked,
}: {
  tasks: WritingTask[];
  /** The graded tasks, which may be fewer than the tasks that were set. */
  attempts: WritingResultAttempt[];
  essays: Record<string, string>;
  unmarked: boolean;
}) {
  return (
    <>
      {unmarked && (
        <div className="card">
          <p className="text-sm leading-6 text-slate-600">
            Writing was not marked for this sitting. It is marked by the AI examiner, so a plan
            without AI marking — or an examiner that could not be reached — leaves this module
            without a band. What you wrote is below, and the rest of your report is unaffected.
          </p>
        </div>
      )}
      {tasks.map((task) => {
        const written = essays[task.id] ?? "";
        const count = words(written);
        const attempt = attempts.find((a) => a.task.id === task.id);
        return (
          <section key={task.id} className="card space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                Task {task.task}
                {attempt ? ` · band ${attempt.grade.overallBand}` : ""}
              </p>
              <h3 className="mt-1 text-base font-semibold text-slate-900">{task.title}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">{task.prompt}</p>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {count === 0
                  ? "You wrote nothing for this task."
                  : count < task.minWords
                    ? `${count} words. The task asks for at least ${task.minWords}, and an answer under that length loses marks whatever it says.`
                    : `${count} words, against the ${task.minWords} the task asks for.`}
              </p>
            </div>

            {attempt ? (
              <>
                <Criteria criteria={attempt.grade.criteria} />
                <Lists
                  strengths={attempt.grade.strengths}
                  improvements={attempt.grade.improvements}
                />
                {attempt.grade.rewrittenExcerpt && (
                  <div className="rounded-xl bg-indigo-50/70 p-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                      One of your sentences, written better
                    </h4>
                    <ExplainText
                      text={attempt.grade.rewrittenExcerpt}
                      className="mt-1 block text-sm leading-6 text-slate-700"
                    />
                  </div>
                )}
              </>
            ) : count > 0 ? (
              <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm leading-6 text-slate-600">
                This task was not marked, so there is no feedback on it.
              </p>
            ) : null}

            {count > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-indigo-600">
                  Read what you wrote
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                  {written}
                </p>
              </details>
            )}
          </section>
        );
      })}
    </>
  );
}

export function SpeakingReport({ band }: { band: number | null }) {
  return (
    <div className="card">
      {band === null ? (
        <p className="text-sm leading-6 text-slate-600">
          Speaking was not marked for this sitting. The interview is marked by the AI examiner, so
          a plan without AI marking — or an examiner that could not be reached — leaves this
          module without a band. The rest of your report is unaffected.
        </p>
      ) : (
        <p className="text-sm leading-6 text-slate-600">
          The examiner marked your interview at band{" "}
          <span className="font-semibold text-slate-900">{band}</span>. Its notes on your fluency,
          vocabulary, grammar and pronunciation were shown to you as the interview ended; this
          report keeps the band they came to.
        </p>
      )}
    </div>
  );
}
