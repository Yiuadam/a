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
    <div className="rounded-2xl border border-slate-200 bg-surface p-5">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
        {icon}
      </span>

      {unavailable ? (
        <>
          {/*
            Not a zero. "No subscribers" and "we could not ask Stripe" are very
            different mornings, and a dashboard that renders the second as the
            first is one somebody acts on.
          */}
          <p className="mt-4 text-[15px] font-medium text-slate-400">Unavailable</p>
          <p className="mt-0.5 text-xs leading-5 text-slate-400">{unavailable}</p>
        </>
      ) : (
        <>
          <p className="mt-4 text-[28px] font-semibold leading-none tracking-tight text-slate-900 tabular-nums">
            {value}
          </p>
          <p className="mt-1.5 text-sm text-slate-500">{label}</p>
          {hint && <p className="mt-0.5 text-xs leading-5 text-slate-400">{hint}</p>}
        </>
      )}
    </div>
  );
}
