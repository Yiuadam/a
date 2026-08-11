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

/**
 * How tall a plot may be drawn on the console.
 *
 * Chosen against the screen rather than by taste: at 1440×900 the overview has
 * to hold a title, four stat tiles, two charts, the site switch and the
 * configuration list, and this is what leaves the last two above the fold.
 */
const CONSOLE_PLOT_HEIGHT = 130;

export function Charts({ stats, full = false }: { stats: Stats | null; full?: boolean }) {
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

  /*
    A fixed height whether there is data or not.

    The console drew empty axes at about eighty pixels and a real thirty-day
    series at three hundred, so the first day anything was worth plotting the
    page grew by half a screen and pushed the site switch and the checklist
    under the fold. A dashboard whose layout depends on its numbers is one you
    have to re-find your way around every time the numbers change, and the
    controls are the part that must not move.

    So the plot is capped and the panel is given a floor: full, it cannot grow
    past the cap; empty, it does not collapse. Same box either way.
  */
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel>
        {signupChart ? (
          <Chart spec={signupChart} plotHeight={full ? undefined : CONSOLE_PLOT_HEIGHT} />
        ) : (
          <Empty title="New accounts" />
        )}
      </Panel>
      <Panel>
        {usageChart ? (
          <Chart spec={usageChart} plotHeight={full ? undefined : CONSOLE_PLOT_HEIGHT} />
        ) : (
          <Empty title="AI requests" />
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ site switch */

/*
  The switch that closes the site, and what actually happens when it is thrown.

  ---------------------------------------------------------------------------
  It deploys

  The site closes on `NEXT_PUBLIC_MAINTENANCE_MODE`, which Next substitutes
  into the compiled code at build time. Nothing read at runtime has ever worked
  — a plain `process.env` lookup found nothing on the Worker and the site
  stayed open through three deploys that reported success, and a database read
  from the root layout answered 500 on every page of a preview. So the switch
  asks for the thing that does work: it starts the deploy workflow with the
  maintenance box ticked, and the site changes when that finishes.

  That is about two minutes rather than instant, and the panel says two minutes
  rather than implying instant.

  ---------------------------------------------------------------------------
  Three states, because there are three

  What the owner decided and what learners can currently see are different
  facts, and between throwing the switch and the deploy landing they disagree.
  A panel that collapsed them into one word would be wrong for exactly the two
  minutes somebody is standing there watching it.

    open              decided open, deployed open
    closing / opening decided one way, the running build still the other
    closed            decided closed, deployed closed

  With no deploy token configured the middle state never resolves on its own,
  and the panel says so and names the workflow to run by hand. A control that
  looks live and is not is worse than no control.
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
  const deploys = state.deploys !== false;
  /* Decided one way, running the other — a deployment is in flight, or needs
     to be run by hand. */
  const inFlight = state.closed !== state.closedByDeploy;
  const live = state.closedByDeploy;

  const heading = inFlight
    ? state.closed
      ? "Closing the site…"
      : "Reopening the site…"
    : live
      ? "The site is closed"
      : "The site is open";

  const detail = inFlight
    ? deploys
      ? `A deployment is running. Learners still see ${live ? "the upgrade notice" : "the app"} until it finishes — about two minutes.`
      : `Recorded, but nothing has deployed. Learners still see ${live ? "the upgrade notice" : "the app"}.`
    : live
      ? "Everyone sees the upgrade notice instead of the app. Subscriptions and payments keep working underneath."
      : "Learners can use everything as normal.";

  return (
    <section
      className={`rounded-2xl border p-4 sm:p-5 ${
        live || inFlight ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">{heading}</h2>
          <p className="mt-1 text-[13px] leading-5 text-slate-600">{detail}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={state.closed ? "btn-primary shrink-0" : "btn-secondary shrink-0"}
        >
          {busy ? "Deploying…" : state.closed ? "Reopen the site" : "Close the site"}
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

      {/*
        What GitHub said, when it said no. Shown rather than swallowed: the
        decision was saved and the deployment was not, and an owner who thinks
        they have closed a site that is still open is the failure this whole
        panel exists to prevent.
      */}
      {state.deployProblem && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[13px] leading-5 text-rose-800"
        >
          {state.deployProblem}
        </p>
      )}

      {/*
        The variable is named in DEPLOY.md, not here. tests/no-secret-leak
        forbids the name of a server-only secret from appearing anywhere the
        browser can reach — this panel is a client component, so a name in its
        copy is a name in the bundle, and the test cannot tell the difference
        between a helpful instruction and an actual leak. It should not have
        to: a variable name is developer-speak in a sentence a person reads.
      */}
      {!deploys && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
          <span className="font-semibold">This switch cannot deploy.</span> No deploy token is set
          on the Worker, so it can only record what you decide. Add one — DEPLOY.md says how — or
          run the <span className="font-medium">Deploy to Cloudflare</span> workflow yourself with
          the maintenance box ticked.
        </p>
      )}

      {state.deployStarted && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-600">
          Deployment started. Reload this page in a couple of minutes to confirm it landed.
        </p>
      )}

      {/*
        Said on the control, not only in the docs. The workflow builds from
        `main`, so throwing this switch ships whatever is on main right now —
        which is the correct behaviour and a genuine surprise if anything has
        merged since the last deploy. GitHub's dispatch API takes a branch, not
        a commit, so there is no version of this that redeploys exactly what is
        already live.
      */}
      {deploys && (
        <p className="mt-2 text-[11px] leading-4 text-slate-500">
          Either way this deploys <span className="font-medium">main</span> as it stands now.
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
  The traffic screen wants the room the overview cannot spare, so it draws the
  same two charts at their natural size. Exported so /admin/traffic reads as
  "the big versions of these" rather than repeating the composition.
*/
export function FullCharts({ stats }: { stats: Stats | null }) {
  return <Charts stats={stats} full />;
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
