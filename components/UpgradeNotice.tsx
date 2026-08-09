"use client";

import Link from "next/link";
import type { PaywallError } from "@/lib/api";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";
import { PLANS } from "@/lib/plans";

/**
 * What a learner sees when an AI feature is closed to them.
 *
 * Two quite different situations arrive here and they need different words. A
 * learner with no plan is being asked to buy something; a learner who has used
 * up this period's markings has already paid, and telling them to "subscribe"
 * would read as though the app had forgotten. The second case says when the
 * allowance comes back, so waiting is a real option rather than a dead end.
 */
export default function UpgradeNotice({ error }: { error: PaywallError }) {
  const exhausted = error.code === "quota-exhausted";
  const next = error.nextPlan ? PLANS[error.nextPlan] : null;

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5">
      <h3 className="text-base font-semibold text-slate-900">
        {exhausted ? "That's this period's allowance" : "This is part of a BandUp plan"}
      </h3>
      <p className="mt-2 text-sm text-slate-600">{error.message}</p>
      {!exhausted && (
        <p className="mt-2 text-sm text-slate-600">
          Marking by an examiner model — writing, speaking, new tests on demand and word
          lookup — needs a plan. The placement test, the practice papers, your study plan,
          grammar and vocabulary stay free.
        </p>
      )}
      {exhausted && !next && (
        <p className="mt-2 text-sm text-slate-600">
          Everything else stays open, and your allowance returns when the next billing
          period starts.
        </p>
      )}

      {IS_MOBILE_BUILD ? (
        <p className="mt-3 text-sm font-medium text-slate-700">Plans are available on {WEB_HOME}.</p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/pricing"
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-indigo-700"
          >
            {next ? `Move to ${next.name}` : exhausted ? "Manage plan" : "See plans"}
          </Link>
        </div>
      )}
    </div>
  );
}
