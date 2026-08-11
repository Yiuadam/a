"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clearSession, signOutSession } from "@/lib/account";
import ClearDeviceSection from "@/components/account/ClearDeviceSection";
import { DeleteAccountSection } from "@/components/account/DangerSection";
import { HubScreen } from "@/components/HubMenu";

/*
  One subject: leaving — this session, this device, or BandUp altogether.

  Three depths of the same question, shallowest first, and the ordering is the
  point: somebody who wants to sign out should not have to read past two ways
  of destroying things to find it.

  Signing out is a button rather than a card, and that is not only about
  height. A card is a claim that what is inside needs explaining; signing out
  needs one clause, and giving it the same furniture as "delete your account
  permanently" says the two are comparable decisions.

  Deletion is last, because it is the only one of the three that cannot be
  undone.
*/

export default function CloseScreen() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutProblem, setSignOutProblem] = useState<string | null>(null);

  function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutProblem(null);

    if (!signOutSession()) {
      setSignOutProblem("Couldn't sign out on this device. Please try again.");
      setSigningOut(false);
      return;
    }

    /*
      Replace, rather than push: Back must not reopen the signed-in account
      action screen after the session has gone. `/account` is also BandUp's
      sign-in screen, so this lands directly on a useful next action instead
      of leaving a button that appears to have done nothing.
    */
    router.replace("/account");
  }

  return (
    <HubScreen back="/account" backLabel="Your account" title="Sign out, or close the account">
      <div className="space-y-4">
        <div>
          <button
            type="button"
            className="btn-secondary w-full"
            disabled={signingOut}
            onClick={signOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutProblem && (
            <p
              className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] leading-5 text-rose-800"
              role="alert"
            >
              {signOutProblem}
            </p>
          )}
          <p className="mt-2 text-[13px] leading-5 text-slate-500">
            Ends the session on this device. Nothing is deleted — your placement result, plan and
            saved words stay where they are.
          </p>
        </div>

        <ClearDeviceSection />
        <DeleteAccountSection onDeleted={clearSession} />
      </div>
    </HubScreen>
  );
}
