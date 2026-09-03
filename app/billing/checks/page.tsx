"use client";

import Link from "next/link";
import OwnerDiagnostics from "@/components/billing/OwnerDiagnostics";
import { HubScreen } from "@/components/HubMenu";
import { useTier } from "@/lib/billing/useTier";

/*
  The owner's "what is actually wrong" button, on a screen of its own.

  It stays a button rather than something that runs on arrival, and that is not
  caution about the cost of the check: it makes one real metered call, which is
  the only honest way to find out whether the metered call works, and a screen
  that spent a usage row every time it was opened would be a screen that lies
  about its own numbers.
*/

export default function ChecksScreen() {
  const state = useTier();
  const isOwner = state.phase === "ready" && state.signedIn && state.tier === "admin";

  return (
    <HubScreen
      back="/billing"
      backLabel="Bill and usage"
      title="Is everything wired up?"
      lead="Checks the variables and database functions the app depends on without adding artificial AI usage."
    >
      {isOwner ? (
        <OwnerDiagnostics />
      ) : (
        <div className="card">
          <p className="text-[0.9375rem] leading-7 text-slate-600">
            There is nothing here for this account.{" "}
            <Link href="/billing" className="font-medium text-indigo-700 underline underline-offset-2">
              Back to bill and usage
            </Link>
            .
          </p>
        </div>
      )}
    </HubScreen>
  );
}
