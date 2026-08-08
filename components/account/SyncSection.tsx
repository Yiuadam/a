"use client";

import { useState } from "react";
import { useMounted } from "@/lib/hooks";
import { syncProgress, lastSyncedAt, type SyncOutcome } from "@/lib/progress/sync";

/*
  Practice carried between devices.

  Moved out of AccountPanel with the rest of the split, and it belongs to
  neither of the two halves that split created: it is not who you are and it is
  not what you are paying for. It gets its own heading on the page for exactly
  that reason, rather than being tucked under one of them where nobody would
  think to look for it.
*/
export default function SyncSection() {
  const [state, setState] = useState<"idle" | "working" | SyncOutcome["status"]>("idle");
  /*
    Read during render rather than held in state. localStorage does not exist
    on the server, so a plain initial value would hydrate to a different string
    than it rendered with; useMounted is the codebase's answer to that and
    costs no effect. Re-reading after a sync happens for free, because setState
    above already re-renders this component.
  */
  const mounted = useMounted();
  const at = mounted ? lastSyncedAt() : null;

  async function run() {
    setState("working");
    const outcome = await syncProgress();
    setState(outcome.status);
  }

  return (
    <section className="card">
      <p className="text-[15px] leading-7 text-slate-600">
        This happens by itself: finish a practice on any device you are signed in on, and a few
        seconds later it is on your account and on your other devices. Nothing is replaced and
        nothing is deleted — practise on your phone and your laptop and you end up with both.
      </p>

      {/* The automatic path covers everything; this exists for the moment a
          learner wants to *see* it work rather than trust that it did. */}
      <button
        type="button"
        className="btn-primary mt-4"
        onClick={run}
        disabled={state === "working"}
      >
        {state === "working" ? "Syncing…" : "Sync again now"}
      </button>

      {state === "done" && (
        <p className="mt-3 text-[15px] leading-7 text-emerald-800">
          Done. Your practice is on your account and on this device.
        </p>
      )}
      {state === "unavailable" && (
        <p className="mt-3 text-[15px] leading-7 text-slate-600">
          {/* Says plainly that nothing was lost, because that is the fear. */}
          That didn&rsquo;t work. Nothing has changed on this device — your practice is exactly
          where it was. Please try again in a minute.
        </p>
      )}
      {state === "signed-out" && (
        <p className="mt-3 text-[15px] leading-7 text-slate-600">
          Your session expired. Sign in again and this will work.
        </p>
      )}

      {at && <p className="mt-3 text-sm text-slate-500">Last synced {new Date(at).toLocaleString()}</p>}
    </section>
  );
}
