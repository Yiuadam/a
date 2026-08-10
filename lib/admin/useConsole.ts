"use client";

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";

/*
  Everything the console knows, in one place, because four screens now need it.

  The console used to be a single page, so its three fetches lived in that
  page's effect. Splitting it into an overview and three screens — which is
  what made it usable on a phone — would otherwise have meant four copies of
  the same request sequence, drifting apart the first time one of them was
  fixed.

  The order is deliberate and is kept from the original. The maintenance state
  comes first because it is both the fastest and the control the owner most
  often came for; the checklist second because it probes the database and is
  the slowest; the figures last because a dashboard with no numbers is still a
  dashboard, and a switch that has not loaded is not a switch.

  It is a hook rather than a context provider because each screen mounts one
  of these and nothing shares a tree with anything else. A provider would be a
  second thing to wire up for no second reader.
*/

export interface MaintenanceState {
  closed: boolean;
  changedAt: string | null;
  closedByDeploy: boolean;
  lagSeconds: number;
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
