"use client";

import { useState } from "react";

/*
  Delete everything this browser is keeping.

  BandUp stores a learner's progress in localStorage and nowhere else until
  they sign in — the privacy policy names every key. What it did not have was a
  way to undo that from inside the app: clearing meant finding the right screen
  in browser settings, which most people cannot do and nobody should have to.

  Two things this deliberately is not:

    It is not "delete my account". That is a separate, server-side thing and it
      lives further down this page. This one touches this device only, and says
      so, because somebody who taps the wrong one should still have their
      account.

    It is not silent. A signed-in learner whose progress is synced will get it
      back from the server on the next load, and being surprised by that is
      worse than being warned about it. So the warning names that case.

  The confirm step is a second tap rather than a window.confirm: the browser
  dialog cannot be styled, cannot say which device it means, and on iOS it
  arrives detached from the thing it is about.
*/

/*
  Every key the app writes. Kept complete by hand, which is a real risk — a new
  key added elsewhere and not added here would survive a "delete everything".
  So the button does not use this list to decide *what* to remove; it uses it
  to decide what to *keep*, by clearing the whole origin and then putting the
  theme back. Anything new is therefore deleted by default, which is the safe
  direction to be wrong in.
*/
const KEEP_ACROSS_WIPE = ["bandup.theme"];

export default function ClearDeviceSection() {
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState(false);

  function wipe() {
    try {
      const kept = KEEP_ACROSS_WIPE.map((k) => [k, window.localStorage.getItem(k)] as const);
      window.localStorage.clear();
      for (const [k, v] of kept) if (v !== null) window.localStorage.setItem(k, v);
      window.sessionStorage.clear();
    } catch {
      /* Storage disabled or full. Reloading is still the honest next step. */
    }
    setDone(true);
    /*
      A full reload rather than a re-render. Half a dozen stores are holding
      this data in memory; asking each to notice it has gone is more moving
      parts than reloading a page that now has nothing to load.
    */
    window.location.href = "/";
  }

  return (
    <section className="card">
      <h2 className="heading-rule mb-2 text-base font-semibold text-slate-900">
        Everything saved on this device
      </h2>
      <p className="text-[15px] leading-7 text-slate-600">
        Your placement result, practice scores, study plan, saved words and drill progress are kept
        in this browser. This clears all of it, here, straight away. Your theme is kept.
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-500">
        This is not your account. If you are signed in and your progress has synced, it will come
        back from the server next time you open the app — to remove it everywhere, delete your
        account below.
      </p>

      {!armed ? (
        <button type="button" onClick={() => setArmed(true)} className="btn-secondary mt-4">
          Clear this device
        </button>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-rose-50 px-3 py-2">
          <p className="min-w-0 flex-1 text-sm leading-6 text-rose-900">
            Clear everything saved in this browser? This cannot be undone here.
          </p>
          <button type="button" onClick={wipe} disabled={done} className="btn-primary shrink-0">
            {done ? "Clearing…" : "Yes, clear it"}
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            disabled={done}
            className="btn-secondary shrink-0"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
