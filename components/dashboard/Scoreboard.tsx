"use client";

import BandBadge from "@/components/BandBadge";
import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import { Icon } from "@/components/Icons";
import { overallBand } from "@/lib/exam/report";
import { latestFor } from "@/lib/results";
import type { ModuleName, ModuleResult } from "@/lib/types";

/*
  Where a learner stands, in one glance: the overall band and the four that make
  it.

  It is the piece the dashboard was missing. The page could tell you what to
  practise and could show a trend once you clicked into History, but the number
  the whole product exists to move was either absent or buried in a hero that
  only appeared after a placement test. A dashboard whose first question is not
  "how am I doing" is a menu.

  ---------------------------------------------------------------------------
  Why a dash rather than a zero

  A skill with no sitting has no band, and the honest mark for that is nothing
  at all. Writing 0 would be a score — the worst one — for somebody who has
  simply not started, and on a page about progress that is the one number never
  to invent. The overall follows the same rule: IELTS averages four skills, so
  with three sat there is no average to show, and it says how many are left
  instead of averaging what happens to be there.
*/

const MODULES: { key: ModuleName; label: string; icon: string }[] = [
  { key: "listening", label: "Listening", icon: "listening" },
  { key: "reading", label: "Reading", icon: "reading" },
  { key: "writing", label: "Writing", icon: "writing" },
  { key: "speaking", label: "Speaking", icon: "speaking" },
];

export default function Scoreboard({ results }: { results: readonly ModuleResult[] }) {
  const bands = MODULES.map((m) => ({ ...m, band: latestFor(results, m.key)?.band ?? null }));
  const overall = overallBand(Object.fromEntries(bands.map((b) => [b.key, b.band])));
  const missing = bands.filter((b) => b.band === null).length;

  return (
    <section className="card flex h-full min-w-0 flex-col !p-4" aria-labelledby="dashboard-band-heading">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dashboard-band-heading" className="text-[0.9375rem] font-semibold text-slate-900">
            Your band
          </h2>
          <p className="mt-0.5 text-[0.8125rem] leading-5 text-slate-500">
            {overall !== null
              ? "The average of your four latest sittings."
              : missing === MODULES.length
                ? "Sit any paper and it appears here."
                : `${missing} more skill${missing === 1 ? "" : "s"} to go before there is an overall.`}
          </p>
        </div>
        {/* The badge prints its own label, so nothing repeats it beside it. */}
        {overall !== null ? (
          <BandBadge band={overall} size="sm" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-[0.8125rem] text-slate-400"
          >
            —
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1">
        {bands.map((m) => (
          <li key={m.key}>
            <IntentPrefetchLink
              href={`/history?module=${m.key}`}
              className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-1.5 text-[0.875rem] transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-slate-400)_12%,transparent)]"
            >
              <span className="flex min-w-0 items-center gap-2 text-slate-700">
                <Icon name={m.icon} className="h-4 w-4 shrink-0 text-indigo-600" />
                <span className="truncate">{m.label}</span>
              </span>
              <span
                className={`shrink-0 font-semibold tabular-nums ${
                  m.band === null ? "text-slate-400" : "text-slate-900"
                }`}
              >
                {m.band ?? "—"}
              </span>
            </IntentPrefetchLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
