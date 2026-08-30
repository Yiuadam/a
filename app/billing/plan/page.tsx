"use client";

import Link from "next/link";
import AccessNotice from "../access-notice";
import billingBlocker from "../state";
import { HubScreen } from "@/components/HubMenu";
import { useDrawnTier, useTier } from "@/lib/billing/useTier";
import { TIERS, plansForTier, formatPrice } from "@/lib/billing/tiers";

/*
  One subject: what you are on, what it costs, when it ends, what is in it.

  The list of what a plan includes used to be folded shut behind a disclosure,
  because on the stacked page it was the difference between fitting on a screen
  and not. On a screen of its own there is nothing to hide it from, and a fold
  that exists only to save room somewhere else is a fold that makes people
  click to read the thing they came for.
*/

export default function PlanScreen() {
  const state = useTier();
  const tier = useDrawnTier(state);
  const definition = tier ? TIERS[tier] : null;
  const monthly = tier ? plansForTier(tier).find((p) => p.interval === "month") : undefined;

  const blocked = billingBlocker(state);

  return (
    <HubScreen back="/billing" backLabel="Bill and usage" title="Your plan">
      {blocked ??
        (definition && (
          <>
            <section className="card space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <h2 className="text-[19px] font-semibold text-slate-900">{definition.name}</h2>
                {/* The owner tier is named after its owner, so the name alone
                    does not say what it is. */}
                {tier === "admin" && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    Admin
                  </span>
                )}
                {monthly && (
                  <span className="text-[14px] text-slate-500">
                    {formatPrice(monthly.amountMinor, monthly.currency)} a month
                  </span>
                )}
              </div>

              <p className="text-[14px] leading-6 text-slate-600">{definition.blurb}</p>

              <Link
                href="/pricing"
                className={tier === "free" ? "btn-primary w-full" : "btn-secondary w-full"}
              >
                {tier === "free"
                  ? "See the plans"
                  : /* A pass has no next payment to cancel, so the button says
                       what the page it opens can actually do for them. */
                    state.renews === false
                    ? "See the plans"
                    : "Manage or cancel"}
              </Link>
            </section>

            {/*
              The date, and what happens on it, in the words both billing screens
              share — see ../access-notice.tsx. Beside the plan card rather than
              inside it, because it draws its own card and a card inside a card is
              two rounded rectangles saying one thing.

              What it replaced was a line in the card above: "Renews on 17
              September", with a comment explaining that "renews" reads better
              than "expires". It does, and for an Alipay or WeChat Pay pass it was
              also wrong.
            */}
            <AccessNotice state={state} planName={definition.name} />

            <section className="card">
              <h2 className="heading-rule mb-3 text-[15px] font-semibold text-slate-900">
                What {definition.name} includes
              </h2>
              <ul className="space-y-1.5">
                {definition.includes.map((line) => (
                  <li key={line} className="flex gap-2.5 text-[14px] leading-6 text-slate-700">
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600"
                    />
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ))}
    </HubScreen>
  );
}
