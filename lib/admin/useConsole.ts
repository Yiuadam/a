"use client";

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { nextMaintenanceClosed } from "@/lib/admin/maintenance-toggle";

/*
  Everything the console knows, in one place, because four screens now need it.

  The console used to be a single page, so its three fetches lived in that
  page's effect. Splitting it into an overview and three screens — which is
  what made it usable on a phone — would otherwise have meant four copies of
  the same request sequence, drifting apart the first time one of them was
  fixed.

  The maintenance state comes first because it is the authorization check and
  the control the owner most often came for. Once it succeeds, diagnostics and
  figures are independent and load together: a slow or unavailable checklist
  must not hold the charts back, and a stats failure must not hide the switch.

  It is a hook rather than a context provider because each screen mounts one
  of these and nothing shares a tree with anything else. A provider would be a
  second thing to wire up for no second reader.
*/

export interface MaintenanceState {
  /** What the owner last decided. */
  closed: boolean;
  changedAt: string | null;
  /** What the running build was compiled with — the one learners can see. */
  closedByDeploy: boolean;
  lagSeconds: number;
  /** Whether throwing the switch starts a deployment, or only records a wish. */
  deploys?: boolean;
  /** Set on the response to a POST: whether a deployment was actually started. */
  deployStarted?: boolean;
  deployProblem?: string | null;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DayRow {
  day: string;
  count?: number;
  admitted?: number;
  denied?: number;
}

export interface Stats {
  days: number;
  users: number | null;
  signups: DayRow[] | null;
  usage: DayRow[] | null;
  tiers: { tier: string; count: number }[] | null;
  billing: { byPlan: Record<string, number>; active: number; mrrHkd: number } | null;
  /** Whether a Stripe key and at least one price id are on this Worker. */
  stripeConfigured?: boolean;
}

export interface Console {
  phase: "loading" | "ready" | "denied";
  state: MaintenanceState | null;
  checks: Check[] | null;
  stats: Stats | null;
  busy: boolean;
  error: string | null;
  toggle: () => Promise<void>;
}

export function useConsole(): Console {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "denied">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /*
      `alive` because an owner who opens this and navigates away should not
      have a late response write into an unmounted component — which is now a
      routine event rather than an edge case, since the console is four screens
      and moving between them unmounts one of them every time.
    */
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

        const [diag, s] = await Promise.all([
          authedFetch(apiUrl("/api/account/diagnostics")).catch(() => null),
          authedFetch(apiUrl("/api/admin/stats")).catch(() => null),
        ]);
        if (!alive) return;

        if (diag?.ok) {
          const body = (await diag.json().catch(() => null)) as { checks?: Check[] } | null;
          if (alive && body) setChecks(body.checks ?? []);
        }

        if (s?.ok) {
          const parsed = (await s.json().catch(() => null)) as Stats | null;
          if (alive && parsed) setStats(parsed);
        }
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
        /* A failed dispatch saved the desired state already. Retry that same
           state instead of silently turning a failed close into an open. */
        body: JSON.stringify({ closed: nextMaintenanceClosed(state) }),
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

  return { phase, state, checks, stats, busy, error, toggle };
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
export function dayLabels(rows: { day: string }[]): string[] {
  const every = Math.max(1, Math.ceil(rows.length / 6));
  return rows.map((r, i) => {
    if (i !== rows.length - 1 && i % every !== 0) return "";
    const d = new Date(r.day);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });
}
