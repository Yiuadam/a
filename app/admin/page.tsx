"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Chart from "@/components/Chart";
import StatCard from "@/components/admin/StatCard";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { formatPrice } from "@/lib/billing/tiers";
import { useTier } from "@/lib/billing/useTier";
import type { ChartSpec } from "@/lib/chart";

/*
  The owner's own screen: what the site is doing, and the one control that
  changes it.

  ---------------------------------------------------------------------------
  Deliberately small

  It would be easy to make this a console — subscriber counts, revenue, usage
  graphs, a log viewer. It is one page with a switch and a list of checks
  because those are the two questions the owner has actually needed answered
  this week: is anything misconfigured, and can I take the site down right now.
  Everything else already has a home — Stripe has the money, Supabase has the
  accounts, and duplicating either here would mean a second version of the
  truth to keep in step.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  The gate is server-side (app/layout.tsx), the switch is server-side
  (app/api/admin/maintenance), and both check the session against ADMIN_EMAILS
  before acting. Editing this page in dev tools changes what a non-owner sees
  and nothing about what any route will do — the API answers 404 to anyone
  else, which is also why a non-owner who guesses this URL learns nothing.
*/

interface MaintenanceState {
  closed: boolean;
  changedAt: string | null;
  closedByDeploy: boolean;
  lagSeconds: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface DayRow {
  day: string;
  count?: number;
  admitted?: number;
  denied?: number;
}

interface Stats {
  days: number;
  users: number | null;
  signups: DayRow[] | null;
  usage: DayRow[] | null;
  tiers: { tier: string; count: number }[] | null;
  billing: { byPlan: Record<string, number>; active: number; mrrHkd: number } | null;
}

/**
 * Day labels for a thirty-point axis, thinned so they can be read.
 *
 * Thirty dates side by side overlap into a grey smear — the first version drew
 * exactly that, and an axis nobody can read is worse than one with fewer marks
 * on it, because it still costs the space. Every fifth day is labelled and the
 * rest are blank; the shape of the line is what the chart is for, and anyone
 * who wants the exact figures has the table underneath it.
 */
function dayLabels(rows: { day: string }[]): string[] {
  const every = Math.max(1, Math.ceil(rows.length / 6));
  return rows.map((r, i) => {
    if (i !== rows.length - 1 && i % every !== 0) return "";
    const d = new Date(r.day);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });
}

export default function AdminPage() {
  const account = useTier();
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "denied">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    Loaded in the effect rather than through a callback the effect then calls,
    which is the shape the lint rule is asking for and the shape every other
    fetching page here already uses. `alive` because an owner who opens this
    and navigates away should not have a late response write into an unmounted
    component.
  */
  useEffect(() => {
    let alive = true;

    authedFetch(apiUrl("/api/admin/maintenance"))
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) {
          setPhase("denied");
          return;
        }
        setState((await res.json()) as MaintenanceState);
        setPhase("ready");

        /*
          The checklist second, and only once the switch has loaded. It is the
          slower of the two — it probes the database — and the control is what
          the owner came for.
        */
        const diag = await authedFetch(apiUrl("/api/account/diagnostics")).catch(() => null);
        if (!alive || !diag || !diag.ok) return;
        const body = (await diag.json()) as { checks?: Check[] };
        if (alive) setChecks(body.checks ?? []);

        const s = await authedFetch(apiUrl("/api/admin/stats")).catch(() => null);
        if (!alive || !s || !s.ok) return;
        const parsed = (await s.json()) as Stats;
        if (alive) setStats(parsed);
      })
      .catch(() => {
        if (alive) setPhase("denied");
      });

    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async () => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(apiUrl("/api/admin/maintenance"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closed: !state.closed }),
      });
      const body = (await res.json()) as MaintenanceState & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "That didn't save. The site is unchanged.");
        return;
      }
      setState(body);
    } catch {
      setError("Couldn't reach the server. The site is unchanged.");
    } finally {
      setBusy(false);
    }
  }, [state]);

  if (phase === "loading") {
    return <p className="text-sm text-slate-500">Checking…</p>;
  }

  /*
    The same answer a stranger gets, for the same reason the API returns 404:
    a page that said "you are not an admin" would confirm there is an admin
    page to find.
  */
  if (phase === "denied" || !state) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-[22px] font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {account.phase === "ready" && !account.signedIn
            ? "You may need to sign in."
            : "There's nothing at this address."}
        </p>
        <Link href="/" className="btn-secondary mt-5 inline-block">
          Back to BandUp
        </Link>
      </div>
    );
  }

  const failing = checks?.filter((c) => !c.ok) ?? [];

  /*
    Two charts, both drawn from the same thirty days, and both through the
    app's own chart component rather than a library. It already renders line
    and bar from a ChartSpec — it was built for Writing Task 1 — and a second
    charting stack in the bundle to draw two pictures on one page nobody but
    the owner sees would be a poor trade.
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

  const servedTotal = stats?.usage?.reduce((n, d) => n + (d.admitted ?? 0), 0) ?? null;

  return (
    <div className="flex min-h-[100dvh]">
      {/*
        The sidebar. Dark against a light page, and the only place in BandUp
        that is: the app is warm and quiet because a learner spends hours in
        it, while a console is glanced at, and the contrast is what makes "am I
        in the admin area" answerable from the corner of an eye.
      */}
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 px-4 py-6 lg:flex">
        <Link href="/" className="flex items-center gap-2 px-2 text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm font-semibold">
            B
          </span>
          <span className="text-[15px] font-semibold tracking-tight">BandUp</span>
        </Link>

        <p className="mt-8 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Site
        </p>
        <nav className="mt-2 flex flex-col gap-0.5">
          <span className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white">
            Overview
          </span>
          {/*
            One entry, and no fake ones beside it. A sidebar padded with
            disabled links to pages that do not exist is a menu that teaches
            somebody the product is unfinished.
          */}
        </nav>

        <div className="mt-auto px-2">
          <Link
            href="/"
            className="text-xs text-slate-400 underline underline-offset-4 hover:text-white"
          >
            Back to the app
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1 px-5 py-6 sm:px-7">
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-slate-900">Overview</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Yours alone. Nobody else can reach this page.
            </p>
          </div>
          <Link href="/" className="text-sm text-slate-500 underline underline-offset-4 lg:hidden">
            Back to the app
          </Link>
        </header>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Registered accounts"
            value={stats?.users != null ? stats.users.toLocaleString() : "—"}
            unavailable={
              stats && stats.users == null
                ? "The stats migration may not be applied yet."
                : undefined
            }
            icon={<Dot />}
          />
          <StatCard
            label="Paying subscribers"
            value={stats?.billing ? stats.billing.active.toLocaleString() : "—"}
            hint={stats?.billing ? "Active and trialing, from Stripe" : undefined}
            unavailable={stats && !stats.billing ? "Stripe could not be reached." : undefined}
            icon={<Dot />}
          />
          <StatCard
            label="Monthly recurring revenue"
            value={stats?.billing ? formatPrice(Math.round(stats.billing.mrrHkd * 100), "hkd") : "—"}
            hint={stats?.billing ? "Yearly plans divided over twelve months" : undefined}
            unavailable={stats && !stats.billing ? "Stripe could not be reached." : undefined}
            icon={<Dot />}
          />
          <StatCard
            label={`AI requests, ${stats?.days ?? 30} days`}
            value={servedTotal != null ? servedTotal.toLocaleString() : "—"}
            unavailable={
              stats && stats.usage == null
                ? "The stats migration may not be applied yet."
                : undefined
            }
            icon={<Dot />}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-surface p-5">
            {signupChart ? (
              <Chart spec={signupChart} />
            ) : (
              <Empty title="New accounts" />
            )}
          </section>
          <section className="rounded-2xl border border-slate-200 bg-surface p-5">
            {usageChart ? <Chart spec={usageChart} /> : <Empty title="AI requests" />}
          </section>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <section
            className={`rounded-2xl border p-5 ${
              state.closed ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-surface"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900">
                  {state.closed ? "The site is closed" : "The site is open"}
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  {state.closed
                    ? "Everyone sees the upgrade notice instead of the app. Subscriptions and payments keep working underneath."
                    : "Learners can use everything as normal."}
                </p>
              </div>
              <button
                type="button"
                onClick={toggle}
                disabled={busy || state.closedByDeploy}
                className={state.closed ? "btn-primary shrink-0" : "btn-secondary shrink-0"}
              >
                {busy ? "Saving…" : state.closed ? "Reopen the site" : "Close the site"}
              </button>
            </div>

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700"
              >
                {error}
              </p>
            )}

            {state.closedByDeploy && (
              <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">
                This site was closed by its last deployment, so this switch cannot reopen it. Run{" "}
                <span className="font-medium text-slate-800">Deploy to Cloudflare</span> with the
                maintenance box unticked.
              </p>
            )}

            <p className="mt-3 text-xs leading-5 text-slate-500">
              Takes up to {state.lagSeconds} seconds to reach everyone.
              {state.changedAt && ` Last changed ${new Date(state.changedAt).toLocaleString()}.`}
            </p>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-surface p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">Configuration</h2>
              {checks && (
                <span className="text-xs text-slate-500">
                  {failing.length === 0
                    ? `${checks.length} checks passing`
                    : `${failing.length} of ${checks.length} need attention`}
                </span>
              )}
            </div>

            {checks === null ? (
              <p className="mt-3 text-sm text-slate-500">
                Couldn&rsquo;t read the checks just now.
              </p>
            ) : (
              /*
                Only what is wrong, with the rest collapsed to a count. A list
                of twenty green ticks is a list nobody reads, and the one red
                line in the middle of it is the thing this page exists to show.
              */
              <ul className="mt-3 space-y-2">
                {failing.map((c) => (
                  <li
                    key={c.name}
                    className="rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2"
                  >
                    <p className="text-sm font-medium text-rose-800">{c.name}</p>
                    <p className="mt-0.5 text-xs leading-5 text-rose-700">{c.detail}</p>
                  </li>
                ))}
                {failing.length === 0 && (
                  <li className="rounded-lg bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-800">
                    Everything is configured. Nothing needs your attention.
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** A neutral tile glyph. The cards are about their numbers, not their icons. */
function Dot() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="4" />
      <path d="M7 12.5 9.5 9l2 2.2L14 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
