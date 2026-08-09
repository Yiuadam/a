"use client";

/*
  The strip of numbers along the bottom of the screen.

  This is the part of computer-delivered IELTS that people describe when they
  describe the interface, and the detail that matters most is the one that is
  easiest to get wrong: a flagged question does not change colour, it changes
  *shape*. Answered and unanswered are told apart by fill; flagged for review is
  told apart by the number becoming a circle instead of a square.

  That is worth copying exactly rather than improving on, because shape survives
  what colour does not — a projector, a colourblind reader, a phone in
  sunlight — and because a candidate who has practised on circles will be
  looking for circles on the day.

  Four states, and every one is legible in greyscale:

    plain outline      not answered
    filled             answered
    circle             flagged for review (with or without an answer)
    ring               where you are now
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

  return (
    <div className="flex items-center gap-3 border-t border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 py-2">
      {/*
        Review sits bottom-left, where the exam puts it. It flags the question
        you are on, which is why it says which one — a button labelled only
        "Review" beside forty numbers is ambiguous about what it acts on.
      */}
      <button
        type="button"
        onClick={onToggleReview}
        disabled={!current}
        className={`shrink-0 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
          current?.flagged
            ? "border-[color:var(--exam-fg)] bg-[color:var(--exam-fg)] text-[color:var(--exam-bg)]"
            : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]"
        }`}
        aria-pressed={current?.flagged ?? false}
      >
        Review{current ? ` Q${current.number}` : ""}
      </button>

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
                  (item.flagged ? ", flagged for review" : "")
                }
                className={[
                  "flex h-7 w-7 items-center justify-center border text-xs font-semibold tabular-nums transition-colors",
                  /* Shape carries the flag — see the note at the top. */
                  item.flagged ? "rounded-full" : "rounded-[3px]",
                  item.answered
                    ? "border-[color:var(--exam-fg)] bg-[color:var(--exam-fg)] text-[color:var(--exam-bg)]"
                    : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]",
                  isCurrent ? "outline outline-2 outline-offset-2 outline-[color:var(--exam-accent)]" : "",
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
          className="rounded border border-[color:var(--exam-line)] px-2.5 py-1.5 text-sm text-[color:var(--exam-fg)] transition-colors hover:bg-[color:var(--exam-hover)]"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next question"
          className="rounded border border-[color:var(--exam-line)] px-2.5 py-1.5 text-sm text-[color:var(--exam-fg)] transition-colors hover:bg-[color:var(--exam-hover)]"
        >
          ›
        </button>
      </div>
    </div>
  );
}
