"use client";

import { TIERS, type Tier } from "@/lib/billing/tiers";
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
  quota are printed exactly as they arrived. The tier is *named* through
  lib/billing/tiers.ts rather than printed raw, which is a presentation change
  and not a decision: an unrecognised tier still prints itself, so a value this
  file has never heard of is shown rather than hidden behind a default.

  Why it used to print raw: this page said `admin` in lower case while /billing
  said `Adam` for the same account. Two screens, one tier, two answers — and
  the raw one is the one that looks like a bug.
*/

/** The tier's own name, and the raw value for anything not in the table. */
function planName(tier: string | null | undefined): string {
  if (!tier) return "Free";
  return Object.prototype.hasOwnProperty.call(TIERS, tier) ? TIERS[tier as Tier].name : tier;
}
export default function PlanSection({ status }: { status: AccountStatus }) {
  const routes = status.usage?.routes ?? [];
  const unlimited = status.unlimited === true;
  /*
    A summary, not the meter. /billing draws a bar per allowance; this page is
    about identity and only needs to answer "is there AI on this plan, and am I
    close to the end of it". So it counts the allowances that are included and
    the ones that are spent, which is the smallest true thing to say.
  */
  const included = routes.filter((r) => r.quota === null || r.quota > 0);
  const spent = included.filter((r) => r.quota !== null && r.used >= r.quota);

  return (
    <section className="card">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2 text-[15px] font-medium text-slate-900">
            {planName(status.tier)}
            {/*
              The owner's account says so, here and on /billing. The name is
              the owner's own — it could be anything — so without this the
              screen gives no clue that this account is not an ordinary one,
              which matters most on the page where the owner is checking
              whether their own limits are switched off.
            */}
            {status.tier === "admin" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                Admin
              </span>
            )}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">AI this month</dt>
          <dd className="mt-1 text-[15px] font-medium text-slate-900">
            {unlimited
              ? "No limit"
              : included.length === 0
                ? "Not on this plan"
                : spent.length === 0
                  ? `${included.length} allowance${included.length === 1 ? "" : "s"}, all with room`
                  : `${spent.length} of ${included.length} used up`}
          </dd>
          <dd className="mt-1 text-xs text-slate-500">
            <a
              href="/billing"
              className="font-medium text-indigo-700 underline underline-offset-2"
            >
              See what is left
            </a>
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-sm leading-6 text-slate-500">
        Practice tests, drills and your study plan don&rsquo;t count towards this and are never
        limited.
      </p>
    </section>
  );
}
