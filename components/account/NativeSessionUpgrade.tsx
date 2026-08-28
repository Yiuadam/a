"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getServerSnapshot,
  getSnapshot,
  looksLikeNativeSessionToken,
  saveSession,
  subscribe,
  upgradeLegacySession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";

/**
 * Moves an existing browser to the Cloudflare-native session scheme silently.
 * The ref makes each legacy bearer token at most one network attempt; a failed
 * migration leaves that token intact and it will be retried only after its
 * normal legacy refresh rotates it.
 */
export default function NativeSessionUpgrade() {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!session || looksLikeNativeSessionToken(session.accessToken)) return;
    if (attempted.current.has(session.accessToken)) return;
    attempted.current.add(session.accessToken);

    let live = true;
    void upgradeLegacySession(session, apiUrl("")).then((upgraded) => {
      /* A sign-out or another tab's login may have won while this request was
         in flight. Never overwrite the newer browser session. */
      if (live && upgraded && getSnapshot()?.accessToken === session.accessToken) {
        saveSession(upgraded);
      }
    });
    return () => { live = false; };
  }, [session]);

  return null;
}
