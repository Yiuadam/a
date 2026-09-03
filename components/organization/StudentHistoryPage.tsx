"use client";

import Link from "next/link";
import LoadingIndicator from "@/components/LoadingIndicator";
import { useCallback, useEffect, useRef, useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { teacherFeedbackPayload } from "@/lib/organizations/action-payloads";
import { buildReview } from "@/lib/review";
import type { OrganizationAction, StudentHistory } from "@/lib/organizations/types";
import { sittingReviewHref } from "@/lib/organizations/student-links";
import {
  organizationPreviewRequestHeaders,
  type OrganizationLivePreviewRole,
} from "@/lib/organizations/preview-client";
import {
  organizationAttemptsForSkill,
  type OrganizationBandSkill,
} from "@/lib/organizations/trends";
import { EmptyState, GlassSection, StatusPill, formatDate, titleCase } from "./OrganizationUI";
import StudentBandTrends from "./StudentBandTrends";

function ReviewDetails({ attempt }: { attempt: StudentHistory["attempts"][number] }) {
  const review = attempt.review;
  if (!review) return null;
  return (
    <details className="mt-3 rounded-xl border border-slate-200/70 px-3 py-2.5">
      <summary className="cursor-pointer text-xs font-semibold text-indigo-700">View original feedback</summary>
      <div className="mt-3 space-y-3 text-xs leading-5 text-slate-700">
        {review.kind === "writing" && review.attempts.map((item, index) => (
          <div key={`${item.task.id}-${index}`} className="space-y-2">
            <p className="font-semibold text-slate-900">{item.task.title} · Band {item.grade.overallBand}</p>
            <p className="whitespace-pre-wrap">{item.response}</p>
            <ul className="list-inside list-disc">{item.grade.improvements.map((value) => <li key={value}>{value}</li>)}</ul>
          </div>
        ))}
        {review.kind === "speaking" && (
          <>
            <div className="space-y-1.5">{review.transcript.map((turn, index) => <p key={index}><strong>{turn.role === "examiner" ? "Examiner" : "Student"}:</strong> {turn.text}</p>)}</div>
            <ul className="list-inside list-disc">{review.grade.improvements.map((value) => <li key={value}>{value}</li>)}</ul>
          </>
        )}
        {review.kind === "objective" && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><p className="font-semibold text-emerald-700">Going well</p><ul className="mt-1 list-inside list-disc">{review.advice.good.map((value) => <li key={value}>{value}</li>)}</ul></div>
              <div><p className="font-semibold text-indigo-700">Work on</p><ul className="mt-1 list-inside list-disc">{review.advice.improve.map((value) => <li key={value}>{value}</li>)}</ul></div>
            </div>
            {buildReview(review.questions, review.answers).map((item) => (
              <div key={item.id} className="rounded-lg border border-slate-200/70 bg-surface/35 p-3">
                <p className="font-semibold text-slate-900">{item.prompt}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <p><span className="font-semibold text-rose-700">Student:</span> {item.yourAnswer || "— left blank —"}</p>
                  <p><span className="font-semibold text-emerald-700">Answer:</span> {item.correctAnswer}</p>
                </div>
                {item.explanation && <p className="mt-2 text-slate-600">{item.explanation}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function TeacherFeedbackPanel({
  organizationId,
  attempt,
  canProvideFeedback,
  busy,
  act,
}: {
  organizationId: string;
  attempt: StudentHistory["attempts"][number];
  canProvideFeedback: boolean;
  busy: boolean;
  act: (action: OrganizationAction, payload: Record<string, unknown>) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  return (
    <div className="mt-3 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2.5">
      {(attempt.teacherFeedback ?? []).length > 0 && (
        <div className="space-y-2">
          {(attempt.teacherFeedback ?? []).map((item) => (
            <div key={item.id} className="border-b border-slate-200/70 pb-2 last:border-b-0 last:pb-0">
              <p className="text-xs leading-5 text-slate-700">{item.message}</p>
              <p className="mt-0.5 text-[0.6875rem] text-slate-500">{item.teacherName ?? "Teacher"} · {formatDate(item.updatedAt)}</p>
            </div>
          ))}
        </div>
      )}
      {canProvideFeedback && (
        <form
          className={(attempt.teacherFeedback ?? []).length ? "mt-2.5 flex flex-wrap items-end gap-2 border-t border-slate-200/70 pt-2.5" : "flex flex-wrap items-end gap-2"}
          onSubmit={(event) => {
            event.preventDefault();
            if (!message.trim()) return;
            void act("save_teacher_feedback", teacherFeedbackPayload(organizationId, attempt.id, message))
              .then(() => setMessage(""));
          }}
        >
          <label className="min-w-44 flex-1">
            <span className="sr-only">Teacher feedback</span>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={3000}
              className="input min-h-9 w-full rounded-lg border border-slate-300 bg-surface/65 px-2.5 text-xs text-slate-900"
              placeholder="Add teacher feedback"
            />
          </label>
          <button type="submit" className="btn-secondary min-h-9 !px-3 text-xs" disabled={busy || !message.trim()}>
            Save note
          </button>
        </form>
      )}
    </div>
  );
}

export default function StudentHistoryPage({
  studentId,
  organizationId = null,
  preview = null,
  previewRole = null,
}: {
  studentId: string;
  organizationId?: string | null;
  preview?: StudentHistory | null;
  previewRole?: OrganizationLivePreviewRole | null;
}) {
  const [history, setHistory] = useState<StudentHistory | null>(preview);
  const [loading, setLoading] = useState(!preview);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<OrganizationBandSkill | null>(null);
  const sittingsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (preview) return;
    setLoading(true);
    setError(null);
    try {
      const endpoint = new URLSearchParams();
      if (organizationId) endpoint.set("organization", organizationId);
      const response = await authedFetch(apiUrl(
        `/api/organization/students/${encodeURIComponent(studentId)}${endpoint.size ? `?${endpoint.toString()}` : ""}`,
      ), {
        cache: "no-store",
        headers: organizationPreviewRequestHeaders(previewRole),
      });
      if (!response.ok) throw new Error(response.status === 404 ? "This student is not assigned to you." : "Student history is unavailable right now.");
      setHistory((await response.json()) as StudentHistory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Student history is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [organizationId, preview, previewRole, studentId]);

  useEffect(() => {
    if (preview) return;
    const frame = requestAnimationFrame(() => void load());
    return () => cancelAnimationFrame(frame);
  }, [load, preview]);

  async function act(action: OrganizationAction, payload: Record<string, unknown>) {
    if (busy) return;
    if (preview) {
      setNotice("Preview only — no student record was changed.");
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const response = await authedFetch(apiUrl("/api/organization"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...organizationPreviewRequestHeaders(previewRole),
        },
        body: JSON.stringify({ action, payload, idempotencyKey: idempotencyKey() }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "That change could not be saved.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  function selectSkill(skill: OrganizationBandSkill) {
    setSelectedSkill(skill);
    requestAnimationFrame(() => {
      sittingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      sittingsRef.current?.focus({ preventScroll: true });
    });
  }

  const visibleAttempts = history
    ? organizationAttemptsForSkill(history.attempts, selectedSkill)
    : [];
  const previewRoleParam = previewRole ?? (preview ? "manager" : null);
  const destinationParams = new URLSearchParams();
  if (previewRoleParam) destinationParams.set("preview", previewRoleParam);
  if (organizationId) destinationParams.set("organization", organizationId);
  const previewQuery = destinationParams.size ? `?${destinationParams.toString()}` : "";

  return (
    <div className="mx-auto w-full max-w-7xl space-y-3 px-3 py-3 sm:px-5 sm:py-4">
      <Link href={`/organization${previewQuery}`} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-900">‹ Organisation</Link>
      {preview && <div role="status" className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-800">Localhost UI preview — this student record is an example only.</div>}
      {previewRole && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-900">Isolated D1 preview — changes are saved only in the preview database.</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
      {loading ? (
        <section className="card text-sm text-slate-500"><LoadingIndicator label="Loading student history…" /></section>
      ) : error && !history ? (
        <GlassSection title="History not available" lead={error}><button type="button" className="btn-secondary" onClick={() => void load()}>Try again</button></GlassSection>
      ) : history ? (
        <>
          {error && <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50/75 px-4 py-3 text-sm text-rose-800">{error}</div>}
          <section className="card !rounded-[var(--radius-xl)] !px-3.5 !py-3 sm:!px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="shrink-0 text-[1.0625rem] font-semibold tracking-tight text-slate-900 sm:text-[1.1875rem]">
                {history.student.displayName ?? history.student.email ?? "Student"}
              </h1>
              <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-slate-400" />
              <p className="min-w-0 flex-1 truncate text-[0.75rem] text-slate-600 sm:text-[0.8125rem]">
                {history.organization.name} · {history.student.completedAttempts} completed attempts
              </p>
              {history.student.archivedAt
                ? <StatusPill tone="warn">Archived</StatusPill>
                : <StatusPill tone="good">Active</StatusPill>}
            </div>
          </section>

          <StudentBandTrends
            history={history}
            selectedSkill={selectedSkill}
            onSelectSkill={selectSkill}
          />

          <div ref={sittingsRef} tabIndex={-1} className="scroll-mt-3 outline-none">
          <GlassSection
            title={selectedSkill ? `${titleCase(selectedSkill)} sittings` : "Every sitting"}
            lead={selectedSkill
              ? `${visibleAttempts.length} saved ${selectedSkill} sitting${visibleAttempts.length === 1 ? "" : "s"}.`
              : "Scores, saved feedback, essays and speaking transcripts remain attached to their original attempt."}
          >
            {selectedSkill && (
              <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-indigo-200/70 bg-indigo-50/35 px-3 py-2">
                <span className="text-xs font-medium text-slate-700">Filtered by {titleCase(selectedSkill)}</span>
                <button
                  type="button"
                  className="btn-secondary !min-h-0 !rounded-lg !px-2.5 !py-1.5 text-xs"
                  onClick={() => setSelectedSkill(null)}
                >
                  All sittings
                </button>
              </div>
            )}
            {visibleAttempts.length === 0 ? (
              <EmptyState>{selectedSkill ? `No ${selectedSkill} sittings for this student.` : "No visible attempts for this student."}</EmptyState>
            ) : (
              <div className="space-y-2.5">
                {visibleAttempts.map((attempt) => (
                  <article key={attempt.id} className="rounded-xl border border-slate-200/70 bg-surface/25 px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-900">{attempt.title}</span><span className="block text-xs text-slate-500">{titleCase(attempt.skill)} · {formatDate(attempt.submittedAt)}</span></span>
                      <span className="shrink-0 text-right"><span className="block text-xl font-semibold tabular-nums text-slate-900">{attempt.band ?? "—"}</span><span className="block text-[0.6875rem] text-slate-500">Band</span></span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                      <span>{attempt.score !== null && attempt.scoreOutOf !== null ? `${attempt.score}/${attempt.scoreOutOf} correct` : "Examiner scored"}</span>
                      {attempt.feedbackSummary && <span>{attempt.feedbackSummary}</span>}
                    </div>
                    <ReviewDetails attempt={attempt} />
                    <TeacherFeedbackPanel
                      organizationId={history.organization.id}
                      attempt={attempt}
                      canProvideFeedback={Boolean(history.canProvideFeedback)}
                      busy={busy !== null}
                      act={act}
                    />
                    <div className="mt-3">
                      <Link
                        href={sittingReviewHref(studentId, attempt.id, { organizationId, previewRole: previewRoleParam })}
                        className="btn-primary !px-3 !py-2 text-xs"
                      >
                        Open sitting
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </GlassSection>
          </div>
        </>
      ) : null}
    </div>
  );
}
