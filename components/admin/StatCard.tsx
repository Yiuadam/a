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
      Tighter on a phone, and the icon goes with it. Four of these stacked in a
      column cost 600 pixels of an 844-pixel screen to say four numbers; two
      across at this size cost 220. The glyph was never carrying meaning — the
      comment above says as much — so it is the first thing to go when the room
      runs out.
    */
    <div className="rounded-2xl border border-slate-200 bg-surface p-3.5 sm:p-5">
      <span className="hidden h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 sm:flex">
        {icon}
      </span>

      {unavailable ? (
        <>
          {/*
            Not a zero. "No subscribers" and "we could not ask Stripe" are very
            different mornings, and a dashboard that renders the second as the
            first is one somebody acts on.
          */}
          <p className="text-[14px] font-medium text-slate-400 sm:mt-4 sm:text-[15px]">
            Unavailable
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-400 sm:text-xs sm:leading-5">
            {unavailable}
          </p>
        </>
      ) : (
        <>
          <p className="text-[24px] font-semibold leading-none tracking-tight text-slate-900 tabular-nums sm:mt-4 sm:text-[28px]">
            {value}
          </p>
          <p className="mt-1 text-[12px] leading-4 text-slate-500 sm:mt-1.5 sm:text-sm">{label}</p>
          {hint && (
            <p className="mt-0.5 hidden text-xs leading-5 text-slate-400 sm:block">{hint}</p>
          )}
        </>
      )}
    </div>
  );
}
