"use client";

import Link from "next/link";
import { TIERS, formatPrice, plansForTier, type Tier } from "@/lib/billing/tiers";

/*
  What a learner sees when they reach something their plan does not include.

  ---------------------------------------------------------------------------
  Two jobs, and the order between them is the whole design

  The first is to explain. Somebody who has just been stopped wants to know
  what stopped them and whether they did something wrong. So the panel leads
  with the answer — this is part of a named plan — and immediately says what is
  *not* affected, because the fear behind "I hit a wall" is usually that the
  rest of the app is about to start asking for money too. It is not, and saying
  so is worth more than any amount of persuasion.

  The second is to sell, and it comes second on purpose. No countdown, no
  crossed-out price, no "most popular" badge, no fake scarcity. The price is
  stated once, the renewal terms are stated once, and there is a link. If
  the plan is worth its price to this person it is worth it without being
  pushed, and if it is not, pushing produces a refund and a bad review rather
  than a subscriber.

  ---------------------------------------------------------------------------
  Why the signed-out case is different

  A visitor is not being sold anything — they are one free account away from
  a working feature. Sending them to a pricing page would be answering a
  question they did not ask, so they get "sign in" and nothing about money.
*/

export default function UpgradePanel({
  feature,
  signedIn,
  tier = "plus",
  className = "",
}: {
  /** What they were trying to do, in the second person: "ask the tutor". */
  feature: string;
  signedIn: boolean;
  /**
   * The cheapest plan that includes what they were stopped from doing.
   *
   * Defaults to Plus, which is where every AI feature starts. Naming the
   * cheapest one matters: sending somebody to Pro for something Plus covers is
   * an upsell dressed as an explanation, and it is the kind of thing people
   * notice afterwards.
   */
  tier?: Exclude<Tier, "free" | "admin">;
  className?: string;
}) {
  const definition = TIERS[tier];
  const monthly = plansForTier(tier).find((p) => p.interval === "month");

  if (!signedIn) {
    return (
      <div className={`card ${className}`}>
        <h2 className="text-[17px] font-semibold text-slate-900">Sign in to {feature}</h2>
        <p className="mt-2 text-[15px] leading-7 text-slate-600">
          An account is free, and it also carries your progress between your phone and your
          laptop. Everything you have done so far stays where it is.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/account" className="btn-primary">
            Sign in
          </Link>
          <Link href="/practice" className="btn-secondary">
            Keep practising
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={`card ${className}`}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-700"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold text-slate-900">
            To {feature}, you need {definition.name}
          </h2>
          {/*
            The reassurance, immediately. The worry behind hitting a wall is
            that the whole app is about to start charging.
          */}
          <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
            Everything else stays free and unlimited — the placement test, your study plan, and
            every grammar and vocabulary drill. Nothing you have done is affected.
          </p>
        </div>
      </div>

      <ul className="mt-4 space-y-1.5">
        {definition.includes.slice(0, 4).map((line) => (
          <li key={line} className="flex gap-2.5 text-[15px] leading-6 text-slate-700">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600" />
            {line}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href="/pricing" className="btn-primary">
          {monthly
            ? `See ${definition.name} — ${formatPrice(monthly.amountMinor, monthly.currency)} a month`
            : `See ${definition.name}`}
        </Link>
        <Link href="/billing" className="btn-secondary">
          Your usage
        </Link>
      </div>
      {/* Stated here too, so nobody meets the word "automatically" later. */}
      <p className="mt-2 text-xs leading-5 text-slate-500">
        Renews automatically until you cancel. Cancel any time in one button, and a full refund
        within 14 days of any charge.
      </p>
    </div>
  );
}
