"use client";

import { clearSession } from "@/lib/account";
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
  return (
    <HubScreen back="/account" backLabel="Your account" title="Sign out, or close the account">
      <div className="space-y-4">
        <div>
          <button type="button" className="btn-secondary w-full" onClick={clearSession}>
            Sign out
          </button>
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
