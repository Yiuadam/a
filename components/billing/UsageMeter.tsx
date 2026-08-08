"use client";

import { useSyncExternalStore } from "react";

/*
  How much of today's AI allowance is gone, and when some of it comes back.

  ---------------------------------------------------------------------------
  The bar

  It fills toward the limit rather than draining away from it, because the
  question a learner actually has is "how much have I used", and a bar that
  empties makes running out look like something being taken. The number beside
  it is stated both ways — "14 of 20 used, 6 left" — because people read one or
  the other and neither of them is wrong.

  Colour is a second channel, never the only one: the percentage is written out
  and the state is named in words, so the bar still means something in
  greyscale, to a colourblind reader, and to a screen reader.

  ---------------------------------------------------------------------------
  "Resets in" is the hard part, and it is worth being exact

  There is no reset. The window is a rolling 24 hours — see
  lib/usage/limits.ts, where it is a deliberate choice: no midnight cliff, no
  argument about whose timezone midnight is in. Each request expires 24 hours
  after the moment it was made, one at a time.

  So this does not say "resets at midnight", because that would be a lie a
  learner could plan around and be wrong about. It says when the *oldest*
  request expires, which is the true answer to "when do I get some back", and
  it says "one request" rather than "your allowance" so nobody expects the
  whole thing to return at once.

  The countdown ticks client-side once a minute. Minute resolution, not
  seconds: a second-by-second countdown on an allowance nobody is racing is
  movement for its own sake, and it would re-render the page 1,440 times an
  hour to say nothing.
*/

function formatGap(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0
      ? `in ${hours} hour${hours === 1 ? "" : "s"}`
      : `in ${hours}h ${rest}m`;
  }
  return "in about a day";
}

/*
  A clock that ticks once a minute, as an external store rather than state.

  It cannot be `useState` plus a `setInterval` in an effect: the first tick has
  to happen on mount to get past the server's null, and setting state inside an
  effect body is exactly what react-hooks/set-state-in-effect rejects — for
  good reason, since it is a second render every component below pays for.

  Two details that matter more than they look:

  The snapshot is quantised to the minute. getSnapshot must return the same
  value every time it is called between ticks; returning a raw Date.now() means
  a different number on every call, and React re-renders forever looking for it
  to settle.

  The server snapshot is null, not a time. The server has no idea when the
  reader's browser will paint this, so any timestamp it produced would be a
  countdown that is already wrong by the time it is read, and the two renders
  would disagree. Null renders no countdown for one frame, and then the real
  one arrives.
*/
const MINUTE = 60_000;

function subscribeToMinute(onChange: () => void): () => void {
  const id = setInterval(onChange, MINUTE);
  return () => clearInterval(id);
}

function minuteNow(): number {
  return Math.floor(Date.now() / MINUTE) * MINUTE;
}

function noClockOnTheServer(): null {
  return null;
}

function useMinuteClock(): number | null {
  return useSyncExternalStore(subscribeToMinute, minuteNow, noClockOnTheServer);
}

const ROUTE_NAMES: Record<string, string> = {
  define: "Word lookups",
  chat: "Tutor questions",
  "grade/writing": "Essays marked",
  "grade/speaking": "Speaking marked",
  generate: "Tests generated",
};

export default function UsageMeter({
  used,
  quota,
  windowSeconds,
  oldestAt,
  byRoute,
}: {
  used: number;
  /** null means no cap — the owner's own account. */
  quota: number | null;
  windowSeconds: number;
  oldestAt: string | null;
  byRoute: Record<string, number>;
}) {
  const now = useMinuteClock();

  if (quota === null) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-surface p-4">
        <p className="text-sm text-slate-600">
          No limit on this account. {used} request{used === 1 ? "" : "s"} in the last 24 hours.
        </p>
      </div>
    );
  }

  const left = Math.max(0, quota - used);
  const pct = quota === 0 ? 100 : Math.min(100, Math.round((used / quota) * 100));

  /* Named states, so the colour is never carrying the meaning alone. */
  const state = left === 0 ? "spent" : pct >= 80 ? "low" : "fine";
  const bar =
    state === "spent" ? "bg-rose-600" : state === "low" ? "bg-amber-500" : "bg-indigo-600";
  const note =
    state === "spent"
      ? "You have used today's allowance."
      : state === "low"
        ? "Running low."
        : null;

  const expiresAt = oldestAt ? Date.parse(oldestAt) + windowSeconds * 1000 : null;
  const spentOn = Object.entries(byRoute)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-900">AI requests</h3>
        <p className="text-sm tabular-nums text-slate-600">
          <span className="font-semibold text-slate-900">{used}</span> of {quota} used
          <span className="text-slate-400"> · </span>
          {left} left
        </p>
      </div>

      <div
        className="mt-2.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% of your daily AI allowance used, ${left} of ${quota} remaining`}
      >
        <div className={`h-full rounded-full ${bar} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>

      <p className="mt-2 text-sm text-slate-600">
        <span className="font-medium tabular-nums text-slate-800">{pct}%</span>
        {note && <span className={state === "spent" ? " text-rose-700" : " text-amber-700"}> · {note}</span>}
        {expiresAt !== null && now !== null && (
          <>
            {" · "}
            {/*
              "one request comes back", not "resets". The window rolls; see the
              note at the top of this file.
            */}
            one request comes back {formatGap(expiresAt - now)}
          </>
        )}
      </p>

      {spentOn.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-xs text-slate-500">
          {spentOn.map(([route, n]) => (
            <div key={route} className="flex gap-1.5">
              <dt>{ROUTE_NAMES[route] ?? route}</dt>
              <dd className="font-semibold tabular-nums text-slate-700">{n}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-3 text-xs leading-5 text-slate-500">
        One allowance covers everything: essay marking, speaking marking, word lookups, generated
        tests and tutor questions all draw on the same count. It is a rolling 24 hours rather than a
        daily reset, so each request frees itself up 24 hours after you make it.
      </p>
    </div>
  );
}
