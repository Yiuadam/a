"use client";

import Link from "next/link";
import { useState } from "react";
import { saveAccess } from "@/lib/access";
import { postJSON } from "@/lib/api";

/*
  The way in for a learner whose school paid.

  They have no card, no subscription and no account — just a code from a
  teacher — and they end up holding exactly the same access token a subscriber
  holds, so nothing downstream has to know which kind they are.
*/

export default function RedeemPage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seat, setSeat] = useState<number | null>(null);

  async function redeem(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await postJSON<{ token: string; expiresIn: number; seat: number }>(
        "/api/billing/redeem",
        { code },
      );
      saveAccess(data.token, data.expiresIn);
      setSeat(data.seat);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check that code.");
    } finally {
      setBusy(false);
    }
  }

  if (seat !== null) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-slate-900">You&rsquo;re in</h1>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5">
          <p className="text-sm text-slate-700">
            Seat {seat} is now active on this device. Writing marking, the speaking examiner,
            generated tests and word lookup are unlocked.
          </p>
          <Link
            href="/practice/writing"
            className="mt-4 inline-block rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-indigo-700"
          >
            Mark an essay
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Redeem a school code</h1>
        <p className="mt-2 text-slate-600">
          If your school or tutoring centre bought BandUp Plus, paste the code they gave you.
        </p>
      </header>

      <form onSubmit={redeem} className="rounded-2xl border border-slate-200 bg-surface p-5">
        <label htmlFor="code" className="block text-sm font-medium text-slate-700">
          Your code
        </label>
        <textarea
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="BU-…"
          className="mt-2 w-full rounded-xl border border-slate-300 bg-surface p-3 font-mono text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
        />
        <p className="mt-2 text-xs text-slate-500">
          Codes are long — paste the whole thing rather than typing it.
        </p>
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="mt-3 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      </form>

      <p className="text-sm text-slate-600">
        Buying for a class instead?{" "}
        <Link href="/pricing" className="underline">
          Seats and invoicing
        </Link>
        .
      </p>
    </div>
  );
}
