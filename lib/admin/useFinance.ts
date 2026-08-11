"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import type { AdminFinanceResponse } from "@/lib/admin/finance-types";

export function useFinance(): {
  phase: "loading" | "ready" | "denied" | "error";
  finance: AdminFinanceResponse | null;
} {
  const [phase, setPhase] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [finance, setFinance] = useState<AdminFinanceResponse | null>(null);

  useEffect(() => {
    let alive = true;
    authedFetch(apiUrl("/api/admin/finance"))
      .then(async (response) => {
        if (!alive) return;
        if (response.status === 404) return setPhase("denied");
        if (!response.ok) return setPhase("error");
        const body = (await response.json().catch(() => null)) as AdminFinanceResponse | null;
        if (!alive) return;
        if (!body) return setPhase("error");
        setFinance(body);
        setPhase("ready");
      })
      .catch(() => alive && setPhase("error"));
    return () => { alive = false; };
  }, []);

  return { phase, finance };
}
