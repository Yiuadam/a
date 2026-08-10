"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useTier } from "@/lib/billing/useTier";

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

export default function AdminPage() {
  const account = useTier();
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
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

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-[26px] font-semibold text-slate-900">Site settings</h1>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Yours alone. Nobody else can reach this page.
        </p>
      </div>

      <section
        className={`card space-y-4 ${state.closed ? "border-amber-300 bg-amber-50/50" : ""}`}
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
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700">
            {error}
          </p>
        )}

        {/*
          The one case where the button cannot help, said plainly rather than
          left as a disabled control with no explanation.
        */}
        {state.closedByDeploy && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">
            This site was closed by its last deployment, so this switch cannot reopen it. Run{" "}
            <span className="font-medium text-slate-800">Deploy to Cloudflare</span> with the
            maintenance box unticked.
          </p>
        )}

        <p className="text-xs leading-5 text-slate-500">
          Takes up to {state.lagSeconds} seconds to reach everyone.
          {state.changedAt && ` Last changed ${new Date(state.changedAt).toLocaleString()}.`}
        </p>
      </section>

      <section className="card">
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
          <p className="mt-3 text-sm text-slate-500">Couldn&rsquo;t read the checks just now.</p>
        ) : (
          /*
            Only what is wrong, with the rest collapsed to a count. A list of
            twenty green ticks is a list nobody reads, and the one red line in
            the middle of it is the thing this page exists to show.
          */
          <ul className="mt-3 space-y-2">
            {(failing.length > 0 ? failing : []).map((c) => (
              <li key={c.name} className="rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2">
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
  );
}
