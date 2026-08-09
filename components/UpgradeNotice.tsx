"use client";

import Link from "next/link";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";

/**
 * What a learner sees when they reach an AI feature they have not paid for.
 *
 * It says what the feature costs them nothing to keep using — the bundled
 * papers and the plan are still there — because a paywall that reads like the
 * app has broken loses the learner rather than converting them.
 */
export default function UpgradeNotice({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5">
      <h3 className="text-base font-semibold text-slate-900">{message}</h3>
      <p className="mt-2 text-sm text-slate-600">
        That covers everything an examiner does: writing marked on all four criteria, the
        speaking interview, new tests on demand and word lookup. The placement test, the
        practice papers, your study plan, grammar and vocabulary stay free.
      </p>
      {IS_MOBILE_BUILD ? (
        <p className="mt-3 text-sm font-medium text-slate-700">
          Plus is available on {WEB_HOME}.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/pricing"
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-indigo-700"
          >
            See Plus
          </Link>
          <Link
            href="/redeem"
            className="rounded-xl border border-slate-300 bg-surface px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
          >
            I have a school code
          </Link>
        </div>
      )}
    </div>
  );
}
