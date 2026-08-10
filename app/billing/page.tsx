"use client";

import Link from "next/link";
import { Suspense } from "react";
import CheckoutNotice from "@/components/billing/CheckoutNotice";
import billingBlocker from "./state";
import { HubMenu, type HubItem } from "@/components/HubMenu";
import { useDrawnTier, useTier } from "@/lib/billing/useTier";
import { TIERS } from "@/lib/billing/tiers";

/*
  Bill and usage, as a menu of four short screens rather than one long one.

  ---------------------------------------------------------------------------
  What this page was

  Everything, in a column. For the owner — who is signed in as an admin, so
  they see the most of it — that meant a tier switcher of six radio buttons, a
  database wiring check, the plan card, five usage bars, a fold-out of plan
  features and two footer links: 1908 pixels on a 390-wide phone, of which the
  first 750 were controls only one person in the world can use.

  Nobody arrives here wanting all of that. They arrive with one question —
  what am I paying, how much have I used, why is the tutor refusing me — and
  the page answered it somewhere in the middle of four answers to questions
  they didn't ask.

  ---------------------------------------------------------------------------
  What it is now

  The menu answers the common questions on its own face: the row for the plan
  carries the plan's name, and the row for usage carries how much of the
  tightest allowance is gone. So the frequent visit ends here without a tap,
  and tapping is for when the number prompts a second question.

  The owner's two rows sit at the bottom and are labelled as theirs. They were
  at the top because they were added last and the file grew downwards, which is
  not a reason.
*/

export default function BillingPage() {
  const state = useTier();
  /*
    The tier to draw. For everyone but the owner that is the real one; for the
    owner it is whatever the preview switch is set to, so the page they use to
    check the paywall shows them the paywall. See lib/billing/preview.ts.
  */
  const tier = useDrawnTier(state);
  const definition = tier ? TIERS[tier] : null;

  const blocked = billingBlocker(state);

  /*
    The tightest allowance, as a fraction, so the usage row can say "83% used"
    without opening. Which route it belongs to is deliberately not named here —
    that is what the screen is for, and a menu row with two facts on it is a
    paragraph.

    Routes with no cap are skipped rather than counted as zero: the owner has no
    limits at all, and "0% used" on an account with nothing to use up would be
    a number that means nothing.
  */
  const capped = state.routes.filter((r) => r.quota !== null && r.quota > 0);
  const tightest = capped.reduce(
    (worst, r) => Math.max(worst, r.used / (r.quota as number)),
    0,
  );
  const usageValue = capped.length > 0 ? `${Math.min(100, Math.round(tightest * 100))}% used` : undefined;

  const items: HubItem[] = [
    {
      href: "/billing/plan",
      title: "Your plan",
      detail: "What it costs, and when it renews",
      value: definition?.name,
    },
    {
      href: "/billing/usage",
      title: "Your usage",
      detail: "Marking, tutoring and lookups left",
      value: usageValue,
      /* Amber past four fifths, which is where "plenty" stops being true. */
      tone: tightest >= 0.8 ? "warn" : "plain",
    },
  ];

  /* The real tier, not the drawn one — previewing "free" must not hide the
     control that gets you back out of the preview. */
  if (state.phase === "ready" && state.signedIn && state.tier === "admin") {
    items.push(
      {
        href: "/billing/owner",
        title: "See it as somebody else",
        detail: "Draw the app as a free or signed-out account",
        badge: "Owner",
      },
      {
        href: "/billing/checks",
        title: "Is everything wired up?",
        detail: "Probe the variables and the database",
        badge: "Owner",
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 sm:text-[26px]">
          Bill and usage
        </h1>
        <p className="text-[14px] leading-6 text-slate-600">
          Everything about what you pay and what you have left. Pick one.
        </p>
      </div>

      {/*
        Where somebody lands the moment after paying. Suspense because
        useSearchParams opts everything up to the nearest boundary out of
        prerendering, and there is no reason for that to be the whole page; the
        fallback is nothing, because on almost every visit there is nothing to
        say.
      */}
      <Suspense fallback={null}>
        <CheckoutNotice />
      </Suspense>

      {blocked ?? (
        <>
          <HubMenu items={items} />

          <p className="text-[13px] text-slate-500">
            <Link
              href="/pricing"
              className="font-medium text-indigo-700 underline underline-offset-2"
            >
              Compare plans
            </Link>
            {" · "}
            <Link
              href="/account"
              className="font-medium text-indigo-700 underline underline-offset-2"
            >
              Your name, email and picture
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
