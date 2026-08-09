"use client";

import { useSearchParams } from "next/navigation";

/*
  What to say to somebody who has just come back from Stripe.

  It is its own component for a mechanical reason: `useSearchParams` makes
  everything up to the nearest Suspense boundary render on the client instead
  of being prerendered. Keeping it to this one strip means the plans below are
  still in the initial HTML, and this line appears a moment later — which is
  the right way round, because for almost every visitor there is no line.

  Neither message claims more than it knows. Stripe redirects on success before
  the webhook has necessarily arrived, so "you are now a subscriber" would be a
  guess; what is true is that the payment went through and the account catches
  up within seconds. The cancelled message says nothing was charged, because
  that is the thing somebody who backed out of a payment page wants confirmed.

  It lives in components/ rather than beside the pricing page because the two
  answers now land in two places: paying takes you to /billing, where your plan
  and what it includes are, and backing out leaves you on /pricing, where the
  prices are. One component, two pages, one story about what just happened.
*/
export default function CheckoutNotice() {
  const state = useSearchParams().get("checkout");
  if (state !== "done" && state !== "cancelled") return null;

  const done = state === "done";

  return (
    <div
      role="status"
      className={
        done
          ? "rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800"
          : "rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600"
      }
    >
      {done
        ? "Payment received — thank you. Your account usually updates within a few seconds; if this page still shows Free in a minute, reload it."
        : "No payment was taken. Nothing has changed on your account."}
    </div>
  );
}
