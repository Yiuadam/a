"use client";

import type { AccountStatus } from "./types";

/*
  What the learner is on, and how much of today's AI feedback they have used.

  This is now its own section rather than the top half of a card that also held
  a name and a date of birth. The two subjects were never related: one is
  identity, the other is billing, and mixing them meant the heading above the
  pair could only be something vague like "Signed in". Apart from reading
  better, the split is the shape the app is growing into — a plan has a price,
  a renewal date and an upgrade path to add later, and none of those belong
  anywhere near a profile picture.

  Everything below is rendered from what the server said, and nothing is worked
  out here. A client that computes its own tier is a client that can be edited
  into a better one (ACCOUNTS.md, threat 1) — so the tier, the count and the
  quota are printed exactly as they arrived, and an unrecognised tier prints
  itself rather than being mapped through a table this file would have to keep
  in step with the entitlements code.
*/
export default function PlanSection({ status }: { status: AccountStatus }) {
  const used = status.usage?.used ?? 0;
  const quota = status.usage?.quota ?? null;
  const unlimited = status.unlimited === true || quota === null;

  /*
    The bar is decoration over a sentence that already says the same thing, so
    it is hidden from assistive technology rather than given a role and a
    duplicate label. It is drawn only when there is a real limit to draw
    against; on an unlimited plan a full bar would read as "you have run out",
    which is the opposite of the truth.
  */
  const proportion =
    !unlimited && quota !== null && quota > 0 ? Math.min(1, used / quota) : null;

  return (
    <section className="card">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
          <dd className="mt-1 text-[15px] font-medium text-slate-900">{status.tier ?? "Free"}</dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">AI feedback today</dt>
          <dd className="mt-1 text-[15px] font-medium text-slate-900">
            {unlimited ? `${used} used — no limit` : `${used} of ${quota} used`}
          </dd>
          {proportion !== null && (
            <dd aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-indigo-500"
                style={{ width: `${Math.round(proportion * 100)}%` }}
              />
            </dd>
          )}
        </div>
      </dl>

      <p className="mt-4 text-sm leading-6 text-slate-500">
        Practice tests, drills and your study plan don&rsquo;t count towards this and are never
        limited.
      </p>
    </section>
  );
}
