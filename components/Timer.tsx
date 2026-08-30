"use client";

import { useEffect, useRef, useState } from "react";

export default function Timer({
  minutes,
  running,
  onExpire,
}: {
  minutes: number;
  running: boolean;
  onExpire?: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(minutes * 60);
  const expired = useRef(false);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (secondsLeft === 0 && running && !expired.current) {
      expired.current = true;
      onExpire?.();
    }
  }, [secondsLeft, running, onExpire]);

  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  const low = secondsLeft <= 120;
  return (
    <span
      /*
        `tabular-nums` matters more than it looks: without it the digits are
        proportionally spaced and the whole pill twitches once a second, which
        is the last thing you want in the corner of your eye during a test.
      */
      className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 font-mono text-sm tabular-nums transition-colors ${
        low ? "border-rose-300 bg-rose-50 text-rose-700" : "border-slate-200 bg-surface text-slate-700"
      }`}
      title="Time remaining"
    >
      ⏱ {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}
