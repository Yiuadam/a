import type { WritingTask } from "@/lib/types";

/*
  A process diagram for Academic Task 1: stages in order, joined by arrows.

  Drawn rather than listed, because reading the order off a diagram is part of
  what the task tests — a numbered list would hand the candidate the sequence in
  the one form they are being asked to produce it in.

  The arrow is hidden from a screen reader: an ordered list already says these
  are steps in order, and an arrow read aloud between every stage is noise on
  top of that.
*/
export default function ProcessDrawing({
  process,
}: {
  process: NonNullable<WritingTask["process"]>;
}) {
  return (
    <figure className="card">
      {process.title && (
        <figcaption className="mb-3 text-center text-sm font-semibold text-slate-900">
          {process.title}
        </figcaption>
      )}
      {/*
        Down the page, always.

        The first version wrapped the boxes onto as many rows as they needed,
        and every row ended with an arrow pointing at the edge of the card: the
        flow carried on below and the diagram said it carried on to the right.
        A row that scrolls sideways instead is no better — half the process is
        then off-screen while the candidate is describing it, and this figure
        lives inside a split pane, so the width it gets is never the width of
        the window. A column is the one layout that is legible at every size
        and never lies about where the process goes next.
      */}
      <ol className="flex flex-col items-center gap-2">
        {process.stages.map((stage, index) => (
          <li key={stage.label} className="flex flex-col items-center gap-2">
            <div className="w-44 rounded-xl border border-slate-300 bg-surface px-3 py-2 text-center">
              <p className="text-sm font-medium leading-5 text-slate-800">{stage.label}</p>
              {stage.note && (
                <p className="mt-1 text-xs leading-4 text-slate-500">{stage.note}</p>
              )}
            </div>
            {index < process.stages.length - 1 && (
              <span aria-hidden className="text-lg leading-none text-slate-400">
                ↓
              </span>
            )}
          </li>
        ))}
      </ol>
    </figure>
  );
}
