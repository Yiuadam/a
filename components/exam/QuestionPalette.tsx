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
    thick border       where you are now

  The last one was a ring drawn outside the box, and it looked like brackets
  around the number rather than part of it. Thickening the box's own edge says
  the same thing without adding a shape — which matters here more than usual,
  because the flag is *already* a shape change and two shape languages in one
  strip is one too many.

  ---------------------------------------------------------------------------
  What Review is for

  A candidate who is unsure of question 12 should not spend three minutes on it
  with 28 questions unread. Flagging it and moving on is the single most useful
  habit in a timed reading paper, and the exam gives it a button.

  It only earns that button if coming back is easy, which the first version of
  this got wrong: it changed a square to a circle and offered no way to reach
  the circles. So the bar now also counts them and steps through them — flag
  four questions, then press the count to visit them in turn.
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
      {/*
        Review sits bottom-left, where the exam puts it. It flags the question
        you are on, which is why it says which one — a button labelled only
        "Review" beside forty numbers is ambiguous about what it acts on.

        The label says what pressing it will do rather than what it is called,
        because "Review Q1" reads as a command to review question 1 and that is
        not what happens.
      */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleReview}
          disabled={!current}
          title="Mark this question to come back to it"
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
            current?.flagged
              ? "border-[color:var(--exam-fg)] bg-[color:var(--exam-fg)] text-[color:var(--exam-bg)]"
              : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]"
          }`}
          aria-pressed={current?.flagged ?? false}
        >
          {current?.flagged ? `Unflag Q${current.number}` : `Flag Q${current?.number ?? ""}`}
        </button>

        {/*
          Only once there is something to come back to. A counter reading zero
          is a control that does nothing, sitting next to one that does.
        */}
        {flaggedCount > 0 && (
          <button
            type="button"
            onClick={onNextFlagged}
            title="Go to the next flagged question"
            className="rounded-lg border border-[color:var(--exam-line)] px-2 py-1.5 text-xs font-semibold text-[color:var(--exam-fg)] transition-colors hover:bg-[color:var(--exam-hover)]"
          >
            {flaggedCount} flagged ›
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
                  (item.flagged ? ", flagged for review" : "")
                }
                className={[
                  "flex h-7 w-7 items-center justify-center text-xs font-semibold tabular-nums transition-colors",
                  /* Shape carries the flag — see the note at the top. */
                  item.flagged ? "rounded-full" : "rounded-lg",
                  item.answered
                    ? "border-[color:var(--exam-fg)] bg-[color:var(--exam-fg)] text-[color:var(--exam-bg)]"
                    : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]",
                  /* Where you are: the box's own edge, thickened. See above. */
                  isCurrent ? "border-[2.5px] border-[color:var(--exam-accent)]" : "border",
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
