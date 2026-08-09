"use client";

import { useSyncExternalStore } from "react";
import {
  PREVIEW_TIERS,
  previewOnServer,
  readPreview,
  setPreview,
  subscribePreview,
  type PreviewTier,
} from "@/lib/billing/preview";

/*
  The owner's switch, shown only to the owner.

  It runs the whole range rather than being an on/off toggle, because "off" and
  "on" are the same control seen from two sides. The owner's normal state is no
  limits at all, which is what "Owner" means here and what it sits on unless
  moved. Moving it down the list is the thing that was actually impossible
  before: looking at your own locks, counters and paywall without signing out
  of the account you need to be signed into.

  Radios rather than a toggle for the same reason — four states, one visible at
  a time, each labelled with what it does rather than what it is called.

  Rendered as a fieldset so a screen reader announces the group before the
  options, and the current one is the checked radio rather than a colour.
*/

export default function OwnerSwitch() {
  const preview = useSyncExternalStore(subscribePreview, readPreview, previewOnServer);
  const current: PreviewTier = preview ?? "admin";

  return (
    <section className="card border-amber-300 bg-amber-50/50">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-slate-900">Owner controls</h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
          Only you can see this
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-6 text-slate-600">
        Your account has no limits on anything. This switches what you{" "}
        <em className="not-italic font-semibold">see</em>, so you can check the locks and the
        paywall without signing out.
      </p>

      <fieldset className="mt-3">
        <legend className="sr-only">View the app as</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PREVIEW_TIERS.map((t) => {
            const on = t.id === current;
            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors ${
                  on
                    ? "border-indigo-400 bg-surface"
                    : "border-slate-200 bg-surface/60 hover:border-slate-300"
                }`}
              >
                <input
                  type="radio"
                  name="owner-preview"
                  value={t.id}
                  checked={on}
                  onChange={() => setPreview(t.id)}
                  className="mt-1 h-4 w-4 shrink-0 accent-indigo-600"
                />
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium text-slate-900">{t.label}</span>
                  <span className="block text-xs leading-5 text-slate-500">{t.note}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {current !== "admin" && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-amber-100/70 px-3 py-2">
          <p className="min-w-0 flex-1 text-sm leading-6 text-amber-900">
            You are viewing the app as <strong>{PREVIEW_TIERS.find((t) => t.id === current)?.label}</strong>.
            The limits you can see are drawn, not real — the server still treats you as the owner.
          </p>
          <button type="button" onClick={() => setPreview(null)} className="btn-secondary shrink-0">
            Back to no limits
          </button>
        </div>
      )}
    </section>
  );
}
