"use client";

import { useState, useSyncExternalStore } from "react";
import {
  getServerSnapshot as accountServerSnapshot,
  getSnapshot as accountSnapshot,
  SESSION_KEY,
  subscribe as subscribeToAccount,
} from "@/lib/account";
import LoadingIndicator from "@/components/LoadingIndicator";
import { clearSyncedProgress } from "@/lib/progress/sync";
import { useHistoryClearPolicy } from "@/lib/organizations/useHistoryClearPolicy";

/*
  Delete everything this browser is keeping.

  BandUp keeps a learner's working copy in this tab until they sign in, when
  the account becomes the durable copy. The privacy policy names every key.
  What the app did not have was a way to undo that from inside the app:
  clearing meant finding the right screen in browser settings, which most
  people cannot do and nobody should have to.

  Two things this deliberately is not:

    It is not "delete my account". That is a separate, server-side thing and it
      lives further down this page. This one clears this device and, while
      signed in, the synced copy of everything the learner owns — sittings,
      placement, drill scores, saved words — so none of it can immediately
      return from another device. The identity and profile remain.

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
  const access = useHistoryClearPolicy();
  const session = useSyncExternalStore(
    subscribeToAccount,
    accountSnapshot,
    accountServerSnapshot,
  );
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function wipe() {
    setDone(true);
    setError(null);

    if (session) {
      /*
        Do not call clearHistory() here. It mutates sessionStorage before the
        network request, so the old failure message ("Nothing else was
        cleared") was false and autosync could later upload the tombstone even
        after this screen reported failure.

        clearSyncedProgress submits a hypothetical cleared profile and changes
        the browser only after the account accepts it. This means an ordinary
        outage leaves the tab exactly as it was.
      */
      const sync = await clearSyncedProgress();
      if (sync.status !== "done") {
        setDone(false);
        if (sync.status === "restricted") {
          setError(
            "Your organisation currently keeps this history. Nothing was cleared.",
          );
        } else if (sync.status === "signed-out") {
          setError(
            "Your sign-in has expired. Nothing was cleared; sign in again and retry.",
          );
        } else {
          setError(
            "BandUp couldn't confirm the synced clear. This browser has kept its copy for now. Check your connection and retry.",
          );
        }
        return;
      }
    }

    try {
      const kept = KEEP_ACROSS_WIPE.map((k) => [k, window.localStorage.getItem(k)] as const);
      window.localStorage.clear();
      for (const [k, v] of kept) if (v !== null) window.localStorage.setItem(k, v);
      window.sessionStorage.clear();
    } catch {
      /* Storage disabled or full. Reloading is still the honest next step. */
    }
    /*
      A full reload rather than a re-render. Half a dozen stores are holding
      this data in memory; asking each to notice it has gone is more moving
      parts than reloading a page that now has nothing to load.
    */
    window.location.replace(new URL("/", window.location.href));
  }

  // Clearing this origin also clears history. Organization students therefore
  // cannot use the wider device wipe as a second route around the policy.
  if (access !== "allowed") return null;

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
      <p className="text-[0.875rem] leading-6 text-slate-600">
        Clears your placement result, practice scores, study plan, saved words, drill progress and
        any exam in progress from this browser, straight away.
      </p>

      {!armed ? (
        <button type="button" onClick={() => setArmed(true)} className="btn-secondary mt-3">
          Clear this device
        </button>
      ) : (
        <div className="mt-3 space-y-2 rounded-xl bg-rose-50 px-3 py-3">
          <p className="text-[0.875rem] leading-6 text-rose-900">
            Clear everything saved in this browser, including any exam in progress? This cannot be
            undone here. Your theme and your sign-in are kept.
          </p>
          {/*
            This used to promise only that "old sittings will not return",
            because only sittings had a tombstone and the placement, the
            drill scores and the saved words genuinely did come back on the
            next sync. All four are cleared on the account now, and the
            drill and saved-word records are deleted from it outright rather
            than left empty — so the sentence can finally say the whole
            thing instead of the one part that happened to be true.
          */}
          {session ? (
            <p className="text-[0.8125rem] leading-5 text-rose-800/80">
              This is not your account. BandUp clears the synced copy first — sittings, placement,
              drill scores and saved words — and deletes the drill and saved-word records from
              your account rather than emptying them, so none of it returns on another device.
              Your sign-in and account profile remain.
            </p>
          ) : (
            <p className="text-[0.8125rem] leading-5 text-rose-800/80">
              Only this browser is affected. There is no signed-in account to change.
            </p>
          )}
          {error ? (
            <p className="text-[0.8125rem] leading-5 text-rose-900" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void wipe()}
              disabled={done}
              className="btn-primary shrink-0"
            >
              {done ? (
                <LoadingIndicator label="Clearing…" announce={false} />
              ) : (
                "Yes, clear it"
              )}
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
