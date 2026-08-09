"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";

/*
  Signing out, and closing the account for good.

  The two live together because they are the same question asked at two
  strengths — "stop using this here" and "stop existing" — and putting them
  side by side is what makes the difference between them obvious. Deletion is
  last on the page, because it is the one action that cannot be undone.
*/

export function SignOutSection({ onSignOut }: { onSignOut: () => void }) {
  return (
    <section className="card">
      <h3 className="text-[17px] font-semibold text-slate-900">Sign out</h3>
      <p className="mt-2 text-[15px] leading-7 text-slate-600">
        Your practice stays on this device. Signing out ends the session — it doesn&rsquo;t delete
        your placement result, your plan or your saved words.
      </p>
      <button type="button" className="btn-secondary mt-4" onClick={onSignOut}>
        Sign out
      </button>
    </section>
  );
}

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

  async function remove() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await authedFetch(apiUrl("/api/account/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setProblem(body.error ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      onDeleted();
    } catch {
      setProblem("That didn't work. Please try again.");
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3 className="text-[17px] font-semibold text-slate-900">Delete your account</h3>
      <p className="mt-2 text-[15px] leading-7 text-slate-600">
        This removes your account and everything stored against it — your email address, your
        details, your picture and any practice you have synced. It cannot be undone.
      </p>
      <p className="mt-3 text-[15px] leading-7 text-slate-600">
        The practice saved in this browser stays. It was never on our side to delete, and you can
        clear it yourself from your browser&rsquo;s settings whenever you like.
      </p>

      {!open ? (
        <button type="button" className="btn-secondary mt-4" onClick={() => setOpen(true)}>
          Delete my account
        </button>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <label htmlFor="confirm-delete" className="text-sm font-medium text-slate-700">
            Type DELETE to confirm
          </label>
          <input
            id="confirm-delete"
            className="input"
            value={confirm}
            autoComplete="off"
            onChange={(e) => setConfirm(e.target.value)}
          />
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
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
