"use client";

import { useEffect } from "react";
import { PROGRESS_WRITE_EVENT } from "@/lib/progress/events";
import { scheduleSync } from "@/lib/progress/autosync";

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
  useEffect(() => {
    scheduleSync(1500);

    const onWrite = () => scheduleSync();
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleSync(1000);
    };
    window.addEventListener(PROGRESS_WRITE_EVENT, onWrite);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(PROGRESS_WRITE_EVENT, onWrite);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
