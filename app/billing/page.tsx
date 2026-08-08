"use client";

import Link from "next/link";
import UsageMeter from "@/components/billing/UsageMeter";
import { useTier } from "@/lib/billing/useTier";
import { TIERS, plansForTier, formatPrice } from "@/lib/billing/tiers";

/*
  Usage and subscription, on their own page.

  These used to be a section of /account, between a learner's name and the
  button that deletes everything they have ever done. That was one screen doing
  two unrelated jobs: one is who you are, the other is what you are paying and
  what you have left. Nobody arrives wanting both, and the heading above them
  could not honestly describe both at once.

  So the account page keeps identity and this page takes the money. The menu
  lists them separately, which is the real test of whether a split was right —
  if you cannot name the second one in the nav without saying "and", it was not
  two pages.

  What this page will not do is decide anything. `useTier` reads what the server
  last said; every gate that matters is `requireFeature` on the server, in
  lib/billing/gate.ts. A learner who edits the tier in dev tools repaints their
  own screen and changes nothing about what the API will do for them.
*/

export default function BillingPage() {
  const state = useTier();
  const tier = state.tier;
  const definition = tier ? TIERS[tier] : null;
  const monthly = plansForTier("pro").find((p) => p.interval === "month");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Usage and plan</h1>
        <p className="mt-1.5 max-w-2xl text-[15px] leading-7 text-slate-600">
          What you have used today, and what you are on.
        </p>
      </header>

      {/*
        Three states, and each is said plainly rather than defaulted around.
        "Could not ask" is not the same as "free", and telling a subscriber they
        are on the free plan because a request failed is the worst of the three
        things this page could get wrong.
      */}
      {state.phase === "loading" && (
        <div className="card">
          <p className="text-[15px] text-slate-500">Checking your account…</p>
        </div>
      )}

      {state.phase === "unavailable" && (
        <div className="card border-amber-300 bg-amber-50">
          <h2 className="font-semibold text-slate-900">Your account details are not loading</h2>
          <p className="mt-1.5 text-[15px] leading-7 text-slate-700">
            Everything you have done is still saved on this device, and every practice test and
            drill still works. This page will fill in once the connection comes back.
          </p>
        </div>
      )}

      {state.phase === "ready" && !state.accountsEnabled && (
        <div className="card">
          <h2 className="font-semibold text-slate-900">Accounts are not switched on here</h2>
          <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
            This copy of BandUp has no accounts and no subscriptions, so there is nothing to bill
            and no allowance to track. Everything on the app works as it is.
          </p>
        </div>
      )}

      {state.phase === "ready" && state.accountsEnabled && !state.signedIn && (
        <div className="card">
          <h2 className="font-semibold text-slate-900">Sign in to see your usage</h2>
          <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
            Your allowance belongs to an account, so there is nothing to show until you are in one.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/account" className="btn-primary">
              Sign in
            </Link>
            <Link href="/pricing" className="btn-secondary">
              See the plans
            </Link>
          </div>
        </div>
      )}

      {state.phase === "ready" && state.signedIn && definition && (
        <>
          <section className="card space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  {definition.name}
                  {tier === "pro" && monthly && (
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      {formatPrice(monthly.amountMinor, monthly.currency)} a month
                    </span>
                  )}
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">{definition.blurb}</p>
                {state.expiresAt && (
                  <p className="mt-1 text-sm text-slate-500">
                    {/* "Renews", not "expires": the second reads like a warning. */}
                    Renews on{" "}
                    {new Date(state.expiresAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                    .
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {tier === "free" ? (
                  <Link href="/pricing" className="btn-primary">
                    See Standard
                  </Link>
                ) : (
                  <Link href="/pricing" className="btn-secondary">
                    Manage or cancel
                  </Link>
                )}
              </div>
            </div>

            <UsageMeter
              used={state.used}
              quota={state.quota}
              windowSeconds={state.windowSeconds}
              oldestAt={state.oldestAt}
              byRoute={state.byRoute}
            />
          </section>

          <section className="card">
            <h2 className="heading-rule mb-3 text-base font-semibold text-slate-900">
              What your plan includes
            </h2>
            <ul className="space-y-2">
              {definition.includes.map((line) => (
                <li key={line} className="flex gap-2.5 text-[15px] leading-7 text-slate-700">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600" />
                  {line}
                </li>
              ))}
            </ul>
            {tier === "free" && (
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Standard lifts the weekly limits, adds the full mock exam and the tutor chat.{" "}
                <Link href="/pricing" className="font-medium text-indigo-700 underline underline-offset-2">
                  Compare the plans
                </Link>
                .
              </p>
            )}
          </section>

          <p className="text-sm text-slate-500">
            Your name, email and picture are on{" "}
            <Link href="/account" className="font-medium text-indigo-700 underline underline-offset-2">
              your account page
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
