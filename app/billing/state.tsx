"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TierState } from "@/lib/billing/useTier";
import LoadingIndicator from "@/components/LoadingIndicator";

/*
  The four ways a billing screen can have nothing to show, said once.

  It lives beside the screens that use it rather than in components/, and that
  placement is a compliance detail rather than taste. scripts/build-mobile.mjs
  removes the whole of app/billing from the iOS export, because Apple requires
  digital content used in an app to be sold through In-App Purchase and
  BandUp's answer is to sell nothing in the app at all. A file under
  components/ would have survived that removal carrying links to /pricing and
  /billing — routes that do not exist in the bundle — and tests/ios-no-purchase
  caught exactly that.

  Every screen under /billing needs them and every screen needs them to say the
  same thing, which is exactly the case for one shared thing rather than four
  copies that drift. They were a block in the middle of the old stacked page;
  the split into a menu and its screens is what made them something more than
  one screen has to render.

  The distinction that matters is between "could not ask" and "free". Telling a
  subscriber they are on the free plan because a request failed is the worst
  thing any of these screens could get wrong — they paid, and the app just told
  them they hadn't. So an unreachable account says so and offers nothing.

  ---------------------------------------------------------------------------
  A function, not a component, and that is not a style choice

  It was a component for about ten minutes, used as
  `{<BillingState … /> ?? <TheRealThing />}`. That renders an empty page every
  time, and it is worth writing down why, because it type-checks, lints and
  looks obviously correct: `??` falls through on null, and a JSX element is
  never null. `<BillingState />` is an object describing an element whose
  *render* may return null — the object itself is truthy, so the real content
  was unreachable on every screen and every state.

  Calling it as a plain function returns the node or a real `null`, so `??`
  means what it reads as. It holds no state and calls no hooks, which is what
  makes that legal.
*/

/**
 * Why this screen cannot show anything yet, or null when it can.
 *
 * Used as a guard: `const blocked = billingBlocker(state);` then
 * `{blocked ?? <TheRealThing />}`.
 */
export default function billingBlocker(state: TierState): ReactNode | null {
  if (state.phase === "loading") {
    return (
      <div className="card">
        <p className="text-[15px] text-slate-500"><LoadingIndicator label="Checking your account…" /></p>
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div className="card border-amber-300 bg-amber-50">
        <h2 className="font-semibold text-slate-900">Your account details are not loading</h2>
        <p className="mt-1.5 text-[15px] leading-7 text-slate-700">
          Everything you have done is still saved on this device, and every practice test and drill
          still works. This page will fill in once the connection comes back.
        </p>
      </div>
    );
  }

  if (!state.accountsEnabled) {
    return (
      <div className="card">
        <h2 className="font-semibold text-slate-900">Accounts are not switched on here</h2>
        <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
          This copy of BandUp has no accounts and no subscriptions, so there is nothing to bill and
          no allowance to track. Everything on the app works as it is.
        </p>
      </div>
    );
  }

  if (!state.signedIn) {
    return (
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
    );
  }

  return null;
}
