"use client";

import { useState, useSyncExternalStore } from "react";
import {
  clearAccess,
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from "@/lib/access";
import { postJSON } from "@/lib/api";
import { PLAN_IDS, PLANS, type Interval, type PlanId } from "@/lib/plans";

/*
  The one place money is asked for.

  Prices are read from configuration rather than written here, because a number
  in JSX and a number in the Stripe dashboard drift apart the first time one of
  them changes, and the one a learner is actually charged is Stripe's. What is
  written here is what each plan *includes*, which comes from lib/plans.ts —
  the same numbers the server meters against, so the page cannot promise an
  allowance the gate will not honour.
*/

/** Optional display prices, e.g. NEXT_PUBLIC_PRICE_STANDARD_MONTHLY="HK$19". */
const LABELS: Record<PlanId, Record<Interval, string>> = {
  standard: {
    monthly: process.env.NEXT_PUBLIC_PRICE_STANDARD_MONTHLY ?? "",
    quarterly: process.env.NEXT_PUBLIC_PRICE_STANDARD_QUARTERLY ?? "",
  },
  plus: {
    monthly: process.env.NEXT_PUBLIC_PRICE_PLUS_MONTHLY ?? "",
    quarterly: process.env.NEXT_PUBLIC_PRICE_PLUS_QUARTERLY ?? "",
  },
  pro: {
    monthly: process.env.NEXT_PUBLIC_PRICE_PRO_MONTHLY ?? "",
    quarterly: process.env.NEXT_PUBLIC_PRICE_PRO_QUARTERLY ?? "",
  },
};

const FREE = [
  "The adaptive placement test and your band estimate",
  "Four reading papers and four listening tests, auto-marked",
  "Your four-week study plan",
  "Grammar and vocabulary drills, and the offline glossary",
] as const;

export default function PricingPage() {
  const access = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [interval, setInterval] = useState<Interval>("quarterly");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, body: object, key: string) {
    setBusy(key);
    setError(null);
    try {
      const { url } = await postJSON<{ url: string }>(path, body);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Plans</h1>
        <p className="mt-2 text-slate-600">
          Everything that needs an examiner. The rest of BandUp stays free, for good.
        </p>
      </header>

      {access && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5">
          <h2 className="text-base font-semibold text-slate-900">
            {access.planName ? `${access.planName} is active on this device` : "Your plan is active"}
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Change your card, see past invoices, switch plan or cancel from the billing portal.
            Switching plan takes effect immediately and Stripe prorates the difference.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => go("/api/billing/portal", { token: access.token }, "portal")}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:opacity-60"
            >
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
            <button
              type="button"
              onClick={() => clearAccess()}
              className="rounded-xl border border-slate-300 bg-surface px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
            >
              Sign out of this device
            </button>
          </div>
        </section>
      )}

      <div
        role="radiogroup"
        aria-label="Billing period"
        className="inline-flex items-center gap-0.5 rounded-xl border border-slate-200 bg-surface p-0.5"
      >
        {(["monthly", "quarterly"] as Interval[]).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={interval === option}
            onClick={() => setInterval(option)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              interval === option
                ? "bg-indigo-600 text-accent-fg shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {option}
            {option === "quarterly" && <span className="ml-1 text-xs opacity-80">save 25%</span>}
          </button>
        ))}
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const plan = PLANS[id];
          const label = LABELS[id][interval];
          const current = access?.plan === id;
          return (
            <div
              key={id}
              className={`rounded-2xl border p-5 ${
                id === "plus" ? "border-indigo-300 bg-indigo-50/60" : "border-slate-200 bg-surface"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-900">{plan.name}</h2>
                {id === "plus" && (
                  <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
                    Popular
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm font-medium text-slate-700">
                {label || "Price shown at checkout"}
              </p>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
                <li>{plan.allowance.marking} essays or speaking tests marked</li>
                <li>{plan.allowance.generation} tests generated on demand</li>
                <li>{plan.allowance.lookup} word lookups</li>
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Per billing period. Unused allowance does not roll over.
              </p>
              <button
                type="button"
                disabled={busy !== null || current}
                onClick={() => go("/api/billing/checkout", { plan: id, interval }, id)}
                className={`mt-4 w-full rounded-xl px-4 py-2 text-sm font-semibold shadow-sm transition-colors disabled:opacity-60 ${
                  id === "plus"
                    ? "bg-indigo-600 text-accent-fg hover:bg-indigo-700"
                    : "bg-slate-900 text-white hover:bg-slate-700"
                }`}
              >
                {current ? "Your plan" : busy === id ? "Taking you to Stripe…" : `Choose ${plan.name}`}
              </button>
            </div>
          );
        })}
      </section>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <p className="text-xs text-slate-500">
        Payment is handled by Stripe. Your card details never reach BandUp.
      </p>

      <section className="rounded-2xl border border-slate-200 bg-surface p-5">
        <h2 className="text-base font-semibold text-slate-900">Free, with no account</h2>
        <ul className="mt-3 space-y-2">
          {FREE.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-slate-700">
              <span aria-hidden className="text-slate-400">
                ✓
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
