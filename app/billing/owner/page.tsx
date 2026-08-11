"use client";

import Link from "next/link";
import OwnerSwitch from "@/components/billing/OwnerSwitch";
import { HubScreen } from "@/components/HubMenu";
import { useTier } from "@/lib/billing/useTier";

/*
  The owner's preview switch, on a screen of its own.

  Gated on the real tier rather than the drawn one, which is the whole point:
  set the switch to "signed out" and every other screen draws a signed-out
  account, so the control that gets you back has to be blind to it.

  A non-owner gets the same nothing they would get from a page that does not
  exist. That is a courtesy rather than a defence — nothing here can do
  anything, since the switch only changes what this browser draws, and every
  gate that matters is `requireFeature` on the server.
*/

export default function OwnerScreen() {
  const state = useTier();
  const isOwner = state.phase === "ready" && state.signedIn && state.tier === "admin";

  return (
    <HubScreen
      back="/billing"
      backLabel="Bill and usage"
      title="See it as somebody else"
      lead="Your account has no limits. This changes what you see, so you can check the locks and the paywall without signing out."
    >
      {isOwner ? (
        <OwnerSwitch />
      ) : (
        <div className="card">
          <p className="text-[15px] leading-7 text-slate-600">
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
