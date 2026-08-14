"use client";

import { useSearchParams } from "next/navigation";
import StudentHistoryPage from "@/components/organization/StudentHistoryPage";

/*
  Reads which student to show from the query string set by
  lib/organizations/student-links.ts, rather than from a route segment — see
  the comment at the top of that file for why this shell has no dynamic
  segment at all.

  `preview` is deliberately not read. The dynamic website page's two preview
  branches (the isolated `ORGANIZATION_UI_PREVIEW` deployment, and the
  localhost `managerStudentHistoryPreview` fixture) are a localhost/website
  preview concern that cannot run in a static client shell, so this shell
  wires the plain, real props only.
*/
export default function StudentQueryShell() {
  const searchParams = useSearchParams();
  const studentId = searchParams.get("student");
  const organizationId = searchParams.get("organization");

  if (!studentId) {
    return (
      <div className="mx-auto w-full max-w-7xl px-3 py-3 sm:px-5 sm:py-4">
        <div className="card text-sm text-slate-600">No student was specified.</div>
      </div>
    );
  }

  return <StudentHistoryPage studentId={studentId} organizationId={organizationId} />;
}
