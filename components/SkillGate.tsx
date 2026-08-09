"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import LockedCard from "@/components/LockedCard";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
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
  children,
}: {
  module: ModuleName;
  children: ReactNode;
}) {
  const access = useSessionAccess();
  const skill = access[module];

  if (skill.pending) {
    return (
      <div className="card" aria-busy="true">
        <p className="text-[15px] text-slate-500">Checking your account…</p>
      </div>
    );
  }

  if (skill.locked && skill.reason) {
    const signedIn = access.tier !== "anonymous";
    return (
      <div className="space-y-3">
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
                <span className="font-semibold">Standard unlocks this.</span> Everything else stays
                free — the placement test, your study plan and every drill.
              </>
            ) : (
              <>
                <span className="font-semibold">Sign in to {FEATURE[module]}.</span> An account is
                free, and everything you have done so far stays where it is.
              </>
            )}
          </p>
          <Link href={signedIn ? "/pricing" : "/account"} className="btn-primary shrink-0">
            {signedIn ? "See Standard" : "Sign in"}
          </Link>
        </div>

        <LockedCard reason={skill.reason} label={LABEL[module]}>
          {children}
        </LockedCard>
      </div>
    );
  }

  return <>{children}</>;
}
