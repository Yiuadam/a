import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import CheckoutNotice from "@/components/billing/CheckoutNotice";
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
    "The placement test, your study plan and every drill are free and unlimited. Standard unlocks every practice paper, Plus adds AI marking and the tutor, and Pro raises every allowance.",
};

const ALWAYS_FREE = [
  "The placement test, and re-sitting it whenever you like",
  "Your study plan, and everything it schedules",
  /*
    "Free", not "unlimited". How many papers you may sit in a week is what the
    tiers differ on; that every paper is included, with its answers and its
    explanations behind no paywall, is what is true of all of them. Saying
    "unlimited" here would contradict the Free card two inches above it.
  */
  "Every bundled reading and listening paper, with full answers and explanations",
  "The grammar drills and the vocabulary drills",
  "Your progress, synced between devices with a free account",
];

export default function PricingPage() {
  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h1 className="text-[26px] font-semibold text-slate-900">Plans</h1>
        {/* One line. The two cards below say the rest, and say it better. */}
        <p className="mt-1 text-[15px] leading-6 text-slate-600">
          Most of BandUp is free. Standard unlocks every practice paper; Plus and Pro add the
          part that costs money to run — the AI examiner, the tutor and word lookup.
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

      <details className="card [&[open]_.chev]:rotate-90">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold text-slate-900">
          <span aria-hidden="true" className="chev text-slate-400 transition-transform">›</span>
          Free forever, on every plan
        </summary>
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
      </details>

      <details className="card [&[open]_.chev]:rotate-90">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold text-slate-900">
          <span aria-hidden="true" className="chev text-slate-400 transition-transform">›</span>
          Things worth knowing before you pay
        </summary>
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
          <strong>Each AI allowance runs over a rolling 30 days</strong>, not a calendar month.
          There is no reset day: a request frees itself up 30 days after you make it, one at a
          time. Every kind of AI has its own allowance rather than sharing one pool, so a month
          of word lookups cannot use up the essays you have left.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          <strong>On iPhone, subscriptions will be bought through Apple.</strong> Apple requires
          in-app purchase for digital goods, so the App Store version will offer the same plans
          through its own payment system rather than the one on this page. That is not built
          yet; until it is, subscribing is a web feature.
        </p>
      </details>
    </div>
  );
}
