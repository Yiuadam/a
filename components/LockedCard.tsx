"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { LockReason } from "@/lib/entitlements/sessions";
import { IS_MOBILE_BUILD } from "@/lib/platform";

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

  That rule is what decides where the padlock goes on a card, and it was got
  wrong once. A padlock on a plate in the middle of a card sat squarely on top
  of the card's title — so the two cards a visitor most needs to recognise were
  the two that no longer said what they were, which is the exact opposite of
  the point. On a card the padlock is a chip in the corner, where the "New"
  badge goes, and the title and the description stay legible under the tint.
  The tint alone is what says "off"; the chip says why.

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

  ---------------------------------------------------------------------------
  Why a whole page is not one link, and a card is

  A card is a link because a card is one thing you tap, and on a phone the
  whole card is a far better target than a word inside it.

  A whole page drawn behind its lock cannot be, and the reason is not taste:
  the writing page contains links, and the speaking page contains "What that
  means". An <a> inside an <a> is invalid HTML — React logs a hydration error
  and browsers recover from it however they like, so what a tap does stops
  being something anybody can predict. So the page-level lock is a plain
  element, and the only link is the one in the padlock plate. Nothing is lost:
  the content underneath is already pointer-events-none, so it was never the
  tap target anyway.
*/

export default function LockedCard({
  reason,
  label,
  fill = false,
  standoff = false,
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
  /**
   * Hold the tint and its ring away from the content.
   *
   * Off by default, and it has to be. In a grid every cell is the same size, so
   * padding inside a locked cell makes the card *inside* it narrower than its
   * unlocked neighbours and the row stops lining up.
   *
   * On a whole page drawn behind its lock there is no row to line up with, and
   * the opposite problem appears: the ring lands hard against the first
   * heading and the left edge of the prose, so the boundary reads as touching
   * the words rather than framing them. That is what this is for.
   */
  standoff?: boolean;
  children: ReactNode;
}) {
  /*
    On iOS a locked card leads to the account rather than to a price list —
    /pricing is not in that bundle, and a card that says "On Standard" over a
    tappable route to a checkout is the shape review looks for. It still says
    it is locked, which is the honest half. See lib/platform.ts.
  */
  const href = reason === "sign-in" || IS_MOBILE_BUILD ? "/account" : "/pricing";
  const line =
    reason === "sign-in" ? "Sign in to unlock" : IS_MOBILE_BUILD ? "Not on your plan" : "On Standard";
  /** The corner chip's word. A card has room for one, not for a sentence. */
  const short = reason === "sign-in" ? "Sign in" : IS_MOBILE_BUILD ? "Locked" : "Standard";
  const said =
    reason === "sign-in"
      ? `${label}. Locked — sign in with a free account to unlock.`
      : `${label}. Locked — included with Standard.`;

  /*
    The dimmed content, the tint, and the plate — the three layers, written
    once and arranged twice below.
  */
  /*
    Dimmed enough to read as switched off, and no more.

    It was opacity-45, which on a small card left the title barely legible —
    and the title is the thing that has to survive, because it is what tells a
    visitor whether they want this. 70% with a light desaturation still reads
    as off next to a card that is not.
  */
  const dimmed = (
    <div className={`pointer-events-none min-w-0 select-none opacity-70 grayscale-[25%] ${fill ? "h-full" : ""}`}>
      {children}
    </div>
  );

  /*
    The tint. A wash of the card's own surface colour rather than grey, so a
    locked card reads as the same object turned off rather than as a different,
    greyer object.
  */
  const tint = (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-2xl bg-slate-100/45 ring-1 ring-inset ring-slate-300/60 transition-colors group-hover:bg-slate-100/25"
    />
  );

  /*
    The padlock and the reason, on one plate.

    Loose over a card it looked fine, because a card has a picture and three
    words under it. Over a whole page it sat directly on top of the prose — the
    padlock in the middle of a sentence, the label's edge cutting through the
    line below it — and two pieces of text on top of each other is unreadable
    however faint one of them is. The plate gives the words underneath
    somewhere to stop, and its padding is what keeps its own boundary off them.
  */
  const plate = (
    <>
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
        className="text-slate-600/80 transition-all group-hover:text-slate-700"
      >
        <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      </svg>
      <span className="text-xs font-semibold text-slate-700">{line}</span>
    </>
  );

  const PLATE = "flex flex-col items-center gap-1.5 rounded-2xl border border-slate-300/70 bg-surface/90 px-4 py-3 shadow-sm";

  /*
    Page-level locks belong in the top-right corner of the glass instead of on
    top of its content. This keeps the page visible, gives Writing and Speaking
    the same placement, and leaves the lock inside the panel at every width.
  */
  const OVER = "pointer-events-none absolute right-5 top-5 flex items-start justify-end sm:right-6 sm:top-6";

  /*
    A page-level lock is a plain element with one link inside it; a card is one
    big link. The difference is not taste — see the note at the top. A whole
    page contains links of its own, and an <a> inside an <a> is invalid HTML
    that React reports as a hydration error and browsers recover from however
    they like.
  */
  if (standoff) {
    return (
      <div className="group relative block min-w-0 rounded-2xl p-2.5 sm:p-3.5">
        {dimmed}
        {tint}
        <div className={OVER}>
          <Link
            href={href}
            aria-label={said}
            className={`pointer-events-auto ${PLATE} transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600`}
          >
            {plate}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={href}
      aria-label={said}
      /*
        min-w-0, and the same on the wrapper inside.

        This link is a grid item, and a grid item's automatic minimum width is
        its min-content — not zero. The card inside carries `truncate`, which
        sets white-space: nowrap, so its min-content is the *whole* untruncated
        sentence. Without this the column is sized to the longest description in
        the list and every card in it overflows the screen: 654px of card in a
        320px grid, with the text running off the right edge and the page
        scrolling sideways.

        The same trap has now been hit four times in this codebase, always with
        `truncate` at the bottom of it. If a card here ever stops truncating,
        this is the line to look at first.
      */
      className={`group relative block min-w-0 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${fill ? "h-full" : ""}`}
    >
      {dimmed}
      {tint}
      {/*
        A corner, and which corner depends on how wide the card is.

        The middle is out: that was a panel sitting on the card's own title,
        which is the one thing that has to survive — see the note at the top.

        Neither corner works everywhere either, because the card changes shape.
        On a phone it is half the screen wide, the title runs most of the way
        across it, and the description wraps to three short lines — so the top
        right is taken and the bottom right is empty. On a wide screen it is the
        other way round: the title is a word on a long line and the description
        is one line that ends at the right. So the chip moves: bottom right when
        the card is narrow, top right from `sm` up, where the "New" badge
        already lives.

        Small, upper-case and muted, because it is a state label and not a call
        to action — the whole card is already the link.
      */}
      <span className="pointer-events-none absolute bottom-2 right-4 inline-flex sm:bottom-auto sm:top-2 sm:right-4 items-center gap-1 rounded-full border border-slate-300/70 bg-surface/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 shadow-sm transition-colors group-hover:text-slate-700">
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
        {short}
      </span>
    </Link>
  );
}
