"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

const ASSIGNMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function AssignedPracticeNoticeContent({ className }: { className: string }) {
  const searchParams = useSearchParams();
  const assignmentId = searchParams.get("assignment");
  const fromNotification = searchParams.get("from") === "notification";
  const noticeRef = useRef<HTMLDivElement>(null);
  const visible = fromNotification && assignmentId !== null && ASSIGNMENT_ID.test(assignmentId);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      noticeRef.current?.focus({ preventScroll: true });
      noticeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [assignmentId, visible]);

  if (!visible) return null;
  return (
    <div
      ref={noticeRef}
      role="status"
      tabIndex={-1}
      data-notification-target="assigned-practice"
      data-assignment-id={assignmentId}
      className={`scroll-mt-24 rounded-[var(--radius-lg)] border border-indigo-300/80 bg-indigo-50/60 px-3 py-2 text-left outline-none ring-2 ring-indigo-300/35 ${className}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-indigo-800">
        Teacher assignment
      </p>
      <p className="mt-0.5 text-xs leading-5 text-indigo-800">
        This is the practice your teacher assigned. Complete it here.
      </p>
    </div>
  );
}

/**
 * A query-aware arrival cue for a notification deep link. The boundary keeps
 * the otherwise static practice pages prerenderable under the App Router.
 */
export default function AssignedPracticeNotice({ className = "" }: { className?: string }) {
  return (
    <Suspense fallback={null}>
      <AssignedPracticeNoticeContent className={className} />
    </Suspense>
  );
}
