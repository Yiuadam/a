"use client";

import { useId, useSyncExternalStore } from "react";
import {
  pronunciationSnapshot,
  serverPronunciationSnapshot,
  speakPronunciation,
  stopPronunciation,
  subscribePronunciation,
} from "@/lib/pronunciation";

type PronunciationButtonProps = {
  term: string;
  /** Show a compact text label when there is room, such as the lookup panel. */
  showLabel?: boolean;
  /** Show a visible explanation if the device cannot currently play audio. */
  showStatus?: boolean;
  className?: string;
};

function statusText(
  term: string,
  status: "idle" | "starting" | "playing" | "busy" | "unavailable",
  currentTerm: string | null,
): string {
  if (currentTerm !== term) return "";
  if (status === "starting") return `Starting the pronunciation of ${term}.`;
  if (status === "playing") return `Playing the pronunciation of ${term}.`;
  if (status === "busy") return "Another audio clip is playing. Try this pronunciation when it has finished.";
  if (status === "unavailable") return "Could not start pronunciation audio. Check this tab's sound permission and connection, then try again.";
  return "";
}

export default function PronunciationButton({
  term,
  showLabel = false,
  showStatus = false,
  className = "",
}: PronunciationButtonProps) {
  const snapshot = useSyncExternalStore(
    subscribePronunciation,
    pronunciationSnapshot,
    serverPronunciationSnapshot,
  );
  const statusId = useId();
  const playing = (snapshot.status === "starting" || snapshot.status === "playing") && snapshot.term === term;
  const feedback = statusText(term, snapshot.status, snapshot.term);

  const onClick = () => {
    if (playing) {
      stopPronunciation();
      return;
    }
    void speakPronunciation(term);
  };

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={playing}
        aria-describedby={feedback ? statusId : undefined}
        aria-label={playing ? `Stop pronunciation of ${term}` : `Listen to the pronunciation of ${term}`}
        title={playing ? "Stop pronunciation" : "Listen to pronunciation"}
        data-lookup-pronunciation-button
        className={`inline-flex min-h-8 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 motion-safe:transition-colors motion-reduce:transition-none ${
          playing
            ? "border border-indigo-300 bg-indigo-100 text-indigo-900 shadow-sm hover:bg-indigo-200"
            : snapshot.term === term && snapshot.status !== "idle"
              ? "border border-amber-200 bg-amber-50 text-amber-900 shadow-sm hover:bg-amber-100"
              : "border border-indigo-200 bg-indigo-50 text-indigo-800 shadow-sm hover:bg-indigo-100 hover:text-indigo-950"
        }`}
      >
        {playing ? (
          <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
            <rect x="4" y="4" width="8" height="8" rx="1" />
          </svg>
        ) : (
          <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
            <path d="M2 6.25h2.5L8 3.5v9L4.5 9.75H2z" />
            <path d="M10.1 5.15a4.1 4.1 0 0 1 0 5.7l1.05 1.05a5.6 5.6 0 0 0 0-7.8z" />
          </svg>
        )}
        {showLabel && <span>{playing ? (snapshot.status === "starting" ? "Starting…" : "Stop") : "Listen"}</span>}
      </button>
      <span
        id={statusId}
        role="status"
        aria-live="polite"
        className={showStatus && feedback ? "text-xs leading-5 text-slate-500" : "sr-only"}
      >
        {feedback}
      </span>
    </span>
  );
}
