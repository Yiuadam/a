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
    /*
      No heading of its own. It has a screen now — /billing/owner — and the
      screen's title says what this is; a card that repeats its own page's
      title costs a phone two lines to tell somebody where they already know
      they are.
    */
    <section className="card border-amber-300 bg-amber-50/50">
      <fieldset>
        <legend className="sr-only">View the app as</legend>
        {/*
          Two across on a phone as well, not one. Six options in a column is
          six rows of a screen that has to hold the explanation above them
          too; the labels are one or two words and the note under each is a
          short phrase, so they read fine at half width.
        */}
        <div className="grid grid-cols-2 gap-2">
          {PREVIEW_TIERS.map((t) => {
            const on = t.id === current;
            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-2 transition-colors sm:gap-2.5 sm:px-3 sm:py-2.5 ${
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
                  <span className="block text-[0.875rem] font-medium text-slate-900 sm:text-[0.9375rem]">
                    {t.label}
                  </span>
                  <span className="block text-[0.6875rem] leading-4 text-slate-500 sm:text-xs sm:leading-5">
                    {t.note}
                  </span>
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
