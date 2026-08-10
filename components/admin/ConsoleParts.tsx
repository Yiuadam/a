"use client";

import Chart from "@/components/Chart";
import { dayLabels, type Check, type MaintenanceState, type Stats } from "@/lib/admin/useConsole";
import type { ChartSpec } from "@/lib/chart";

/*
  The three panels the console is made of, each usable on its own screen or
  beside the others.

  They were inline in one page. Pulling them out is what let the console become
  a menu on a phone without the desktop losing its dashboard: the wide layout
  renders all three under the numbers, and each narrow screen renders exactly
  one. Same components, same behaviour, one implementation.
*/

/* ------------------------------------------------------------------ charts */

export function Charts({ stats }: { stats: Stats | null }) {
  /*
    Both drawn through the app's own chart component rather than a library. It
    already renders line and bar from a ChartSpec — it was built for Writing
    Task 1 — and a second charting stack in the bundle to draw two pictures on
    one page nobody but the owner sees would be a poor trade.
  */
  const signupChart: ChartSpec | null =
    stats?.signups && stats.signups.length > 0
      ? {
          kind: "line",
          title: `New accounts, last ${stats.days} days`,
          categories: dayLabels(stats.signups),
          series: [{ name: "Signups", values: stats.signups.map((d) => d.count ?? 0) }],
        }
      : null;

  const usageChart: ChartSpec | null =
    stats?.usage && stats.usage.length > 0
      ? {
          kind: "bar",
          layout: "stacked",
          title: `AI requests, last ${stats.days} days`,
          categories: dayLabels(stats.usage),
          series: [
            { name: "Served", values: stats.usage.map((d) => d.admitted ?? 0) },
            /* Refusals beside them, because a run of these is either a cap set
               too low or somebody having a bad time, and neither shows up in a
               count of what was served. */
            { name: "Refused", values: stats.usage.map((d) => d.denied ?? 0) },
          ],
        }
      : null;

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel>{signupChart ? <Chart spec={signupChart} /> : <Empty title="New accounts" />}</Panel>
      <Panel>{usageChart ? <Chart spec={usageChart} /> : <Empty title="AI requests" />}</Panel>
    </div>
  );
}

/* ------------------------------------------------------------ site switch */

/*
  What this switch does today, said on the switch.

  It stores the decision and nothing reads it. app/layout.tsx closes the site
  from `NEXT_PUBLIC_MAINTENANCE_MODE`, which is set at build time by the deploy
  workflow; the runtime read that would have made this instant was withdrawn
  after it answered 500 on every page of a preview and could not be reproduced
  in five local configurations (see the commit "Withdraw the runtime
  maintenance read until it can be reproduced").

  So the panel says so. A control that looks live and is not is worse than no
  control — the owner presses it, sees "Closed", and believes the site is shut
  while learners carry on using it. Naming the working route in the same
  breath is what keeps it useful rather than merely honest.
*/
export function SiteSwitch({
  state,
  busy,
  error,
  onToggle,
}: {
  state: MaintenanceState;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  return (
    <section
      className={`rounded-2xl border p-4 sm:p-5 ${
        state.closed ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            {state.closedByDeploy
              ? "The site is closed"
              : state.closed
                ? "Marked to close"
                : "The site is open"}
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-slate-600">
            {state.closedByDeploy
              ? "Everyone sees the upgrade notice instead of the app. Subscriptions and payments keep working underneath."
              : state.closed
                ? "Recorded, but learners can still use everything — this switch is not connected to the site yet."
                : "Learners can use everything as normal."}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy || state.closedByDeploy}
          className={state.closed ? "btn-primary shrink-0" : "btn-secondary shrink-0"}
        >
          {busy ? "Saving…" : state.closed ? "Reopen the site" : "Close the site"}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[13px] leading-5 text-rose-700"
        >
          {error}
        </p>
      )}

      {state.closedByDeploy && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[13px] leading-5 text-slate-600">
          This site was closed by its last deployment, so this switch cannot reopen it. Run{" "}
          <span className="font-medium text-slate-800">Deploy to Cloudflare</span> with the
          maintenance box unticked.
        </p>
      )}

      {!state.closedByDeploy && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
          <span className="font-semibold">This switch does not close the site yet.</span> It records
          the decision only. To actually close it, run{" "}
          <span className="font-medium">Deploy to Cloudflare</span> with the maintenance box ticked
          — that is the route that works today, and the one the site was last closed with.
        </p>
      )}

      <p className="mt-2.5 text-[11px] leading-4 text-slate-500">
        {state.changedAt && `Last changed ${new Date(state.changedAt).toLocaleString()}.`}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------ config list */

export function ConfigList({ checks }: { checks: Check[] | null }) {
  const failing = checks?.filter((c) => !c.ok) ?? [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Configuration</h2>
        {checks && (
          <span className="text-[11px] text-slate-500">
            {failing.length === 0
              ? `${checks.length} checks passing`
              : `${failing.length} of ${checks.length} need attention`}
          </span>
        )}
      </div>

      {checks === null ? (
        <p className="mt-3 text-[13px] text-slate-500">Couldn&rsquo;t read the checks just now.</p>
      ) : (
        /*
          Only what is wrong, with the rest collapsed to a count. A list of
          twenty green ticks is a list nobody reads, and the one red line in
          the middle of it is the thing this page exists to show.
        */
        <ul className="mt-3 space-y-2">
          {failing.map((c) => (
            <li key={c.name} className="rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2">
              <p className="text-[13px] font-medium text-rose-800">{c.name}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-rose-700">{c.detail}</p>
            </li>
          ))}
          {failing.length === 0 && (
            <li className="rounded-lg bg-emerald-50 px-3 py-2 text-[13px] leading-5 text-emerald-800">
              Everything is configured. Nothing needs your attention.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- helpers */

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">{children}</section>
  );
}

/*
  A chart with nothing in it says so, rather than drawing empty axes. Empty axes
  read as "zero of everything", which on a page whose numbers may simply be
  unreadable is the wrong thing to say.
*/
function Empty({ title }: { title: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        No data yet — this needs the stats migration applied.
      </p>
    </div>
  );
}
