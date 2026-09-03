"use client";

import { Suspense } from "react";
import AdminSittingPage from "@/components/admin/SittingPage";
import LoadingIndicator from "@/components/LoadingIndicator";
import ConsoleShell from "@/components/admin/ConsoleShell";
import { useSearchParams } from "next/navigation";
import { adminUserHref } from "@/lib/admin/user-links";

/* The app's static shell for one saved sitting. See app/admin/user/page.tsx. */
export default function AdminSittingQueryRoute() {
  return (
    <Suspense
      fallback={
        <ConsoleShell title="Sitting detail" back={{ href: "/admin/users", label: "Users" }}>
          <p className="text-sm text-slate-500">
            <LoadingIndicator label="Loading sitting…" />
          </p>
        </ConsoleShell>
      }
    >
      <AdminSittingQueryShell />
    </Suspense>
  );
}

function AdminSittingQueryShell() {
  const params = useSearchParams();
  const userId = params.get("user");
  const sittingKey = params.get("sitting");
  if (!userId || !sittingKey) {
    return (
      <ConsoleShell
        title="Sitting detail"
        back={{ href: userId ? adminUserHref(userId) : "/admin/users", label: "Back" }}
      >
        <p className="rounded-xl border border-slate-200 bg-surface p-4 text-sm text-slate-500">
          No sitting was specified.
        </p>
      </ConsoleShell>
    );
  }
  return <AdminSittingPage userId={userId} sittingKey={sittingKey} />;
}
