"use client";

import Link from "next/link";
import type { Route } from "next";
import CardIcon, { type CardIconName } from "@/components/CardIcon";
import LoadingIndicator from "@/components/LoadingIndicator";

/*
  A page that is a menu, and the rows it is made of.

  ---------------------------------------------------------------------------
  Why the app has this at all

  Because the owner named the problem exactly: "instead of stacking all the
  information in one page — I don't want that ever happened, it doesn't work
  that way." Three screens had grown that shape. Bill and usage was owner
  controls, then a wiring check, then a plan, then five usage bars, then a
  fold-out of plan features, 1908 pixels on a phone. The account page was
  3049. Both were built by adding one more true thing under the last one,
  which is how every long page in the world gets made.

  Height is only the symptom. The real cost is that a stacked page has no
  answer to "where am I" — everything is equally present, so nothing is, and
  finding the one control you came for means reading past four you didn't. A
  menu answers it before you tap: you are choosing, and then you are in one
  place looking at one thing.

  ---------------------------------------------------------------------------
  Real routes, not a state variable

  Each row goes to its own address. That is more files than switching a
  `section` state, and it buys the two things a phone needs most: the system
  back gesture returns you to the menu instead of leaving the app entirely,
  and every screen can be linked to, titled and reloaded on its own.

  ---------------------------------------------------------------------------
  The right-hand value

  A row may show what it is worth knowing without opening — the plan you are
  on, how much of an allowance is gone, whether the site is open. That is what
  keeps the menu from being a tax: the common question is answered on the menu
  itself, and tapping is for when the answer prompts a second one.
*/

export interface HubItem {
  href: Route;
  /** A decorative visual cue; the adjacent title remains the accessible name. */
  icon?: CardIconName;
  /** The subject, in the fewest words that name it. */
  title: string;
  /** One line on what is inside. Not a sentence about why it matters. */
  detail: string;
  /** The answer to the obvious question, shown without opening the row. */
  value?: string;
  /** Indicates that `value` describes work that is currently in progress. */
  valueLoading?: boolean;
  /**
   * Most values belong on the far edge of a menu row. A long identifier such
   * as an email needs the available text column instead, otherwise it steals
   * the title's width and makes a compact card grow into a tall panel.
   */
  valuePlacement?: "edge" | "below";
  /** Draws the value as something that wants attention rather than as a fact. */
  tone?: "plain" | "warn";
  /** Owner-only rows are marked, so the owner can see which is which. */
  badge?: string;
}

export function HubMenu({ items }: { items: HubItem[] }) {
  return (
    /*
      One column on a phone, two from `sm`. A menu row is a target before it is
      a paragraph, so it never gets narrower than about half a laptop screen —
      three across would make each one a column of wrapped words.
    */
    <ul className="grid gap-2.5 sm:grid-cols-2">
      {items.map((item) => (
        /*
          `min-w-0` because a grid item's floor is its content, not its column.
          The row below carries a value that can be an email address, and an
          address longer than about 38 characters pushed every card on the
          account page past the right edge of a phone — the whole page scrolled
          sideways and the chevrons went off-screen.
        */
        <li key={item.href} className="min-w-0">
          <Link
            href={item.href}
            prefetch={false}
            className="card hub-menu-card flex h-full min-h-[6.25rem] items-center gap-3 !px-4 !py-3.5 active:translate-y-px sm:min-h-[7.25rem]"
          >
            {item.icon && <CardIcon name={item.icon} size={27} />}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[0.9375rem] font-semibold text-slate-900">{item.title}</span>
                {item.badge && (
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-indigo-800">
                    {item.badge}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[0.8125rem] leading-5 text-slate-500">
                {item.detail}
              </span>
              {item.value && item.valuePlacement === "below" && (
                <span
                  title={item.value}
                  className="mt-1 block truncate text-[0.8125rem] font-medium text-slate-700"
                >
                  {item.value}
                </span>
              )}
            </span>

            {item.value && item.valuePlacement !== "below" && (
              <span
                title={item.value}
                /*
                  Allowed to shrink and ellipsise rather than hold its full
                  width. Counts — "3 left", "Standard" — are far short of the
                  cap and are unaffected; an email address is what this is for,
                  and the full value stays available on hover and to a screen
                  reader through the title.
                */
                className={`min-w-0 max-w-[55%] truncate text-[0.8125rem] font-medium tabular-nums ${
                  item.tone === "warn" ? "text-amber-700" : "text-slate-700"
                }`}
              >
                {item.valueLoading ? <LoadingIndicator label={item.value} /> : item.value}
              </span>
            )}
            <span aria-hidden="true" className="shrink-0 text-slate-300">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/*
  The frame every screen a row opens sits in.

  The back link is a link and not a history call, because the two are different
  promises. `history.back()` returns you to wherever you came from, which on a
  screen somebody arrived at from a search result or a bookmark is somewhere
  else entirely; a link to the menu always means the menu.
*/
export function HubScreen({
  back,
  backLabel,
  title,
  lead,
  className = "",
  children,
}: {
  back: Route;
  backLabel: string;
  title: string;
  lead?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`mx-auto w-full max-w-2xl space-y-5 ${className}`}>
      <div className="space-y-2">
        <Link
          href={back}
          className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          <span aria-hidden="true">‹</span> {backLabel}
        </Link>
        <h1 className="text-[1.375rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
          {title}
        </h1>
        {lead && <p className="text-[0.875rem] leading-6 text-slate-600">{lead}</p>}
      </div>
      {children}
    </div>
  );
}
