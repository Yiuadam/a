/**
 * Commands accepted by the organization API.
 *
 * This allow-list is intentionally duplicated by the database RPC. The route
 * rejects mistakes cheaply; PostgreSQL remains the authority if this code is
 * bypassed or an older client sends a command the current server no longer
 * understands.
 */
export const ORGANIZATION_ACTIONS = [
  "submit_application",
  "withdraw_application",
  "decide_application",
  "suspend_organization",
  "restore_organization",
  "invite_member",
  "accept_invitation",
  "request_to_join",
  "decide_join_request",
  "request_to_leave",
  "decide_leave_request",
  "request_access_change",
  "decide_access_request",
  "assign_teacher",
  "assign_teacher_batch",
  "unassign_teacher",
  "assign_practice",
  "assign_practice_batch",
  "remove_practice_assignment",
  "save_teacher_feedback",
  "remove_teacher_feedback",
  "change_member_role",
  "suspend_member",
  "restore_member",
  "remove_member",
  "archive_attempt",
  "restore_attempt",
  "remove_attempt_permanently",
  "set_prior_history_sharing",
  "reserve_seat",
  "release_seat",
] as const;

export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

const KNOWN = new Set<string>(ORGANIZATION_ACTIONS);

export function isOrganizationAction(value: unknown): value is OrganizationAction {
  return typeof value === "string" && KNOWN.has(value);
}
