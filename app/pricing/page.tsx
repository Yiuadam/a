import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import CheckoutNotice from "./CheckoutNotice";
import PricingPlans from "./PricingPlans";

/*
  A server component wrapping client ones, for the same reason app/account and
  app/terms are: `export const metadata` is only legal here. Everything that
  reads the account or talks to Stripe is in ./PricingPlans.

  The order of the page is the argument it makes. What is free comes first,
  because it is most of the app and saying so is the honest thing to lead with;
  the plans come next; the small print about the iPhone app comes last, where
  small print belongs, and is still true rather than absent.
*/

export const metadata: Metadata = {
  title: "Plans — BandUp",
  description:
    "The placement test, your study plan, practice tests and drills are free and unlimited. Pro raises the daily allowance on AI feedback and adds the tutor chat.",
};

const ALWAYS_FREE = [
  "The placement test, and re-sitting it whenever you like",
  "Your study plan, and everything it schedules",
  "Every bundled reading and listening test, with full answers and explanations",
  "The grammar drills and the vocabulary drills",
  "Your progress, synced between devices with a free account",
];

export default function PricingPage() {
  return (
    <div className="space-y-10">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Plans</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Most of BandUp is free and always will be. What costs money to run is the AI —
          marking an essay, listening to a speaking test, generating a new passage — so that is
          what a plan buys more of.
        </p>
      </div>

      {/*
        Suspense so that the plans below stay in the prerendered HTML: reading
        the query string makes everything up to the nearest boundary render on
        the client, and there is no reason for that to be the whole page. The
        fallback is nothing, because for almost every visit there is nothing to
        say here.
      */}
      <Suspense fallback={null}>
        <CheckoutNotice />
      </Suspense>

      <PricingPlans />

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Free forever, on every plan
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-600">
          These are shipped inside the app. Serving them a thousand times costs the same as
          serving them once, which is nothing — so there is nothing to charge for.
        </p>
        <ul className="mt-4 space-y-2">
          {ALWAYS_FREE.map((line) => (
            <li key={line} className="text-[15px] leading-7 text-slate-700">
              — {line}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Things worth knowing before you pay
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>A band score here is an estimate, not a result.</strong> The AI examiner is a
          language model. It can be wrong, and it can be confidently wrong. Nothing this app
          shows you has any standing with a university, an employer or an immigration
          authority — see the{" "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-slate-900">
            terms
          </Link>
          .
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>You can cancel at any time</strong>, from the button on this page — the same
          one place you subscribed from. You keep what you have paid for until the end of the
          period you paid for, and it does not renew after that.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>The daily allowance is a rolling 24 hours</strong>, not a calendar day, so
          there is no midnight cliff and no argument about which timezone the day belongs to.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>On iPhone, subscriptions will be bought through Apple.</strong> Apple requires
          in-app purchase for digital goods, so the App Store version will offer the same plans
          through its own payment system rather than the one on this page. That is not built
          yet; until it is, subscribing is a web feature.
        </p>
      </section>
    </div>
  );
}
