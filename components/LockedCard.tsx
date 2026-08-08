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
  children,
}: {
  reason: Exclude<LockReason, null>;
  /** What is locked, for the screen reader: "Writing practice". */
  label: string;
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
      className="group relative block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
    >
      {/*
        The card itself, dimmed and desaturated. pointer-events-none so that
        nothing inside it can take the tap — the whole card is one link, and a
        stray button underneath would send a learner somewhere that refuses
        them.
      */}
      <div className="pointer-events-none select-none opacity-45 grayscale-[35%]">{children}</div>

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
        The padlock and the reason, centred. Half-transparent, as asked, and it
        lifts on hover so the card still answers a pointer the way a card
        should.
      */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
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
