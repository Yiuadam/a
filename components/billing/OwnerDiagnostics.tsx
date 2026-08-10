"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";

/*
  The owner's "what is actually wrong" button.

  Every error a learner sees here is deliberately vague, and that is right — a
  stranger should not be able to map the inside of the app by provoking it. The
  cost is that the owner sees the same seven words and has to guess, and that
  cost has now been paid twice over configuration the server knew about all
  along.

  So this asks the server, as the owner, and prints what it says. It is a
  button rather than something that runs on load: it makes one real metered
  call, which is the only way to find out whether the metered call works.
*/

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export default function OwnerDiagnostics() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(apiUrl("/api/account/diagnostics"));
      if (!res.ok) throw new Error(`The check itself failed (${res.status}).`);
      const body = (await res.json()) as { checks?: Check[] };
      setChecks(body.checks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the check.");
    } finally {
      setBusy(false);
    }
  }

  return (
    /* Headless for the same reason as OwnerSwitch: /billing/checks is its
       screen, and the screen's title already says what it is. */
    <section className="card border-amber-300 bg-amber-50/50">
      <button type="button" onClick={run} disabled={busy} className="btn-secondary w-full">
        {busy ? "Checking…" : "Run the check"}
      </button>

      {error && (
        <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-900">
          {error}
        </p>
      )}

      {checks && (
        <ul className="mt-3 space-y-1.5">
          {checks.map((c) => (
            <li key={c.name} className="flex gap-2.5 text-sm leading-6">
              <span aria-hidden="true" className={`mt-0.5 shrink-0 font-bold ${c.ok ? "text-emerald-600" : "text-rose-600"}`}>
                {c.ok ? "✓" : "✕"}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-slate-900">{c.name}</span>
                {/* The server's own words, wrapped rather than truncated — the
                    useful part of a Postgres error is usually at the end. */}
                <span className={`block break-words text-xs leading-5 ${c.ok ? "text-slate-500" : "text-rose-700"}`}>
                  {c.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
