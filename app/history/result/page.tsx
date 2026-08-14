"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import SavedResultView from "@/components/history/SavedResultView";
import { useProfile } from "@/lib/hooks";

function ResultContent() {
  const search = useSearchParams();
  const profile = useProfile();
  const result = profile.results.find(
    (item) =>
      item.module === search.get("module") &&
      item.testId === search.get("test") &&
      item.date === search.get("date"),
  );

  if (!result) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Feedback not found</h1>
        <p className="text-sm leading-6 text-slate-600">This sitting may have been cleared.</p>
        <Link href="/history" className="btn-primary">Back to history</Link>
      </div>
    );
  }

  return <SavedResultView result={result} backHref="/history" />;
}

export default function HistoryResultPage() {
  return (
    <Suspense fallback={null}>
      <ResultContent />
    </Suspense>
  );
}
