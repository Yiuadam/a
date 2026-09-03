import type { ReactNode } from "react";

/*
  One number, said once.

  The pattern the owner asked for — a tile with an icon, a big figure and a
  label — with one deliberate omission: there is no percentage-change chip. The
  dashboards this is modelled on all carry one, and on a product with a handful
  of subscribers it would read "+100%" for a single signup and "-50%" for a
  single cancellation. A number that swings wildly on noise is worse than no
  number, because it invites a decision.

  When there is enough volume for a trend to mean something, this is where it
  goes.
*/

export default function StatCard({
  label,
  value,
  hint,
  icon,
  unavailable,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ReactNode;
  /** Why this number could not be read, if it could not. */
  unavailable?: string;
}) {
  return (
    /*
      A row, not a column.

      The tall version — a 44-pixel glyph, then the figure, then the label —
      cost about 180 pixels each, and four of them took a fifth of a laptop
      screen to say four numbers. On a console the numbers are the thing you
      glance at on the way to the controls, and the controls were the part
      being pushed off the bottom.

      Laid out sideways it is 72. The glyph shrinks and moves beside the
      figure, where it still separates one tile from the next at a glance and
      no longer claims a line of its own.
    */
    <div className="card flex min-h-[4.75rem] items-center gap-3 rounded-2xl border border-slate-200 bg-surface p-3 sm:gap-3.5 sm:p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100/70 text-indigo-700">
        {icon}
      </span>

      <div className="min-w-0">
        {unavailable ? (
          <>
            {/*
              Not a zero. "No subscribers" and "we could not ask Stripe" are
              very different mornings, and a dashboard that renders the second
              as the first is one somebody acts on.
            */}
            <p className="text-[0.875rem] font-medium text-slate-400">Unavailable</p>
            <p className="mt-0.5 text-[0.6875rem] leading-4 text-slate-400">{unavailable}</p>
          </>
        ) : (
          <>
            <p className="text-[1.375rem] font-semibold leading-none tracking-tight text-slate-900 tabular-nums">
              {value}
            </p>
            <p className="mt-1 truncate text-[0.75rem] leading-4 text-slate-500">{label}</p>
            {hint && <p className="hidden text-[0.6875rem] leading-4 text-slate-400 xl:block">{hint}</p>}
          </>
        )}
      </div>
    </div>
  );
}
