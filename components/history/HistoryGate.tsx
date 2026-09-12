"use client";

import type { ReactNode } from "react";
import UpgradePanel from "@/components/billing/UpgradePanel";
import { tierShows, useTier } from "@/lib/billing/useTier";

/*
  The lock in front of every history page — /history itself, /history/lookups
  and /history/result — rather than one page each remembering to check.

  Content is not what a tier buys any more (lib/entitlements/sessions.ts), so
  the one thing left to gate here is whether a sitting outlives the tab it
  was made in. `progress-sync` is the feature that answers that, and Tracking
  and AI are the only tiers it says yes to — see lib/billing/tiers.ts.

  Generous while the answer is unknown, the same as every other client-side
  gate in this app: during `loading`, and with accounts switched off, history
  is drawn. The server refuses on its own account — this component decides
  what to draw, `requireFeature` on app/api/account/progress/route.ts decides
  what actually happens — so a subscriber never watches their own paid
  history flash a paywall while the tier answer is still in flight.
*/
export default function HistoryGate({ children }: { children: ReactNode }) {
  const account = useTier();
  const entitled =
    account.phase !== "ready" || !account.accountsEnabled || tierShows(account, "progress-sync");

  if (entitled) return <>{children}</>;

  return (
    <div className="mx-auto max-w-xl">
      <UpgradePanel feature="see your history" signedIn={account.signedIn} tier="tracking" />
    </div>
  );
}
