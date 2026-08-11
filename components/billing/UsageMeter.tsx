"use client";

import { useSyncExternalStore } from "react";
import { formatUsageDate, nextUsageReturnAt } from "@/lib/billing/usage-dates";

/*
  How much of each month's AI allowance is gone, and when some of it comes back.

  ---------------------------------------------------------------------------
  Five bars, not one

  There used to be one bar over one shared allowance. It could not be costed —
  see lib/billing/tiers.ts — and it could not be acted on either: "18 of 20"
  told a learner they were nearly out and nothing about what to stop doing.

  One bar per route says both. It also has to show the routes with a zero
  allowance rather than hiding them, because a hidden row reads as a feature
  that does not exist, and what is actually true is that it exists and is on a
  higher plan.

  ---------------------------------------------------------------------------
  Each bar

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

  There is no reset. The windows are rolling — a week and 30 days, both of them
  — see lib/usage/limits.ts, where it is a deliberate choice: no reset day, no
  argument about whose calendar month it is, and no subscriber who joins on the
  28th getting three days of allowance for a month of money. Each request
  expires a week and then a month after the moment it was made, one at a time.

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
  const days = Math.round(hours / 24);
  return days <= 1 ? "in about a day" : `in about ${days} days`;
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

/** One allowance, as /api/account/status reports it. */
export interface RouteUsage {
  route: string;
  label: string;
  used: number;
  quota: number | null;
  remaining: number | null;
}

/*
  One row. Three shapes, because a row means three different things:

    no cap        the owner's own account — a count and no bar, because a full
                  bar would read as "you have run out".
    zero cap      the plan does not include this. Said in words, with no bar at
                  all: an empty bar would read as "you have used none of it",
                  which is true and misleading.
    a real cap    the bar, both numbers, and the state named in words.
*/
function RouteRow({ usage }: { usage: RouteUsage }) {
  const { label, used, quota } = usage;

  if (quota === null) {
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <span className="text-sm text-slate-700">{label}</span>
        <span className="text-sm tabular-nums text-slate-500">{used} used · no limit</span>
      </div>
    );
  }

  if (quota === 0) {
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <span className="text-sm text-slate-400">{label}</span>
        <span className="text-sm text-slate-400">Not on your plan</span>
      </div>
    );
  }

  const left = Math.max(0, quota - used);
  const pct = Math.min(100, Math.round((used / quota) * 100));

  /* Named states, so the colour is never carrying the meaning alone. */
  const state = left === 0 ? "spent" : pct >= 80 ? "low" : "fine";
  const bar =
    state === "spent" ? "bg-rose-600" : state === "low" ? "bg-amber-500" : "bg-indigo-600";

  return (
    <div className="py-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm text-slate-700">{label}</span>
        <span className="text-sm tabular-nums text-slate-600">
          <span className="font-semibold text-slate-900">{used}</span> of {quota}
          <span className="text-slate-400"> · </span>
          {left} left
        </span>
      </div>
      <div
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${pct}% used, ${left} of ${quota} left this month`}
      >
        <div
          className={`h-full rounded-full ${bar} transition-[width] duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {state !== "fine" && (
        <p className={`mt-1 text-xs ${state === "spent" ? "text-rose-700" : "text-amber-700"}`}>
          {state === "spent" ? "You have used this month's allowance." : "Running low."}
        </p>
      )}
    </div>
  );
}

export default function UsageMeter({
  routes,
  windowSeconds,
  oldestAt,
  planRenewsAt,
}: {
  routes: RouteUsage[];
  windowSeconds: number;
  oldestAt: string | null;
  planRenewsAt: string | null;
}) {
  const now = useMinuteClock();

  if (routes.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-surface p-4">
        <p className="text-sm text-slate-600">Your usage isn&rsquo;t loading just now.</p>
      </div>
    );
  }

  const uncapped = routes.every((r) => r.quota === null);
  const nothingIncluded = routes.every((r) => r.quota === 0);
  const returnsAt = nextUsageReturnAt(oldestAt, windowSeconds);
  const renewalAt = planRenewsAt ? Date.parse(planRenewsAt) : null;
  const validRenewalAt = renewalAt !== null && Number.isFinite(renewalAt) ? renewalAt : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
        <h3 className="text-sm font-semibold text-slate-900">AI allowance</h3>
        {now !== null && (
          <dl className="grid gap-1 text-xs leading-5 text-slate-500">
            {returnsAt !== null && !uncapped && !nothingIncluded && (
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt>Next usage returns</dt>
                <dd className="font-medium tabular-nums text-slate-700">
                  <time dateTime={new Date(returnsAt).toISOString()}>
                    {formatUsageDate(returnsAt)}
                  </time>
                  <span className="font-normal text-slate-500"> ({formatGap(returnsAt - now)})</span>
                </dd>
              </div>
            )}
            {validRenewalAt !== null && (
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt>Plan renews</dt>
                <dd className="font-medium tabular-nums text-slate-700">
                  <time dateTime={new Date(validRenewalAt).toISOString()}>
                    {formatUsageDate(validRenewalAt)}
                  </time>
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      <div className="mt-2 divide-y divide-slate-100">
        {routes.map((usage) => (
          <RouteRow key={usage.route} usage={usage} />
        ))}
      </div>

      {/* One line. The detail is true and it is not worth four lines of a card. */}
      <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-500">
        {uncapped
          ? "No limits on this account."
          : nothingIncluded
            ? "Practice tests, drills and your study plan are unlimited on every plan, and never count towards this."
            : "There is no single reset date. Each request returns 30 days after you use it; the next exact return is shown above. Practice tests, drills and your study plan never count towards these."}
      </p>
    </div>
  );
}
