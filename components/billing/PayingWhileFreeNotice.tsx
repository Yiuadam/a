"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  authedFetch,
  getServerSnapshot as getSessionServerSnapshot,
  getSnapshot as getSessionSnapshot,
  subscribe as subscribeSession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useTier } from "@/lib/billing/useTier";
import { IS_MOBILE_BUILD } from "@/lib/platform";

/*
  What a paying subscriber is told while the trial is running.

  ---------------------------------------------------------------------------
  Why this exists

  The free Pro trial hands new accounts what existing ones are paying for. That
  is a deliberate choice, but it leaves somebody who subscribed last month
  paying for what the account beside them was given. They will find out. The
  only question is whether they hear it from us or discover it, and discovering
  it is what turns a generous offer into something that reads as sharp practice.

  So they are told, plainly, on the page they would come to if they wanted to
  cancel. Nothing is cancelled on their behalf and no refund is offered — that
  was decided deliberately, not overlooked — but the fact is not hidden and the
  door is not held shut: the notice says they may cancel and take the trial.

  ---------------------------------------------------------------------------
  Why it cannot be dismissed

  The poster can be waved away because it is an offer, and an offer nobody wants
  should stop asking. This is not an offer. It is a disclosure that stays true
  for as long as somebody is being charged for something that is free, and it
  stops drawing on its own the moment either half of that stops being so — the
  trial ends, or they cancel. A dismissable disclosure is one the reader can be
  said to have seen while it sat behind a button they pressed once.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  Whether it draws comes from /api/billing/promo, which resolves the account's
  entitlement server-side and answers `payingWhileFree` only when the provider
  is Stripe or Apple — somebody actually being charged, not an admin holding Pro
  by role or a trialist holding it by grant.

  ---------------------------------------------------------------------------
  Two kinds of payer, and only one of them can cancel

  "Cancel your subscription and take the free trial instead" was written when a
  paid account meant a card subscription. Somebody who paid with Alipay or WeChat
  Pay holds a pass: there is no next payment, so there is nothing to cancel, and
  telling them to go and cancel one sends them looking for a button that is not
  there. Their version of the same disclosure is the true one — the pass runs out
  on its own date, and Pro is free until then anyway.

  Which of the two comes from `renews` on /api/account/status, through useTier.
  When it cannot be established the wording is the one that claims neither.
*/

export default function PayingWhileFreeNotice() {
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionServerSnapshot,
  );
  const [show, setShow] = useState(false);
  /* Which kind of payer this is. Presentation only — whether the notice draws at
     all is still the server's answer, above. */
  const { renews } = useTier();

  useEffect(() => {
    // A sign-out or a sign-in re-runs this. `alive` keeps an older answer from
    // landing last and drawing the previous account's notice.
    let alive = true;
    const done = () => {
      alive = false;
      setShow(false);
    };
    if (!session) return done;

    authedFetch(apiUrl("/api/billing/promo"))
      .then(async (res) =>
        res.ok ? ((await res.json()) as { payingWhileFree?: boolean }) : null,
      )
      .then((body) => {
        if (alive && body?.payingWhileFree === true) setShow(true);
      })
      .catch(() => {
        /* No answer means no notice. Silence is the safe direction here. */
      });

    return done;
  }, [session]);

  if (!show) return null;

  return (
    <section className="card">
      <h2 className="text-[1.0625rem] font-semibold text-slate-900">
        Pro is free at the moment, and you are paying for a plan
      </h2>
      <p className="mt-1.5 text-[0.9375rem] leading-7 text-slate-600">
        We are giving Pro to every account for nothing while the trial runs, so you are paying
        for something other people are being given. We would rather tell you than have you find
        out.
      </p>
      {renews === false ? (
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          You paid once for a pass, so there is nothing to cancel and nothing further will be
          charged — it simply runs to its date, which is on this page. Your payment is very welcome
          and it was not required. The free trial may be cancelled at any time in the future, and
          if it ends, an account with no paid access goes back to the free plan.
        </p>
      ) : (
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          You are welcome to cancel your subscription and take the free trial instead — everything
          you have written or practised stays where it is either way. Your subscription is very
          welcome and it is not required. The free trial may be cancelled at any time in the
          future, and if it ends, an account without a subscription goes back to the free plan.
        </p>
      )}
      {/*
        No link to a purchase page in the iOS bundle: Apple requires digital
        content used in the app to be sold through In-App Purchase, and BandUp's
        answer is that the app sells nothing. `/billing` is excluded from the
        export anyway, so this notice cannot appear there — but a component that
        can only draw itself correctly because of where it happens to be mounted
        is one mount away from being wrong. It says where to go instead.
      */}
      {IS_MOBILE_BUILD ? (
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-600">
          Subscriptions are managed on bandup.life, in a browser.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/pricing" className="btn-secondary">
            {renews === false ? "See your plan and its dates" : "Manage or cancel your subscription"}
          </Link>
        </div>
      )}
    </section>
  );
}
