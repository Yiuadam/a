"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { authedFetch, getServerSnapshot, getSnapshot, subscribe } from "@/lib/account";
import { apiUrl } from "@/lib/api";

export type HistoryClearAccess = "checking" | "allowed" | "restricted" | "unavailable";

/**
 * Resolve the server-enforced history policy before rendering a destructive
 * control. Signed-out learners remain independent. A signed-in request that
 * fails is closed: no clear action is drawn until the server can answer.
 */
export function useHistoryClearPolicy(): HistoryClearAccess {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const token = session?.accessToken ?? null;
  const [answer, setAnswer] = useState<{ token: string; access: HistoryClearAccess } | null>(null);

  useEffect(() => {
    if (!token) return;
    let alive = true;

    authedFetch(apiUrl("/api/organization/history-policy"))
      .then(async (response) => {
        if (!response.ok) return "unavailable" as const;
        const body = (await response.json()) as { canClearOwnHistory?: unknown };
        return body.canClearOwnHistory === true ? "allowed" as const : "restricted" as const;
      })
      .catch(() => "unavailable" as const)
      .then((access) => {
        if (alive) setAnswer({ token, access });
      });

    return () => {
      alive = false;
    };
  }, [token]);

  if (!token) return "allowed";
  return answer?.token === token ? answer.access : "checking";
}
