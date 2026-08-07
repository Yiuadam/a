"use client";

import ExplainText from "@/components/ExplainText";
import type { AdviceReport } from "@/lib/advice";

export interface ReviewItem {
  id: string;
  prompt: string;
  /** What the learner put. Empty string means they left it blank. */
  yourAnswer: string;
  correctAnswer: string;
  explanation?: string;
  tag?: string;
}

function Bullets({
  title,
  icon,
  tone,
  items,
}: {
  title: string;
  icon: string;
  tone: "good" | "improve";
  items: string[];
}) {
  const colour = tone === "good" ? "text-emerald-700" : "text-indigo-700";
  return (
    <div>
      <h3 className={`text-xs font-semibold uppercase tracking-wide ${colour}`}>
        {icon} {title}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((line, i) => (
          <li key={i} className="text-sm font-medium text-slate-800">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The part of a test that actually teaches: every question you got wrong, what
 * the answer was, and why. Marks on their own tell a learner where they are;
 * only the explanation tells them how to move.
 */
export default function Review({
  items,
  advice,
  total,
}: {
  items: ReviewItem[];
  advice: AdviceReport;
  total: number;
}) {
  return (
    <section className="space-y-4" data-lookupable>
      <div className="card grid gap-6 sm:grid-cols-2">
        <Bullets title="Going well" icon="✓" tone="good" items={advice.good} />
        <Bullets title="Work on" icon="→" tone="improve" items={advice.improve} />
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Review your mistakes</h2>
          <span className="text-xs text-slate-500">
            {items.length} of {total}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Tap any underlined word for a plain-English meaning — or select any other word to
          look it up.
        </p>

        {items.length === 0 ? (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
            Nothing to review — you answered every question correctly. Move up to a harder
            test so the practice keeps stretching you.
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border border-slate-200 bg-surface p-4">
                {item.tag && (
                  <span className="mb-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs capitalize text-slate-600">
                    {item.tag}
                  </span>
                )}
                <p className="whitespace-pre-line text-sm font-medium text-slate-900">
                  {item.prompt}
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-rose-500">
                      You put
                    </span>
                    {item.yourAnswer || "— left blank —"}
                  </p>
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-emerald-600">
                      Answer
                    </span>
                    {item.correctAnswer}
                  </p>
                </div>
                {item.explanation && (
                  <ExplainText
                    text={item.explanation}
                    className="mt-3 block text-sm leading-relaxed text-slate-600"
                  />
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
