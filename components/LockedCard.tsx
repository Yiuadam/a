"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { LockReason } from "@/lib/entitlements/sessions";

/*
  A card you cannot use yet.

  The owner's brief, and it is the right one: tint the whole card and put a
  half-transparent padlock on it, so that being locked is something you see
  rather than something you find out by tapping. A greyed-out button tells you
  at the end of a reach; a tinted card tells you before you start moving.

  ---------------------------------------------------------------------------
  What is deliberately *not* done here

  The content is not hidden or replaced. A locked Writing card still shows that
  it is Writing, still shows what it is for, still shows how long it takes. The
  point of a lock on a shop window is that you can see in — hiding the thing
  behind the lock would make it impossible to want, and wanting it is the whole
  mechanism. It is dimmed rather than blurred for the same reason.

  It is also still one tap, and the tap goes somewhere useful: a visitor lands
  on sign-in, a free account lands on the plans. The lock is the invitation.

  ---------------------------------------------------------------------------
  Accessibility, since a tint is only a tint

  The reason is written in text inside the card ("Sign in to unlock"), not
  carried by the dimming, so it survives greyscale, low vision and a screen
  reader. The whole card is one <Link> with an aria-label that says both what
  the thing is and why it is locked, because "Writing" alone would announce a
  destination that does not exist for this reader. The padlock is aria-hidden:
  it is a second telling of something already said in words.

  Focus is visible on the card itself rather than on anything inside it, so
  tabbing through a grid of half-locked cards behaves like tabbing through a
  grid of cards.
*/

export default function LockedCard({
  reason,
  label,
  fill = false,
  children,
}: {
  reason: Exclude<LockReason, null>;
  /** What is locked, for the screen reader: "Writing practice". */
  label: string;
  /**
   * Stretch to the height of the row.
   *
   * Opt-in, and it must stay that way. As a grid item this link stretches to
   * its row whether it wants to or not, so a locked card in a grid needs
   * h-full to stop its tint and padlock hanging below the card inside it. But
   * a locked panel sitting in a *column* has no row to match, and h-full made
   * it swallow every pixel left in the column — a small form drawn inside an
   * enormous empty box with a padlock floating in the middle of it.
   */
  fill?: boolean;
  children: ReactNode;
}) {
  const href = reason === "sign-in" ? "/account" : "/pricing";
  const line = reason === "sign-in" ? "Sign in to unlock" : "On Standard";
  const said =
    reason === "sign-in"
      ? `${label}. Locked — sign in with a free account to unlock.`
      : `${label}. Locked — included with Standard.`;

  return (
    <Link
      href={href}
      aria-label={said}
      /*
        min-w-0, and the same on the wrapper below.

        This link is a grid item, and a grid item's automatic minimum width is
        its min-content — not zero. The card inside carries `truncate`, which
        sets white-space: nowrap, so its min-content is the *whole* untruncated
        sentence. Without this the column is sized to the longest description
        in the list and every card in it overflows the screen: 654px of card in
        a 320px grid, with the text running off the right edge and the page
        scrolling sideways.

        The same trap has now been hit four times in this codebase, always with
        `truncate` at the bottom of it. If a card here ever stops truncating,
        this is the line to look at first.
      */
      className={`group relative block min-w-0 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${fill ? "h-full" : ""}`}
    >
      {/*
        The card itself, dimmed and desaturated. pointer-events-none so that
        nothing inside it can take the tap — the whole card is one link, and a
        stray button underneath would send a learner somewhere that refuses
        them.
      */}
      <div className={`pointer-events-none min-w-0 select-none opacity-45 grayscale-[35%] ${fill ? "h-full" : ""}`}>
        {children}
      </div>

      {/*
        The tint. A wash of the card's own surface colour rather than grey, so
        a locked card reads as the same object turned off rather than as a
        different, greyer object.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl bg-slate-100/45 ring-1 ring-inset ring-slate-300/60 transition-colors group-hover:bg-slate-100/25"
      />

      {/*
        The padlock and the reason. Half-transparent, as asked, and it lifts on
        hover so the card still answers a pointer the way a card should.

        Centred within the top 24rem rather than within the card. On a card the
        two are the same thing. On a tall panel — a whole writing page drawn
        behind its lock — dead-centre puts the padlock hundreds of pixels down,
        below the fold, marking something the reader has to scroll to find. The
        cap keeps it over the part of the panel they are actually looking at.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-full max-h-96 flex-col items-center justify-center gap-1.5">
        <svg
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-slate-600/70 transition-all group-hover:text-slate-700/90"
        >
          <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
        <span className="rounded-full bg-surface/85 px-2.5 py-0.5 text-xs font-semibold text-slate-700 shadow-sm">
          {line}
        </span>
      </div>
    </Link>
  );
}
