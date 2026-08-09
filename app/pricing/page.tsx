"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import {
  clearAccess,
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from "@/lib/access";
import { postJSON } from "@/lib/api";

/*
  The one place money is asked for.

  The price is read from configuration rather than written here, because a
  number in JSX and a number in the Stripe dashboard drift apart the first time
  one of them changes, and the one a learner is actually charged is Stripe's.
  When it is not set the page says so instead of inventing a figure.
*/
const PRICE_LABEL = process.env.NEXT_PUBLIC_PLUS_PRICE_LABEL ?? "";

const INCLUDED = [
  "Writing marked against the four official criteria, with your weakest paragraph rewritten a band higher",
  "A full three-part speaking interview, graded, with a band-8 model answer",
  "New reading and listening tests generated on demand, at the level and topic you choose",
  "Tap any word anywhere for an explanation in context",
] as const;

const FREE = [
  "The adaptive placement test and your band estimate",
  "Four reading papers and four listening tests, auto-marked",
  "Your four-week study plan",
  "Grammar and vocabulary drills, and the offline glossary",
] as const;

export default function PricingPage() {
  const access = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string) {
    setBusy(true);
    setError(null);
    try {
      const { url } = await postJSON<{ url: string }>(path, {
        token: access?.token,
      });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">BandUp Plus</h1>
        <p className="mt-2 text-slate-600">
          Everything that needs an examiner. The rest of BandUp stays free, for good.
        </p>
      </header>

      {access ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5">
          <h2 className="text-base font-semibold text-slate-900">Plus is active on this device</h2>
          <p className="mt-2 text-sm text-slate-600">
            Change your card, see past invoices or cancel from the billing portal. Cancelling
            leaves your access running until the end of the period you have paid for.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => go("/api/billing/portal")}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:opacity-60"
            >
              {busy ? "Opening…" : "Manage billing"}
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
      ) : (
        <section className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">Plus</h2>
            <p className="text-sm font-medium text-slate-700">
              {PRICE_LABEL || "Price shown at checkout"}
            </p>
          </div>
          <ul className="mt-3 space-y-2">
            {INCLUDED.map((line) => (
              <li key={line} className="flex gap-2 text-sm text-slate-700">
                <span aria-hidden className="text-indigo-600">
                  ✓
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => go("/api/billing/checkout")}
            className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
          >
            {busy ? "Taking you to Stripe…" : "Subscribe"}
          </button>
          <p className="mt-3 text-xs text-slate-500">
            Payment is handled by Stripe. Your card details never reach BandUp.
          </p>
        </section>
      )}

      {error && <p className="text-sm text-rose-600">{error}</p>}

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

      <section className="rounded-2xl border border-slate-200 bg-surface p-5">
        <h2 className="text-base font-semibold text-slate-900">Schools and tutoring centres</h2>
        <p className="mt-2 text-sm text-slate-600">
          Seats are sold in blocks and invoiced, payable by card or bank transfer on your own
          terms. Each learner gets a code and needs no card of their own.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href="mailto:hello@bandup.life?subject=BandUp%20Plus%20for%20schools"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-700"
          >
            Ask for a quote
          </a>
          <Link
            href="/redeem"
            className="rounded-xl border border-slate-300 bg-surface px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
          >
            Redeem a school code
          </Link>
        </div>
      </section>
    </div>
  );
}
