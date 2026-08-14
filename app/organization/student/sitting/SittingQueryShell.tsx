"use client";

import { useSearchParams } from "next/navigation";
import OrganizationSittingReview from "@/components/organization/OrganizationSittingReview";

/*
  Reads which sitting to show from the query string set by
  lib/organizations/student-links.ts, rather than from route segments — see
  the comment at the top of that file for why this shell has no dynamic
  segment at all.

  `preview` is deliberately not read, for the same reason as
  ../StudentQueryShell.tsx: the dynamic website page's preview branches are a
  localhost/website concern that cannot run in a static client shell.
*/
export default function SittingQueryShell() {
  const searchParams = useSearchParams();
  const studentId = searchParams.get("student");
  const attemptId = searchParams.get("attempt");
  const organizationId = searchParams.get("organization");
  const focus = searchParams.get("focus");
  const from = searchParams.get("from");

  if (!studentId || !attemptId) {
    return (
      <main className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-8">
        <div className="card mx-auto max-w-xl text-center text-sm text-slate-600">No sitting was specified.</div>
      </main>
    );
  }

  return (
    <OrganizationSittingReview
      studentId={studentId}
      attemptId={attemptId}
      organizationId={organizationId}
      notificationFocus={focus === "assignment-completed"}
      fromAssignmentDirectory={from === "assignment-directory"}
    />
  );
}
