import type { ReactNode } from "react";

/*
  A card that says the list is not finished.

  A learner who works through everything on a page and finds nothing after it
  has no way to tell the difference between "that is all there will ever be"
  and "that is all there is so far". The first is a reason to stop using the
  app; the second is a reason to come back. They look identical at the bottom
  of a grid, so the difference has to be said.

  Drawn as a card in the same grid rather than as a line of text underneath,
  because that is where the eye is already going — somebody reaching the end of
  a list of cards is looking at cards, not at the paragraph below them.

  Deliberately not a promise with a date on it. "More are being written" is
  true and stays true; "new papers every Friday" is a commitment this app has
  no way to keep, and a missed one costs more trust than the reassurance was
  worth.
*/

export default function MoreComing({
  what,
  children,
}: {
  /** What there will be more of, plural and lower case: "reading papers". */
  what: string;
  /** An optional extra line — a nudge towards something to do meanwhile. */
  children?: ReactNode;
}) {
  return (
    <div className="practice-paper-card flex flex-col justify-center rounded-2xl border border-dashed border-slate-300 bg-surface/40 p-4 text-center">
      <span
        aria-hidden="true"
        className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500"
      >
        {/* A plus, because the card is about addition rather than absence. */}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <p className="mt-2 text-sm font-semibold text-slate-700">More {what} on the way</p>
      <p className="mt-0.5 text-xs leading-5 text-slate-500">
        New ones are written and added regularly — this is not the whole set.
      </p>
      {children}
    </div>
  );
}
