"use client";

import { useState, type ReactNode } from "react";
import type { Tally } from "@/lib/exam/breakdown";

/*
  One module of the report, folded away until it is wanted.

  ---------------------------------------------------------------------------
  Why these are collapsed rather than stacked

  The full report is four bands, eighty marked questions with their
  explanations, two graded essays and the material all of it came from. Printed
  as one column that is a screen a phone scrolls through for the better part of
  a minute before it reaches the reading paper, with nothing along the way to
  say how much further it goes.

  So each module is a fold, and the fold's own heading carries what a candidate
  reads first: the band, the raw score behind it, and how many marks the next
  half band would have taken. Nothing that matters is hidden by being closed —
  behind the fold is the working, and the working is what you open when you
  want to know why.

  The body mounts only while it is open, which is not premature. The two
  objective modules render eighty question cards between them, each with its
  answer controls and its explanation, and building all of that for a fold
  nobody opened is the difference between this screen arriving and this screen
  arriving eventually.

  ---------------------------------------------------------------------------
  Why the fold is not a <details>

  Because the body has to be a sibling of the heading rather than a child of
  it. A `.card` sets a generous inline padding on purpose, and a question card
  nested inside a module card would be paying it twice — at 390px that leaves a
  multiple-choice option about two hundred and sixty pixels to live in. Keeping
  the questions at page width makes the marked paper here look like the marked
  paper after a practice test, which is the same thing and should read as it.
*/

export function TallyList({ tallies }: { tallies: Tally[] }) {
  return (
    <ul className="space-y-2.5">
      {tallies.map((t) => {
        const share = t.total > 0 ? t.right / t.total : 0;
        const perfect = t.total > 0 && t.right === t.total;
        return (
          <li key={t.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs leading-5 text-slate-600">{t.label}</span>
              <span
                className={`shrink-0 text-xs font-semibold tabular-nums ${
                  perfect ? "text-emerald-700" : "text-slate-800"
                }`}
              >
                {t.right}/{t.total}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full ${perfect ? "bg-emerald-500" : "bg-indigo-500"}`}
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function ModuleSection({
  title,
  band,
  raw,
  total,
  note,
  openLabel = "See every question",
  children,
}: {
  title: string;
  /** null for a module that could not be marked. The fold still opens. */
  band: number | null;
  raw?: number;
  total?: number;
  /** One line under the title: what the paper was, and how far the next band is. */
  note?: ReactNode;
  openLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="card flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold text-slate-900">{title}</span>
          {note && <span className="mt-1 block text-xs leading-5 text-slate-500">{note}</span>}
          <span className="mt-2 block text-xs font-medium text-indigo-600">
            {open ? "Hide the detail" : openLabel}
          </span>
        </span>
        <span className="shrink-0 text-right">
          {band === null ? (
            <span className="text-xs text-slate-400">not marked</span>
          ) : (
            <>
              <span className="block text-3xl font-semibold leading-8 tabular-nums text-slate-900">
                {band.toFixed(band % 1 === 0 ? 0 : 1)}
              </span>
              {total !== undefined && raw !== undefined && (
                <span className="block text-xs tabular-nums text-slate-500">
                  {raw} of {total} marks
                </span>
              )}
            </>
          )}
        </span>
      </button>
      {open && children}
    </section>
  );
}
