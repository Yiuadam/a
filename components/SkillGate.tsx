"use client";

import type { ReactNode } from "react";
import UpgradePanel from "@/components/billing/UpgradePanel";
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
    locked   — UpgradePanel, which already knows the difference between "you
               need an account" and "you need Standard".
    open     — the page, untouched.

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

  if (skill.locked) {
    return <UpgradePanel feature={FEATURE[module]} signedIn={access.tier !== "anonymous"} />;
  }

  return <>{children}</>;
}
