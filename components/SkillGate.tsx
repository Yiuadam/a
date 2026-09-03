"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import LockedCard from "@/components/LockedCard";
import SignInLink from "@/components/account/SignInLink";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import ExternalPlansLink from "@/components/billing/ExternalPlansLink";
import { useExternalPlansUrl } from "@/lib/billing/storefront";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";
import type { ModuleName } from "@/lib/types";

/*
  The lock on a whole page, rather than on a card.

  The cards that link to writing and speaking were locked before this existed,
  and that turned out to be half a job: the header lists Writing and Speaking
  directly, so a visitor who used the menu instead of the dashboard walked past
  every lock in the app and into a working page. A gate belongs on the thing
  being protected, not only on the routes people are expected to take to it.

  Three states, and the middle one is the reason this is a component rather
  than an `if`:

    pending  — the account lookup is still in flight. Neither open nor locked.
               Drawing the page here is what produced the two-second window a
               visitor could click through; drawing a paywall here would flash
               one at a subscriber. So it draws neither.
    locked   — the page itself, drawn and dimmed behind a padlock, with one
               line above it saying how to get in.
    open     — the page, untouched.

  ---------------------------------------------------------------------------
  Why the locked state shows the page rather than replacing it

  It used to be a panel that said "Sign in to practise writing" on an otherwise
  empty screen, and that is a worse trade than it looks. Somebody deciding
  whether an account is worth making is being asked to decide about something
  they have not seen. A sentence describing AI marking persuades nobody; the
  task, the word count, the timer and the four criteria sitting there behind a
  lock do the persuading by themselves.

  It is the same argument as the cards on /practice, and the owner's original
  brief for the lock — see components/LockedCard.tsx. The whole point of a lock
  on a shop window is that you can see in.

  Nothing behind the lock can be touched: LockedCard puts pointer-events-none
  over the content and makes the whole thing one link. And none of it is
  enforcement — writing and speaking are marked by the model, and the model is
  behind requireFeature and the AI allowance on the server.

  Nothing here is enforcement. Writing and speaking are marked by the model,
  and the model is behind requireFeature and the AI allowance on the server. A
  learner who deletes this component from their own browser reaches a page that
  will not mark anything.
*/

const FEATURE: Record<ModuleName, string> = {
  listening: "sit a listening paper",
  reading: "sit a reading paper",
  writing: "practise writing",
  speaking: "practise speaking",
};

const LABEL: Record<ModuleName, string> = {
  listening: "Listening practice",
  reading: "Reading practice",
  writing: "Writing practice",
  speaking: "Speaking practice",
};

export default function SkillGate({
  module,
  className = "",
  children,
}: {
  module: ModuleName;
  /**
   * How wide the lock is, from the page that knows.
   *
   * Most pages fill the layout container, so the lock does too and nothing has
   * to be said. The speaking page does not: its opening card is centred at
   * `max-w-3xl`, so a full-width lock drew its tint and its ring right across
   * the empty gutters either side — two grey rectangles flanking the card,
   * belonging to nothing. The page is the only thing that knows its own width,
   * so the page is what says it.
   */
  className?: string;
  children: ReactNode;
}) {
  const access = useSessionAccess();
  const skill = access[module];
  /* Above the early returns, because a hook has to run on every render of a
     component or React loses track of which hook is which. */
  const externalUrl = useExternalPlansUrl();

  if (skill.pending) {
    return (
      <div className={`card ${className}`} aria-busy="true">
        <p className="text-[0.9375rem] text-slate-500"><LoadingIndicator label="Checking your account…" /></p>
      </div>
    );
  }

  if (skill.locked && skill.reason) {
    const signedIn = access.tier !== "anonymous";
    return (
      <div className={`space-y-3 ${className}`}>
        {/*
          One line, not a panel. The page behind the lock is what is doing the
          work; this only has to say what stands between them and it, and give
          them the button. A full panel here would push the thing it is
          advertising off the screen.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-sm leading-6 text-amber-900">
            {signedIn ? (
              <>
                <span className="font-semibold">Standard unlocks this.</span>{" "}
                {IS_MOBILE_BUILD && !externalUrl
                  ? `Subscriptions are managed on ${WEB_HOME}, not in the app.`
                  : "Everything else stays free — the placement test, your study plan and every drill."}
              </>
            ) : (
              <>
                <span className="font-semibold">Sign in to {FEATURE[module]}.</span> An account is
                free, and everything you have done so far stays where it is.
              </>
            )}
          </p>
          {/*
            The iOS build has no /pricing in it, so a signed-in learner out of
            reach of a skill gets a link to the website instead — on the
            storefronts where an app may point at one. Where it may not, the
            sentence above is the whole answer and there is no button at all:
            an invitation to buy is exactly what must not be there. See
            lib/billing/storefront.ts.
          */}
          {!signedIn ? (
            <SignInLink className="btn-primary shrink-0">
              Sign in
            </SignInLink>
          ) : !IS_MOBILE_BUILD ? (
            <Link href="/pricing" className="btn-primary shrink-0">
              See Standard
            </Link>
          ) : externalUrl ? (
            <ExternalPlansLink url={externalUrl} className="btn-primary shrink-0">
              See Standard
            </ExternalPlansLink>
          ) : null}
        </div>

        <LockedCard reason={skill.reason} label={LABEL[module]} standoff>
          {children}
        </LockedCard>
      </div>
    );
  }

  return <>{children}</>;
}
