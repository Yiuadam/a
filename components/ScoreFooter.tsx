"use client";

import Link from "next/link";
import { bandLabel } from "@/lib/band";

/*
  The score, and what to do next, at the end of the paper.

  Why this exists: the result card sits at the top of the page, above the
  review, above the passage. The questions are at the bottom. So a learner
  presses "Check my answers" at the bottom of a long page, the page marks
  itself — and nothing visible changes where they are standing. The score, and
  both buttons for what to do next, are a full page-scroll away above them.

  The obvious fix is to scroll them to the top, and it is the wrong one: it
  throws away the position they were reading at and makes the page jump under
  their hands. The score should be where they are, so it is rendered here as
  well as at the top.

  This is deliberately not the same card twice. The one at the top opens the
  review — it is the heading for everything below it. This one closes the
  paper: it states the result in one line, offers the two next steps, and
  points back up to the review for anyone who wants it. Different job, so
  different shape, and the review link is what stops the duplicate score
  reading as a dead end.
*/

export default function ScoreFooter({
  module,
  band,
  raw,
  total,
  reviewId = "review",
}: {
  module: "reading" | "listening";
  band: number;
  raw: number;
  total: number;
  /** Anchor of the review section further up the page. */
  reviewId?: string;
}) {
  return (
    <section
      aria-label="Your score"
      className="card flex flex-col gap-4 border-indigo-200 bg-indigo-50/40 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xl font-bold text-accent-fg shadow-sm">
          {band.toFixed(band % 1 === 0 ? 0 : 1)}
        </div>
        <div>
          <p className="font-semibold text-slate-900">
            Estimated {module} band {band}
            <span className="font-normal text-slate-600"> · {bandLabel(band)}</span>
          </p>
          <p className="mt-0.5 text-sm text-slate-600">
            {raw} of {total} correct.{" "}
            <a
              href={`#${reviewId}`}
              className="font-medium text-indigo-700 underline underline-offset-2"
            >
              Read the review
            </a>{" "}
            to see where the marks went.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Link href="/practice" className="btn-secondary">
          More tests
        </Link>
        <Link href="/plan" className="btn-primary">
          Study plan
        </Link>
      </div>
    </section>
  );
}
