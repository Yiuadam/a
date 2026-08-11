"use client";

import { useState } from "react";
import { SESSION_KEY } from "@/lib/account";

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
const KEEP_ACROSS_WIPE = [
  "bandup.theme",
  /*
    The session, which this screen promises in as many words not to touch:
    "This is not your account." Clearing the origin took the token with it and
    signed the learner out — so the sentence was false, and the one thing they
    were told was safe was the thing that broke. Imported rather than spelled
    again, so a rename cannot quietly reintroduce it.
  */
  SESSION_KEY,
];

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
    <section className="card !p-4 sm:!p-6">
      <h2 className="heading-rule mb-2 text-base font-semibold text-slate-900">
        Everything saved on this device
      </h2>
      {/*
        One line at rest, the whole explanation once the button is armed.

        Not a cut — every word below is still on the screen, at the moment it
        is worth reading. Four lines of consequence sitting above an unpressed
        button are four lines somebody scrolls past; the same four lines
        between "Clear this device" and "Yes, clear it" are the only thing on
        the screen they are deciding about. The first tap destroys nothing,
        which is what makes moving them legitimate.
      */}
      <p className="text-[14px] leading-6 text-slate-600">
        Clears your placement result, practice scores, study plan, saved words and drill progress
        from this browser, straight away.
      </p>

      {!armed ? (
        <button type="button" onClick={() => setArmed(true)} className="btn-secondary mt-3">
          Clear this device
        </button>
      ) : (
        <div className="mt-3 space-y-2 rounded-xl bg-rose-50 px-3 py-3">
          <p className="text-[14px] leading-6 text-rose-900">
            Clear everything saved in this browser? This cannot be undone here. Your theme and your
            sign-in are kept.
          </p>
          <p className="text-[13px] leading-5 text-rose-800/80">
            This is not your account. If you are signed in and your progress has synced, it will
            come back from the server next time you open the app — to remove it everywhere, delete
            your account below.
          </p>
          <div className="flex flex-wrap gap-2 pt-0.5">
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
        </div>
      )}
    </section>
  );
}
