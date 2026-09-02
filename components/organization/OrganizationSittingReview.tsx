"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import SavedResultView from "@/components/history/SavedResultView";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { organizationAttemptResult } from "@/lib/organizations/attempt-result";
import {
  organizationPreviewRequestHeaders,
  type OrganizationLivePreviewRole,
} from "@/lib/organizations/preview-client";
import { studentHistoryHref } from "@/lib/organizations/student-links";
import type { StudentHistory, StudentHistoryAttempt } from "@/lib/organizations/types";

export default function OrganizationSittingReview({
  studentId,
  attemptId,
  organizationId = null,
  notificationFocus = false,
  fromAssignmentDirectory = false,
  previewHistory = null,
  previewRole = null,
}: {
  studentId: string;
  attemptId: string;
  organizationId?: string | null;
  notificationFocus?: boolean;
  fromAssignmentDirectory?: boolean;
  previewHistory?: StudentHistory | null;
  previewRole?: OrganizationLivePreviewRole | null;
}) {
  const [history, setHistory] = useState<StudentHistory | null>(previewHistory);
  const [loading, setLoading] = useState(!previewHistory);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (previewHistory) return;
    setLoading(true);
    setError(null);
    try {
      const endpoint = new URLSearchParams();
      if (organizationId) endpoint.set("organization", organizationId);
      endpoint.set("attempt", attemptId);
      const response = await authedFetch(apiUrl(
        `/api/organization/students/${encodeURIComponent(studentId)}${endpoint.size ? `?${endpoint.toString()}` : ""}`,
      ), {
        cache: "no-store",
        headers: organizationPreviewRequestHeaders(previewRole),
      });
      if (!response.ok) throw new Error("This sitting is not available to you.");
      setHistory((await response.json()) as StudentHistory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This sitting is not available to you.");
    } finally {
      setLoading(false);
    }
  }, [attemptId, organizationId, previewHistory, previewRole, studentId]);

  useEffect(() => {
    if (previewHistory) return;
    const frame = requestAnimationFrame(() => void load());
    return () => cancelAnimationFrame(frame);
  }, [load, previewHistory]);

  const attempt = useMemo<StudentHistoryAttempt | null>(
    () => history?.attempts.find((item) => item.id === attemptId) ?? null,
    [attemptId, history],
  );
  const result = attempt ? organizationAttemptResult(attempt) : null;
  const previewRoleParam = previewRole ?? (previewHistory ? "manager" : null);
  const backParams = new URLSearchParams();
  if (organizationId) backParams.set("organization", organizationId);
  if (fromAssignmentDirectory) {
    backParams.set("section", "assignment-directory");
    backParams.set("student", studentId);
  }
  if (previewRoleParam) backParams.set("preview", previewRoleParam);
  const backHref = fromAssignmentDirectory
    ? `/organization?${backParams.toString()}`
    : studentHistoryHref(studentId, { organizationId, previewRole: previewRoleParam });
  const backLabel = fromAssignmentDirectory ? "Back to assignments" : "Back to student";

  if (loading) return <div className="card mx-auto max-w-xl text-sm text-slate-500"><LoadingIndicator label="Loading sitting…" /></div>;
  if (error || !history || !attempt || !result) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Sitting not available</h1>
        <p className="text-sm text-slate-600">{error ?? "The saved sitting could not be opened."}</p>
        {/*
          The same <Link> the loaded view's own back button is, over in
          SavedResultView — same href, same label, same class. It was a plain
          anchor here, which is a full document load, and the iOS bundle has
          no server to resolve a path into a page: a static export served
          from capacitor://localhost answers any route with its root
          index.html, so a teacher whose sitting failed to open was sent to
          the home screen rather than back to the student they were reading.
          Routing on the client is what the rest of the portal does and is
          correct on the website too, so there is nothing to branch on.
        */}
        <Link href={backHref} className="btn-secondary">{backLabel}</Link>
      </div>
    );
  }

  const studentName = history.student.displayName ?? history.student.email ?? "Student";
  return (
    <div className="mx-auto w-full max-w-5xl space-y-3 px-3 py-3 sm:px-5 sm:py-4">
      {notificationFocus && (
        <div role="status" className="rounded-[var(--radius-lg)] border border-indigo-300/80 bg-indigo-50/55 px-3 py-2 text-xs font-medium text-indigo-800">
          This student just completed the assigned practice. Review the original sitting below.
        </div>
      )}
      <div role="status" className="rounded-[var(--radius-lg)] border border-slate-200/75 bg-surface/55 px-3 py-2 text-xs text-slate-600 backdrop-blur-2xl">
        Viewing {studentName}&rsquo;s original saved result{previewHistory ? " · Localhost preview data" : previewRole ? " · Isolated D1 preview" : ""}.
      </div>
      <SavedResultView result={result} backHref={backHref} backLabel={backLabel} />
    </div>
  );
}
