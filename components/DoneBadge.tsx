"use client";

import type { ModuleResult } from "@/lib/types";

/*
  "You have done this one" — and nothing stronger than that.

  ---------------------------------------------------------------------------
  Why it does not close anything off

  A finished paper stays open, and the badge says so by being a badge rather
  than a state. Re-sitting a paper you have already done is one of the more
  useful things a learner can do with this app: the questions are the same, the
  passage is the same, and the only variable left is you. A tick that greyed
  the card out would be optimising for a completionist who wants a full grid,
  at the expense of somebody trying to get better.

  So it sits beside the title, it carries the best band rather than the last —
  the same rule the drill cards already use, and for the same reason: a learner
  who came back and improved should see their best work, not their most recent
  attempt.

  ---------------------------------------------------------------------------
  Best, not last

  A learner who re-sits and does worse would otherwise watch their own card
  get worse, which is a discouraging thing to have built. Nothing is lost by
  showing the best: the full history, in order, is on /history.
*/

export function bestResultFor(
  results: readonly ModuleResult[],
  testId: string,
): ModuleResult | null {
  let best: ModuleResult | null = null;
  for (const r of results) {
    if (r.testId !== testId) continue;
    if (best === null || r.band > best.band) best = r;
  }
  return best;
}

export default function DoneBadge({ result }: { result: ModuleResult | null }) {
  if (result === null) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700"
      /* One label rather than a tick plus a number read separately. */
      aria-label={`Done — your best band was ${result.band}`}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      Done · {result.band}
    </span>
  );
}
