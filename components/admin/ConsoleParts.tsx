"use client";

import Link from "next/link";
import LoadingIndicator from "@/components/LoadingIndicator";
import AdminTrendChart from "@/components/admin/AdminTrendChart";
import {
  maintenanceActionLabel,
  maintenanceDispatchFailed,
  maintenanceNeedsRetry,
} from "@/lib/admin/maintenance-toggle";
import {
  type Check,
  type MaintenanceState,
  type Stats,
  type UsageBreakdownRow,
} from "@/lib/admin/useConsole";

/*
  The three panels the console is made of, each usable on its own screen or
  beside the others.

  They were inline in one page. Pulling them out is what let the console become
  a menu on a phone without the desktop losing its dashboard: the wide layout
  renders all three under the numbers, and each narrow screen renders exactly
  one. Same components, same behaviour, one implementation.
*/

/* ------------------------------------------------------------------ charts */

export function Charts({ stats, full = false }: { stats: Stats | null; full?: boolean }) {
  /*
    These use the console's small data-first renderer rather than the IELTS
    Writing renderer. The underlying numbers are the same; the presentation is
    not. Thirty permanent point markers and thirty bar totals help a candidate
    read an exam figure, but turn a glanceable dashboard into a grey knot.
  */
  const signups = stats?.signups ?? null;
  const usage = stats?.usage ?? null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        {signups && signups.length > 0 ? (
          <AdminTrendChart kind="signups" rows={signups} days={stats?.days} compact={!full} />
        ) : (
          <Panel><Empty title="New accounts" /></Panel>
        )}
        {usage && usage.length > 0 ? (
          <AdminTrendChart kind="usage" rows={usage} days={stats?.days} compact={!full} />
        ) : (
          <Panel><Empty title="Learner AI request attempts" /></Panel>
        )}
      </div>
      {full && stats?.usageBreakdown && stats.usageBreakdown.length > 0 && (
        <UsageBreakdown rows={stats.usageBreakdown} />
      )}
    </div>
  );
}

