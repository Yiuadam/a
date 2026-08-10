"use client";

import { useEffect, useRef, useState } from "react";

/*
  The exam clock, copied from the real one rather than from the idea of one.

  Four behaviours, and each is a decision the exam made on purpose:

  1. It sits top-centre. Not in a corner — the middle of the screen, where you
     cannot avoid it.

  2. It counts. Always, visibly, in minutes and seconds.

     This started as minutes-only with seconds on hover, which is what the real
     exam does — and it was wrong here for a reason worth writing down. On the
     real thing you have already been told how long you have and the clock has
     been running for twenty minutes; a number that changes once a minute reads
     as a clock. On a practice screen you have just pressed start, so a static
     "20 min" for the first sixty seconds reads as a clock that is broken. The
     owner said so within a minute of seeing it. Fidelity that makes somebody
     doubt the software is not fidelity worth having.

  3. It turns red and flashes when time is short. Not amber, not a subtle
     shift — the thing that makes people look up.

  It counts in wall-clock time rather than by counting ticks. A background tab
  throttles setInterval to once a minute in most browsers, so a tick-counting
  timer runs slow exactly when somebody has alt-tabbed away — which would make
  the practice easier than the exam and would be the one direction a practice
  clock must never be wrong in.
*/

export default function ExamTimer({
  minutes,
  running,
  onExpire,
}: {
  minutes: number;
  running: boolean;
  onExpire?: () => void;
}) {
  const [remaining, setRemaining] = useState(minutes * 60);
  const endsAt = useRef<number | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (!running) {
      endsAt.current = null;
      return;
    }
    /*
      Fixed at the moment the clock starts, then every tick is a subtraction
      from the real time rather than an accumulation of intervals. Set in the
      effect and not in render, because Date.now() in render is a value that
      cannot be replayed.
    */
    if (endsAt.current === null) endsAt.current = Date.now() + minutes * 60_000;
    const end = endsAt.current;

    const tick = () => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !fired.current) {
        fired.current = true;
        onExpire?.();
      }
    };
    tick();
    /* Twice a second, so a second never appears to be skipped or repeated. */
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running, minutes, onExpire]);

  const m = Math.floor(remaining / 60);
  const s = remaining % 60;

  /* Under five minutes is the exam's own warning point. */
  const low = remaining <= 5 * 60;
  const critical = remaining <= 60;

  return (
    <div className="select-none text-center">
      <div
        aria-hidden="true"
        className={`font-mono text-[19px] font-semibold tabular-nums transition-colors ${
          critical
            ? "animate-pulse text-rose-600"
            : low
              ? "text-rose-600"
              : "text-[color:var(--exam-fg)]"
        }`}
      >
        {m}:{s.toString().padStart(2, "0")}
      </div>
      {/*
        Announced separately and only every minute. A polite live region that
        changed every half second would read the clock aloud continuously,
        which is the opposite of helpful.
      */}
      <p className="sr-only" role="timer" aria-live="polite">
        {critical ? "Under one minute remaining" : `${Math.ceil(remaining / 60)} minutes remaining`}
      </p>
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--exam-muted)]">
        {running ? "time remaining" : "not started"}
      </div>
    </div>
  );
}
