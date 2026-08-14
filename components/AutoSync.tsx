"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "@/lib/account";
import { PROGRESS_WRITE_EVENT } from "@/lib/progress/events";
import {
  cancelScheduledSync,
  flushProgressSync,
  scheduleSync,
} from "@/lib/progress/autosync";

/*
  Mounted once in the root layout; renders nothing.

  Three triggers, all of them "the learner did something that makes the
  account and this device differ":

    on load        — another device may have practised since this one last
                     looked; pull that in without being asked.
    on progress    — this device just recorded something; push it.
    on tab return  — the phone-on-the-train case: practise there, come back
                     to the laptop tab that has been open all along.

  Signed out, scheduleSync returns before doing anything, so this component
  is inert for the majority who never make an account.
*/
export default function AutoSync() {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const accessToken = session?.accessToken ?? null;

  useEffect(() => {
    // This catches client-side Google/OAuth completion as well as a full-page
    // password sign-in. A session transition must not wait for navigation,
    // another practice write or a visibility change before merging devices.
    if (accessToken) flushProgressSync();
    else cancelScheduledSync();
  }, [accessToken]);

  useEffect(() => {
    const onWrite = () => scheduleSync();
    const onVisible = () => {
      // Hidden: make one last attempt before background throttling. Visible:
      // immediately reconcile anything another device changed meanwhile.
      flushProgressSync();
    };
    const onOnline = () => flushProgressSync();
    window.addEventListener(PROGRESS_WRITE_EVENT, onWrite);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(PROGRESS_WRITE_EVENT, onWrite);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
