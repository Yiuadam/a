"use client";

import { Suspense } from "react";
import AdminUserHistoryPage from "@/components/admin/UserHistoryPage";
import LoadingIndicator from "@/components/LoadingIndicator";
import ConsoleShell from "@/components/admin/ConsoleShell";
import { useSearchParams } from "next/navigation";

/*
  The app's static shell for one account's history. See lib/admin/user-links.ts
  for why this route carries no dynamic segment, and app/admin/users/[id] for
  the website's path-based equivalent, which renders the same component.

  useSearchParams() forces whatever calls it out of the prerendered shell and
  into client rendering, so the query-reading half has to sit inside Suspense —
  a plain export from here would fail `output: export` exactly the way the
  dynamic route it replaces did.
*/
export default function AdminUserQueryRoute() {
  return (
    <Suspense
      fallback={
        <ConsoleShell title="User history" back={{ href: "/admin/users", label: "Users" }}>
          <p className="text-sm text-slate-500">
            <LoadingIndicator label="Loading account history…" />
          </p>
        </ConsoleShell>
      }
    >
      <AdminUserQueryShell />
    </Suspense>
  );
}

function AdminUserQueryShell() {
  const userId = useSearchParams().get("user");
  if (!userId) {
    return (
      <ConsoleShell title="User history" back={{ href: "/admin/users", label: "Users" }}>
        <p className="rounded-xl border border-slate-200 bg-surface p-4 text-sm text-slate-500">
          No account was specified.
        </p>
      </ConsoleShell>
    );
  }
  return <AdminUserHistoryPage userId={userId} />;
}
