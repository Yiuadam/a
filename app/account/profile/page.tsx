"use client";

import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "@/lib/account";
import ProfileSection from "@/components/account/ProfileSection";
import { HubScreen } from "@/components/HubMenu";

/*
  One subject: who BandUp thinks you are.

  A client component with no `metadata`, unlike /account itself. Everything
  under here is behind a session, so there is nothing for a crawler to index
  and no shared link that would benefit from a title of its own — and a server
  wrapper whose only job is to export three lines of metadata for a page nobody
  can reach signed out is ceremony.
*/

export default function ProfileScreen() {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <HubScreen
      back="/account"
      backLabel="Your account"
      title="Your profile"
      className="account-profile-screen"
    >
      <ProfileSection sessionEmail={session?.email ?? null} />
    </HubScreen>
  );
}
