"use client";

import SyncSection from "@/components/account/SyncSection";
import { HubScreen } from "@/components/HubMenu";

/*
  One subject: how work moves between the phone and the laptop you study on.

  It belonged to neither half of the old account page — it is not who you are
  and it is not what you are paying for — which is why it kept ending up under
  a heading that did not describe it.
*/

export default function SyncScreen() {
  return (
    <HubScreen
      back="/account"
      backLabel="Your account"
      title="Practice on other devices"
      lead="Your work syncs to the account on its own. This is for when you want to be sure it has, before closing a tab."
    >
      <SyncSection />
    </HubScreen>
  );
}
