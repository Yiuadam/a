"use client";

import { useEffect, useRef, useState } from "react";

/*
  The exam clock, copied from the real one rather than from the idea of one.

  Four behaviours, and each is a decision the exam made on purpose:

  1. It sits top-centre. Not in a corner — the middle of the screen, where you
     cannot avoid it.

  2. It shows minutes only, and hovering expands it to minutes and seconds. A
     seconds display running all the time is a metronome for panic; a candidate
     who wants the precision can ask for it.

  3. Inside the last minute it stops showing seconds altogether. That is the
     real exam's behaviour and it is deliberately unnerving: you know it is
     nearly over and you do not know exactly when. Reproducing it is the point
     of practising under exam conditions.

  4. It turns red and flashes when time is short. Not amber, not a subtle
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
  const [showSeconds, setShowSeconds] = useState(false);
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
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running, minutes, onExpire]);

  const m = Math.floor(remaining / 60);
  const s = remaining % 60;

  /* Under five minutes is the exam's own warning point. */
  const low = remaining <= 5 * 60;
  const critical = remaining <= 60;

  /*
    The last minute shows no seconds, however much you hover. See note 3.
    Above it, hovering is what buys the precision.
  */
  const label = critical
    ? "under 1 minute"
    : showSeconds
      ? `${m}:${s.toString().padStart(2, "0")}`
      : `${Math.max(1, Math.ceil(remaining / 60))} min`;

  return (
    <div
      className="select-none text-center"
      onMouseEnter={() => setShowSeconds(true)}
      onMouseLeave={() => setShowSeconds(false)}
      /* Touch has no hover, so a tap does the same job. */
      onClick={() => setShowSeconds((v) => !v)}
    >
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
        {label}
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
