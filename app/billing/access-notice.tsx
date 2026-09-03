"use client";

import type { TierState } from "@/lib/billing/useTier";

/*
  What somebody holds, said once and in one voice.

  ---------------------------------------------------------------------------
  Why this exists

  There are two ways to hold paid access and they end in opposite ways. A card
  subscription renews on its date until it is cancelled. An Alipay or WeChat Pay
  pass is a single payment: on its date it simply stops, and the account goes back
  to Free.

  Every billing screen printed "Renews on" for both, because the date is all the
  entitlement carried. For the pass holder that is false in the way that costs
  somebody their access with nothing said in advance — they have no reason to
  expect the tutor to stop. So the sentence is written once, here, and both
  screens use it, for the same reason billingBlocker in ./state.tsx is one
  function rather than four copies.

  It lives under app/billing rather than in components/ for the same compliance
  reason that file does: scripts/build-mobile.mjs removes the whole of
  app/billing from the iOS export, because Apple requires digital content used in
  an app to be sold through In-App Purchase and BandUp's answer is to sell nothing
  in the app at all. A component under components/ would survive that removal
  carrying billing copy into a bundle that must not have any.

  ---------------------------------------------------------------------------
  Three states, and the third is not a rounding error

  `renews` is true, false, or null. Null means the server has a date but could
  not establish which kind of grant produced it — an unreachable read, or a row
  that no longer matches the entitlement. Both sentences would be a claim this
  build cannot support, so the date is stated on its own with nothing asserted
  about what happens on it. See lib/billing/access.ts.
*/

/** "17 September 2026", or null when there is no usable date. */
export function longDate(value: string | null): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Whether a pass is close enough to its end to be worth a colour.
 *
 * Seven days, and it changes nothing but the styling — no counter, no "hurry".
 * A learner planning a week of study is the person this helps; a learner being
 * pressed is the thing the pricing page's own header forbids.
 */
export function endingSoon(value: string | null, now = Date.now()): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return false;
  return at - now <= 7 * 24 * 60 * 60 * 1000;
}

/**
 * What this account holds and until when, or null when there is nothing to say.
 *
 * Nothing for a free account, nothing for the owner, and nothing for the free
 * Pro trial — a promo grant has no end date, so there is no ending to disclose.
 */
export default function AccessNotice({
  state,
  planName,
}: {
  state: TierState;
  /** What the plan is called, so the sentence names it rather than saying "your plan". */
  planName: string | null;
}) {
  const endsAt = longDate(state.expiresAt);
  if (endsAt === null) return null;

  const plan = planName ?? "Your plan";

  if (state.renews === true) {
    return (
      <section className="card">
        <h2 className="text-[0.9375rem] font-semibold text-slate-900">
          {plan}, renewing on {endsAt}
        </h2>
        <p className="mt-1.5 text-[0.875rem] leading-6 text-slate-600">
          Your card is charged again on that date, at the same price, and it goes on renewing until
          you cancel. Cancelling is one button on the plans page and takes nothing away before the
          date you have already paid for.
        </p>
      </section>
    );
  }

  if (state.renews === false) {
    const soon = endingSoon(state.expiresAt);
    return (
      <section className={soon ? "card border-amber-300 bg-amber-50" : "card"}>
        <h2 className="text-[0.9375rem] font-semibold text-slate-900">
          Your {plan} pass runs to {endsAt}
        </h2>
        <p className="mt-1.5 text-[0.875rem] leading-6 text-slate-600">
          A pass is a single Alipay or WeChat Pay payment and it does not renew, so nothing further
          will be charged and there is nothing to cancel. On that date the account goes back to Free
          — everything you have written and practised stays exactly where it is. Buying the same
          plan again before then adds to the time you have left rather than replacing it, and
          subscribing by card instead keeps it running without you having to remember.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="text-[0.9375rem] font-semibold text-slate-900">
        {plan}, with access to {endsAt}
      </h2>
      <p className="mt-1.5 text-[0.875rem] leading-6 text-slate-600">
        We could not tell just now whether that date is a renewal or the end of a pass. Reload in a
        moment and this will say which.
      </p>
    </section>
  );
}
