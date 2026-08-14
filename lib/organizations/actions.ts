/**
 * Commands accepted by the organization API.
 *
 * The route rejects mistakes cheaply; the selected data authority rechecks
 * roles and command semantics at its own write boundary. D1 is the production
 * organisation authority, while the legacy PostgreSQL RPC keeps its existing
 * command set for installations that have not cut over.
 */
export const ORGANIZATION_ACTIONS = [
  "submit_application",
  "withdraw_application",
  "decide_application",
  "suspend_organization",
  "restore_organization",
  "delete_organization",
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
