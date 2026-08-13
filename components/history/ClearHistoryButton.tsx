"use client";

import { useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { clearHistory } from "@/lib/store";
import { syncProgress } from "@/lib/progress/sync";
import { useHistoryClearPolicy } from "@/lib/organizations/useHistoryClearPolicy";

export default function ClearHistoryButton() {
  const access = useHistoryClearPolicy();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function clear() {
    setBusy(true);
    setMessage(null);
    clearHistory();
    const outcome = await syncProgress();
    setBusy(false);
    setArmed(false);
    setMessage(
      outcome.status === "unavailable"
        ? "Cleared here. Account sync will retry automatically."
        : "History cleared. Only new sittings will be saved.",
    );
  }

  // A button that appears before permission arrives can still be clicked.
  // Draw nothing until the server has positively allowed this account.
  if (access !== "allowed") return null;

  if (!armed) {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-secondary min-h-9 px-3 py-1.5 text-xs"
          onClick={() => setArmed(true)}
        >
          Clear all history
        </button>
        {message ? (
          <span className="text-xs leading-5 text-slate-500" role="status">
            {message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-xl)] border border-rose-200 bg-rose-50/70 px-3 py-2">
      <span className="text-xs leading-5 text-rose-900">
        Delete every saved practice score, review and mock report? This cannot be undone.
      </span>
      <button
        type="button"
        className="btn-primary min-h-9 px-3 py-1.5 text-xs"
        onClick={() => void clear()}
        disabled={busy}
      >
        {busy ? <LoadingIndicator label="Clearing…" announce={false} /> : "Yes, clear all"}
      </button>
      <button
        type="button"
        className="btn-secondary min-h-9 px-3 py-1.5 text-xs"
        onClick={() => setArmed(false)}
        disabled={busy}
      >
        Cancel
      </button>
    </div>
  );
}
