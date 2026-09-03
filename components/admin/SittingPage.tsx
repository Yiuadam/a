"use client";

import { useEffect, useState } from "react";
import ConsoleShell from "@/components/admin/ConsoleShell";
import LoadingIndicator from "@/components/LoadingIndicator";
import SavedResultView from "@/components/history/SavedResultView";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { findAdminSitting } from "@/lib/admin/sitting-key";
import { adminUserHref } from "@/lib/admin/user-links";
import type { ModuleResult } from "@/lib/types";

/*
  One saved sitting, given the account it belongs to and its key.

  A component rather than a page, for the same reason as the history screen
  beside it: the website reaches it by path and the app by query string. See
  lib/admin/user-links.ts.
*/
export default function AdminSittingPage({
  userId: id,
  sittingKey: sitting,
}: {
  userId: string;
  sittingKey: string;
}) {
  const [result, setResult] = useState<ModuleResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    authedFetch(apiUrl(`/api/admin/users/${encodeURIComponent(id)}`), { cache: "no-store" })
      .then(async (response): Promise<{ results?: ModuleResult[] } | null> =>
        response.ok ? response.json() as Promise<{ results?: ModuleResult[] }> : null)
      .then((body) => {
        if (live) {
          setResult(findAdminSitting(body?.results ?? [], sitting));
          setLoaded(true);
        }
      })
      .catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [id, sitting]);
  return <ConsoleShell title="Sitting detail" lead="The original feedback saved for this user." back={{ href: adminUserHref(id), label: "User history" }}>{!loaded ? <p className="text-sm text-slate-500"><LoadingIndicator label="Loading sitting…" /></p> : result ? <SavedResultView result={result} backHref={adminUserHref(id)} backLabel="User history" /> : <p className="rounded-xl border border-slate-200 bg-surface p-4 text-sm text-slate-500">This sitting does not exist.</p>}</ConsoleShell>;
}
