import type { Metadata } from "next";
import { Suspense } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import StudentQueryShell from "./StudentQueryShell";

export const metadata: Metadata = {
  title: "Student progress — BandUp",
  robots: { index: false, follow: false },
};

/*
  The mobile static shell for a student's history. See
  lib/organizations/student-links.ts for why this route carries no dynamic
  segment, and app/organization/students/[id]/page.tsx for the website's own
  path-based equivalent, which this deliberately mirrors the props of.

  useSearchParams() forces whatever calls it out of the prerendered shell and
  into client rendering, so the query-reading component has to be a Client
  Component wrapped in Suspense — a plain export from here would fail
  `output: export` the same way the dynamic route it replaces did.
*/
export default function OrganizationStudentPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-7xl px-3 py-3 sm:px-5 sm:py-4">
          <section className="card text-sm text-slate-500">
            <LoadingIndicator label="Loading student history…" />
          </section>
        </div>
      }
    >
      <StudentQueryShell />
    </Suspense>
  );
}
