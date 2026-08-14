import type { Metadata } from "next";
import { Suspense } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import SittingQueryShell from "./SittingQueryShell";

export const metadata: Metadata = {
  title: "Student sitting — BandUp",
  robots: { index: false, follow: false },
};

/*
  The mobile static shell for one saved sitting. See
  lib/organizations/student-links.ts for why this route carries no dynamic
  segment, and app/organization/students/[id]/sittings/[attemptId]/page.tsx
  for the website's own path-based equivalent, which this deliberately
  mirrors the props of. The fallback below matches that route's loading.tsx.

  useSearchParams() forces whatever calls it out of the prerendered shell and
  into client rendering, so the query-reading component has to be a Client
  Component wrapped in Suspense — a plain export from here would fail
  `output: export` the same way the dynamic route it replaces did.
*/
export default function OrganizationSittingPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-8">
          <div className="card flex min-h-40 items-center justify-center rounded-[var(--radius-xl)] p-6">
            <LoadingIndicator label="Loading sitting…" />
          </div>
        </main>
      }
    >
      <SittingQueryShell />
    </Suspense>
  );
}
