/**
 * Client command payloads, kept pure so the exact browser → SQL contract is
 * executable in tests. Database commands identify people by user id; a
 * membership row id is never a substitute for that identity.
 */
export function memberActionPayload(organizationId: string, userId: string) {
  return { organizationId, userId } as const;
}

export function teacherAssignmentPayload(
  organizationId: string,
  teacherUserId: string,
  studentUserId: string,
) {
  return { organizationId, teacherUserId, studentUserId } as const;
}

export function teacherBatchAssignmentPayload(
  organizationId: string,
  teacherUserId: string,
  studentUserIds: readonly string[],
) {
  return { organizationId, teacherUserId, studentUserIds: [...studentUserIds] } as const;
}

export function attemptActionPayload(
  organizationId: string,
  attemptId: string,
  reason?: string,
) {
  return reason === undefined
    ? ({ organizationId, attemptId } as const)
    : ({ organizationId, attemptId, reason } as const);
}

export function organizationActionPayload(organizationId: string) {
  return { organizationId } as const;
}

export function organizationDeletionPayload(
  organizationId: string,
  confirmationName: string,
) {
  return { organizationId, confirmationName: confirmationName.trim() } as const;
}

export function practiceAssignmentPayload(
  organizationId: string,
  studentUserId: string,
  skill: string,
  testId: string,
  note?: string,
  dueAt?: string,
) {
  return {
    organizationId,
    studentUserId,
    skill,
    testId,
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(dueAt ? { dueAt } : {}),
  } as const;
}

export function practiceBatchAssignmentPayload(
  organizationId: string,
  studentUserIds: readonly string[],
  skill: string,
  testId: string,
  note?: string,
  dueAt?: string,
) {
  return {
    organizationId,
    studentUserIds: [...studentUserIds],
    skill,
    testId,
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(dueAt ? { dueAt } : {}),
  } as const;
}

export function practiceAssignmentRemovalPayload(organizationId: string, assignmentId: string) {
  return { organizationId, assignmentId } as const;
}

export function teacherFeedbackPayload(
  organizationId: string,
  attemptId: string,
  message: string,
) {
  return { organizationId, attemptId, message: message.trim() } as const;
}

export function teacherFeedbackRemovalPayload(organizationId: string, feedbackId: string) {
  return { organizationId, feedbackId } as const;
}
