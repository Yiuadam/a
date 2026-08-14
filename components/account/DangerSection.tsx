"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import LoadingIndicator from "@/components/LoadingIndicator";

/*
  Closing the account for good.

  Signing out used to live here too, on the reasoning that the two are the same
  question at two strengths. They are — and giving them matching cards said
  they were comparable decisions, which they are not: one ends a session and
  one ends an account. Signing out is now a plain button on the screen itself
  (app/account/close/page.tsx) and this file keeps the irreversible half.
*/

/*
  Closing an account, which Apple requires to be possible from inside the app
  (guideline 5.1.1(v)) and which is right regardless: an account someone can
  open but not close is a one-way door.

  Two things the copy has to get right. It says what goes — everything on the
  account — and what does not: the practice in this browser, which was never
  ours to delete. And it asks for the word to be typed, because the button
  cannot be undone and a mis-tap should not be enough.
*/
export function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [deleted, setDeleted] = useState(false);

  async function remove() {
    setBusy(true);
    setProblem(null);
    setProgress("Checking everything linked to your account…");

    const request = new AbortController();
    const slower = window.setTimeout(() => {
      setProgress("Still checking every place your data is stored…");
    }, 6_000);
    let rejectDeadline: ((reason?: unknown) => void) | null = null;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timeout = window.setTimeout(() => {
      request.abort();
      rejectDeadline?.(new DOMException("Timed out", "AbortError"));
    }, 30_000);

    try {
      const response = authedFetch(apiUrl("/api/account/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
        signal: request.signal,
      });
      // `authedFetch` may refresh an expired session before it starts the
      // request. Bound the whole operation, not only the final fetch, so this
      // screen can never remain on an endless spinner.
      const res = await Promise.race([
        response,
        deadline,
      ]);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setProblem(body.error ?? "That didn't work. Please try again.");
        setBusy(false);
        setProgress(null);
        setRetrying(true);
        return;
      }
      setDeleted(true);
      setBusy(false);
      setProgress(null);
      onDeleted();
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      setProblem(timedOut
        ? "BandUp did not receive a final answer within 30 seconds. Deletion may still be finishing; press Check deletion status to safely continue."
        : "That didn't work. Please try again.");
      setBusy(false);
      setProgress(null);
      setRetrying(true);
    } finally {
      window.clearTimeout(slower);
      window.clearTimeout(timeout);
    }
  }

  return (
    <section className="card !p-4 sm:!p-6">
      <h3 className="text-[16px] font-semibold text-slate-900">Delete your account</h3>
      {/*
        The short version at rest and the full one behind the button, for the
        same reason as ClearDeviceSection: the words about what survives are
        worth reading while somebody types DELETE, and are scrolled past above
        a button they have not pressed. Nothing is removed — the second
        paragraph now sits inside the confirm step.
      */}
      <p className="mt-1.5 text-[14px] leading-6 text-slate-600">
        Removes your account and everything stored against it. It cannot be undone.
      </p>

      {deleted ? (
        <p
          className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[15px] leading-7 text-emerald-800"
          role="status"
        >
          <LoadingIndicator label="Your account was deleted. Returning to sign in…" announce={false} />
        </p>
      ) : !open ? (
        <button type="button" className="btn-secondary mt-3" onClick={() => setOpen(true)}>
          Delete my account
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[14px] leading-6 text-slate-600">
            Your email address, your details, your picture and any practice you have synced all go.
            The practice saved in this browser stays — it was never on our side to delete, and you
            can clear it from your browser&rsquo;s settings whenever you like.
          </p>
          <label htmlFor="confirm-delete" className="text-sm font-medium text-slate-700">
            Type DELETE to confirm
          </label>
          <input
            id="confirm-delete"
            className="input"
            value={confirm}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {progress && (
            <p className="text-[14px] leading-6 text-slate-600" role="status" aria-live="polite">
              <LoadingIndicator label={progress} announce={false} />
            </p>
          )}
          {problem && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[15px] leading-7 text-rose-800">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn border border-rose-300 bg-rose-50 text-sm text-rose-800 hover:bg-rose-100 disabled:opacity-50"
              disabled={busy || confirm.trim().toUpperCase() !== "DELETE"}
              onClick={remove}
            >
              {busy ? <LoadingIndicator label="Deleting securely…" announce={false} /> : retrying ? "Check deletion status" : "Delete permanently"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
