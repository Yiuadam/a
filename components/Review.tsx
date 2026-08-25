"use client";

import type { ReactNode } from "react";
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
  bandBadge,
}: {
  items: ReviewItem[];
  advice: AdviceReport;
  total: number;
  /**
   * A BandBadge (or similar) to show beside the advice card, on pages that
   * don't already show one of their own above this section. The mistakes
   * list below always spans the full width regardless — it's the longest,
   * most-scanned part of the page, and indenting it to match a narrow badge
   * column just wastes the width every other card on the page uses.
   */
  bandBadge?: ReactNode;
}) {
  const adviceCard = (
    <div className="card grid gap-6 sm:grid-cols-2">
      <Bullets title="Going well" icon="✓" tone="good" items={advice.good} />
      <Bullets title="Work on" icon="→" tone="improve" items={advice.improve} />
    </div>
  );

  return (
    /*
      id="review" is what ScoreFooter's "Read the review" link points at. The
      score is shown twice — once heading this section, once at the foot of
      the paper where the learner is standing when it marks — and this anchor
      is what makes the second one a way back rather than a dead end.

      scroll-mt clears the sticky header, which would otherwise cover the
      heading the link just jumped to.
    */
    <section id="review" className="scroll-mt-24 space-y-4" data-lookupable>
      {bandBadge ? (
        <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
          {bandBadge}
          {adviceCard}
        </div>
      ) : (
        adviceCard
      )}

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
          <ol className="mt-3 space-y-2">
            {items.map((item, index) => (
              <li key={item.id}>
                {/*
                  Collapsed by default: a full paper's worth of wrong answers,
                  each with its own explanation, is a wall of text to scroll
                  past to reach the ones a learner actually wants. <details>
                  gets open/close state, a click target, and keyboard support
                  for free, so no state array keyed by item id is needed here.
                */}
                <details className="group rounded-xl border border-slate-200 bg-surface open:pb-4">
                  <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 marker:content-none [&::-webkit-details-marker]:hidden">
                    <span className="mt-px shrink-0 text-xs font-semibold text-slate-400">
                      {index + 1}
                    </span>
                    {item.tag && (
                      <span className="mt-px shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs capitalize text-slate-600">
                        {item.tag}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 whitespace-pre-line text-sm font-medium text-slate-900">
                      {item.prompt}
                    </span>
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="mt-0.5 size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </summary>
                  <div className="px-4">
                    <div className="grid gap-2 sm:grid-cols-2">
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
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
