"use client";

import { useEffect, useRef } from "react";
import { scrollBehaviour } from "@/lib/exam/reading-position";

/*
  The bottom question strip uses one plain learner-facing concept: "hard".
  Pressing the button marks the current question blue and the number stays blue
  until it is pressed again, so a question worth coming back to can be found at
  a glance and reached with one tap. The number keeps the same shape in every
  state, so marking a question never looks like a layout change or a new
  control.

  The highlighted number is not a cursor the learner has to drive. It reports
  the paper: whichever question is at the reading line is the one lit here, so
  scrolling down to 23 lights 23 — see lib/exam/reading-position.ts. That is
  also why this component has to scroll itself. Forty numbers do not fit across
  a phone, and a strip that highlighted 23 while showing 1 to 12 would be
  highlighting nothing the learner can see.
*/

export interface PaletteItem {
  id: string;
  /** The number the candidate sees. Continuous across a whole paper, 1..40. */
  number: number;
  answered: boolean;
  flagged: boolean;
}

export default function QuestionPalette({
  items,
  currentId,
  onJump,
  onPrev,
  onNext,
  onToggleReview,
}: {
  items: PaletteItem[];
  currentId: string | null;
  onJump: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleReview: () => void;
}) {
  const current = items.find((i) => i.id === currentId) ?? null;

  const strip = useRef<HTMLOListElement | null>(null);
  const lit = useRef<HTMLButtonElement | null>(null);

  /*
    Bring the highlighted number into the strip's own view.

    Deliberately the strip's scroll and not `scrollIntoView`, which would also
    walk up the tree and scroll whatever ancestors it decided needed moving —
    on a bar pinned to the bottom of the exam frame that means scrolling the
    page underneath the learner to reveal a bar that was already on screen.
  */
  useEffect(() => {
    const list = strip.current;
    const button = lit.current;
    if (!list || !button) return;

    const track = list.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    /* Already readable where it is. Moving it would be motion for its own
       sake, and during a scroll that is motion on top of motion. */
    if (box.left >= track.left && box.right <= track.right) return;

    list.scrollTo({
      left: list.scrollLeft + box.left - track.left - (track.width - box.width) / 2,
      behavior: scrollBehaviour(),
    });
  }, [currentId]);

  return (
    /*
      The bottom margin clears the home indicator, which is this bar's own job
      now: Capacitor no longer insets the web view for the safe area, because
      the header already reserved the notch and the app was paying for it twice.
      Without this the question numbers sit in the indicator's strip and the
      screen's rounded corner cuts the first and last of them.

      max() rather than an addition, so a device without an indicator keeps the
      0.5rem this bar was drawn with instead of gaining a gap for nothing.
    */
    <div
      className="exam-glass mx-2 flex items-center gap-3 rounded-xl border px-2.5 py-2 sm:rounded-2xl sm:px-3"
      style={{ marginBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleReview}
          disabled={!current}
          title={
            current?.flagged
              ? "Remove the hard mark from this question"
              : "Mark this question as hard and return to it later"
          }
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
            current?.flagged
              ? "border-[color:var(--exam-hard)] bg-[color:var(--exam-hard)] text-white"
              : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]"
          }`}
          aria-pressed={current?.flagged ?? false}
        >
          {current?.flagged ? `Q${current.number} marked hard` : `Mark Q${current?.number ?? ""} hard`}
        </button>
      </div>

      {/*
        The numbers. Scrolls sideways rather than wrapping, because forty
        buttons wrapped onto four rows on a phone would push the questions off
        the screen — and the exam's strip is one line.
      */}
      <ol
        ref={strip}
        /* No rubber band at either end of the numbers. A scroller bounces to
           say you have reached the end of something, and here the end is a
           question number with the arrows beside it already saying the same
           thing — so the bounce only made a fixed strip inside a fixed bar feel
           loose. It matters more in the app than in a browser: there the bar is
           the app's own bottom edge rather than part of a document. */
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-none py-0.5"
      >
        {items.map((item, index) => {
          const isCurrent = item.id === currentId;
          /*
            The label that starts a part, as the exam's own strip prints it:
            "Part 1: 1 2 3 …". A sitting renames every question after the paper
            it came from — `listening-12:q1` — so the paper changes exactly
            where the prefix does, and the parts fall out of the ids without
            anything having to be threaded down here. A practice paper has no
            prefix and so gets one unnamed group, which is right: there is only
            one part, and printing "Part 1:" over the whole strip would be
            naming a division that does not exist.
          */
          const paper = item.id.includes(":") ? item.id.slice(0, item.id.lastIndexOf(":")) : null;
          const previous = index > 0 ? items[index - 1].id : null;
          const previousPaper =
            previous && previous.includes(":") ? previous.slice(0, previous.lastIndexOf(":")) : null;
          const startsPart = paper !== null && paper !== previousPaper;
          const partNumber = startsPart
            ? new Set(
                items
                  .slice(0, index + 1)
                  .map((i) => (i.id.includes(":") ? i.id.slice(0, i.id.lastIndexOf(":")) : ""))
                  .filter(Boolean),
              ).size
            : 0;
          return (
            <li key={item.id} className="flex shrink-0 items-center gap-1">
              {startsPart && (
                <span className="ml-1 shrink-0 text-xs font-semibold text-[color:var(--exam-fg)] first:ml-0">
                  Part {partNumber}:
                </span>
              )}
              <button
                type="button"
                ref={isCurrent ? lit : null}
                onClick={() => onJump(item.id)}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={
                  `Question ${item.number}` +
                  (item.answered ? ", answered" : ", not answered") +
                  (item.flagged ? ", marked hard" : "")
                }
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-lg border text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--exam-accent)]",
                  item.flagged
                    ? "border-[color:var(--exam-hard)] bg-[color:var(--exam-hard)] text-white"
                    : item.answered
                      ? "border-[color:var(--exam-fg)] bg-[color:var(--exam-fg)] text-[color:var(--exam-bg)]"
                      : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]",
                  isCurrent
                    ? "ring-2 ring-inset ring-[color:var(--exam-accent)]"
                    : "",
                ].join(" ")}
              >
                {item.number}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous question"
          className="rounded-lg border border-[color:var(--exam-line)] px-2.5 py-1.5 text-sm text-[color:var(--exam-fg)] transition-colors hover:bg-[color:var(--exam-hover)]"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next question"
          className="rounded-lg border border-[color:var(--exam-line)] px-2.5 py-1.5 text-sm text-[color:var(--exam-fg)] transition-colors hover:bg-[color:var(--exam-hover)]"
        >
          ›
        </button>
      </div>
    </div>
  );
}
