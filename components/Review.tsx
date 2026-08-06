"use client";

export interface ReviewItem {
  id: string;
  prompt: string;
  /** What the learner put. Empty string means they left it blank. */
  yourAnswer: string;
  correctAnswer: string;
  explanation?: string;
  tag?: string;
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
  advice: string[];
  total: number;
}) {
  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-900">What to work on</h2>
        <ul className="mt-3 space-y-2">
          {advice.map((line, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-slate-700">
              <span aria-hidden className="mt-[3px] text-amber-500">
                →
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Review your mistakes</h2>
          <span className="text-xs text-slate-500">
            {items.length} of {total} to look at
          </span>
        </div>

        {items.length === 0 ? (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
            Nothing to review — you answered every question correctly. Move up to a harder
            test so the practice keeps stretching you.
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border border-slate-200 bg-surface p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {item.tag && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs capitalize text-slate-600">
                      {item.tag}
                    </span>
                  )}
                </div>
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
                  <p className="mt-3 text-sm leading-relaxed text-slate-600">
                    {item.explanation}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
