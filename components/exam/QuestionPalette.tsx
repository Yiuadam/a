"use client";

/*
  The bottom question strip uses one plain learner-facing concept: "hard".
  Pressing the button marks the current question blue, and Next hard cycles
  through every blue question. The number keeps the same shape in every state,
  so marking a question never looks like a layout change or a new control.
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
  onNextFlagged,
}: {
  items: PaletteItem[];
  currentId: string | null;
  onJump: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleReview: () => void;
  onNextFlagged: () => void;
}) {
  const current = items.find((i) => i.id === currentId) ?? null;
  const flaggedCount = items.filter((i) => i.flagged).length;

  return (
    <div className="exam-glass mx-2 mb-2 flex items-center gap-3 rounded-xl border px-2.5 py-2 sm:rounded-2xl sm:px-3">
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

        {flaggedCount > 0 && (
          <button
            type="button"
            onClick={onNextFlagged}
            title="Go to the next question marked hard"
            className="rounded-lg border border-[color:var(--exam-hard)] px-2 py-1.5 text-xs font-semibold text-[color:var(--exam-hard)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--exam-hard)_12%,transparent)]"
          >
            Next hard · {flaggedCount}
          </button>
        )}
      </div>

      {/*
        The numbers. Scrolls sideways rather than wrapping, because forty
        buttons wrapped onto four rows on a phone would push the questions off
        the screen — and the exam's strip is one line.
      */}
      <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
        {items.map((item) => {
          const isCurrent = item.id === currentId;
          return (
            <li key={item.id} className="shrink-0">
              <button
                type="button"
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
