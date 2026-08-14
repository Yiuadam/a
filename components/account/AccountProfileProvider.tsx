"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { authedFetch, getServerSnapshot, getSnapshot, subscribe } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { PROFILE_UPDATED_EVENT, type ProfileUpdate } from "./profileEvents";
import type { ProfileFields } from "./types";

type ProfilePhase = "signed-out" | "loading" | "ready" | "unavailable";

interface AccountProfileContextValue {
  phase: ProfilePhase;
  profile: ProfileFields | null;
  refresh: () => void;
}

interface ProfileState {
  phase: ProfilePhase;
  profile: ProfileFields | null;
  /** Prevent one account from briefly rendering another account's profile. */
  sessionToken: string | null;
}

const AccountProfileContext = createContext<AccountProfileContextValue>({
  phase: "signed-out",
  profile: null,
  refresh: () => undefined,
});

const EMPTY_PROFILE: ProfileFields = {
  displayName: null,
  username: null,
  organizationUsernameReady: null,
  accountKind: null,
  birthDate: null,
  avatarUrl: null,
  email: null,
};

/** One profile request shared by the header, notification bell and required gate. */
export default function AccountProfileProvider({ children }: { children: React.ReactNode }) {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ProfileState>({
    phase: "signed-out",
    profile: null,
    sessionToken: null,
  });

  useEffect(() => {
    if (!session) return;
    let live = true;
    const sessionToken = session.accessToken;
    authedFetch(apiUrl("/api/account/profile"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("profile unavailable");
        return (await response.json()) as ProfileFields;
      })
      .then((profile) => {
        if (live) setState({ phase: "ready", profile, sessionToken });
      })
      .catch(() => {
        if (live) setState({ phase: "unavailable", profile: null, sessionToken });
      });
    return () => {
      live = false;
    };
  }, [revision, session]);

  useEffect(() => {
    const onProfileUpdated = (event: Event) => {
      const update = (event as CustomEvent<ProfileUpdate>).detail;
      if (!update || typeof update !== "object") return;
      setState((current) => ({
        phase: "ready",
        profile: { ...EMPTY_PROFILE, ...current.profile, ...update },
        sessionToken: session?.accessToken ?? current.sessionToken,
      }));
    };
    window.addEventListener(PROFILE_UPDATED_EVENT, onProfileUpdated);
    return () => window.removeEventListener(PROFILE_UPDATED_EVENT, onProfileUpdated);
  }, [session]);

  const value = useMemo<AccountProfileContextValue>(() => ({
    ...(session
      ? state.sessionToken === session.accessToken
        ? state
        : { phase: "loading" as const, profile: null }
      : { phase: "signed-out" as const, profile: null }),
    refresh: () => setRevision((current) => current + 1),
  }), [session, state]);

  return <AccountProfileContext.Provider value={value}>{children}</AccountProfileContext.Provider>;
}

export function useAccountProfile(): AccountProfileContextValue {
  return useContext(AccountProfileContext);
}