function UsageBreakdown({ rows }: { rows: UsageBreakdownRow[] }) {
  const grouped = new Map<
    string,
    { route: string; caller: UsageBreakdownRow["caller"]; allowed: number; quota: number; rate: number }
  >();
  for (const row of rows) {
    const key = `${row.route}\u0000${row.caller}`;
    const current = grouped.get(key) ?? {
      route: row.route,
      caller: row.caller,
      allowed: 0,
      quota: 0,
      rate: 0,
    };
    const count = Number(row.count) || 0;
    if (row.decision === "allowed") current.allowed += count;
    else if (row.decision === "blocked_quota") current.quota += count;
    else current.rate += count;
    grouped.set(key, current);
  }

  return (
    <section className="card rounded-2xl border border-slate-200 bg-surface p-3.5">
      <h2 className="text-sm font-semibold text-slate-900">Learner AI request gate breakdown</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        These are BandUp decisions made before AI was called. Quota blocks mean the plan had no
        remaining allowance; rate blocks mean a rolling safety ceiling was reached. Owner activity
        is excluded.
      </p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200/80">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2">Feature</th>
              <th className="px-3 py-2">Caller</th>
              <th className="px-3 py-2 text-right">Allowed</th>
              <th className="px-3 py-2 text-right">Blocked · quota</th>
              <th className="px-3 py-2 text-right">Blocked · rate</th>
            </tr>
          </thead>
          <tbody>
            {[...grouped.values()].map((row) => (
              <tr key={`${row.route}-${row.caller}`} className="border-b border-slate-200/70 last:border-b-0">
                <td className="px-3 py-2.5 font-medium text-slate-800">{usageRouteLabel(row.route)}</td>
                <td className="px-3 py-2.5 text-slate-500">
                  {row.caller === "signed_in" ? "Signed in" : "Anonymous"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{row.allowed.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{row.quota.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{row.rate.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function usageRouteLabel(route: string): string {
  const labels: Record<string, string> = {
    chat: "Tutor chat",
    define: "Word lookup",
    generate: "Generated practice",
    "grade/writing": "Writing marking",
    "grade/speaking": "Speaking marking",
  };
  return labels[route] ?? route.replaceAll("/", " · ");
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
  compact = false,
}: {
  state: MaintenanceState;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
  /** Short overview copy; the dedicated status screen keeps every detail. */
  compact?: boolean;
}) {
  const deploys = state.deploys !== false;
  /* Decided one way, running the other — a deployment is in flight, or needs
     to be run by hand. */
  const inFlight = state.closed !== state.closedByDeploy;
  const live = state.closedByDeploy;
  const dispatchFailed = maintenanceDispatchFailed(state);
  const retryNeeded = maintenanceNeedsRetry(state);
  const dispatchUnknown = retryNeeded && !dispatchFailed;

  const heading = dispatchFailed
    ? state.closed
      ? "Closing was not deployed"
      : "Reopening was not deployed"
    : dispatchUnknown
      ? "Deployment status is unknown"
    : inFlight
      ? state.closed
        ? "Closing the site…"
        : "Reopening the site…"
      : live
        ? "The site is closed"
        : "The site is open";

  const detail = dispatchFailed
    ? `Learners still see ${live ? "the upgrade notice" : "the app"}. Fix the deployment problem, then retry the saved choice.`
    : dispatchUnknown
      ? `Learners still see ${live ? "the upgrade notice" : "the app"}. Retry the saved choice to confirm a deployment starts.`
    : inFlight
      ? deploys
        ? `A deployment is running. Learners still see ${live ? "the upgrade notice" : "the app"} until it finishes — about two minutes.`
        : `Recorded, but nothing has deployed. Learners still see ${live ? "the upgrade notice" : "the app"}.`
      : live
        ? "Everyone sees the upgrade notice instead of the app. Subscriptions and payments keep working underneath."
        : "Learners can use everything as normal.";

  const displayedDetail = compact
    ? dispatchFailed
      ? `Not deployed. Learners still see ${live ? "the upgrade notice" : "the app"}.`
      : dispatchUnknown
        ? `Status unknown. Learners still see ${live ? "the upgrade notice" : "the app"}.`
      : inFlight
        ? `Deploying now. Learners still see ${live ? "the upgrade notice" : "the app"}.`
        : live
          ? "Learners see the upgrade notice."
          : "Learners can use everything normally."
    : detail;

  return (
    <section
      className={`card rounded-2xl border ${compact ? "p-3.5" : "p-4 sm:p-5"} ${
        live || inFlight ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">{heading}</h2>
          <p className="mt-1 text-[13px] leading-5 text-slate-600">{displayedDetail}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={state.closed ? "btn-primary shrink-0" : "btn-secondary shrink-0"}
        >
          {busy ? <LoadingIndicator label={retryNeeded ? "Retrying…" : "Deploying…"} announce={false} /> : maintenanceActionLabel(state)}
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
      {!deploys && !compact && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
          <span className="font-semibold">This switch cannot deploy.</span> No deploy token is set
          on the Worker, so it can only record what you decide. Add one — DEPLOY.md says how — or
          run the <span className="font-medium">Deploy to Cloudflare</span> workflow yourself with
          the maintenance box ticked.
        </p>
      )}

      {!deploys && compact && (
        <p className="mt-2 text-[11px] leading-4 text-amber-900">
          No deploy token is set, so this control can only record the decision.
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
      {deploys && !compact && (
        <p className="mt-2 text-[11px] leading-4 text-slate-500">
          Either way this deploys <span className="font-medium">main</span> as it stands now.
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] leading-4 text-slate-500">
        <p>{state.changedAt && `Last changed ${new Date(state.changedAt).toLocaleString()}.`}</p>
        {compact && (
          <Link href="/admin/site" className="shrink-0 font-medium hover:text-slate-900">
            Details ›
          </Link>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ config list */

export function ConfigList({ checks, compact = false }: { checks: Check[] | null; compact?: boolean }) {
  const failing = checks?.filter((c) => !c.ok) ?? [];

  if (compact) {
    return (
      <section className="card rounded-2xl border border-slate-200 bg-surface p-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Configuration</h2>
          <Link href="/admin/config" className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-900">
            Details ›
          </Link>
        </div>
        {checks === null ? (
          <p className="mt-2 text-[13px] text-slate-500">Couldn&rsquo;t read the checks just now.</p>
        ) : failing.length > 0 ? (
          <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[13px] leading-5 text-rose-800">
            {failing.length} of {checks.length} checks need attention.
          </p>
        ) : (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] leading-5 text-emerald-800">
            All {checks.length} checks are passing.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="card rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">
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
    <section className="card rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">{children}</section>
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
