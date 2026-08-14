import type { SessionUser } from "@/lib/auth/session";
import { organizationPracticeTarget } from "@/lib/organizations/practice-assignments";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

type Db = Env["BANDUP_DB"];

export const NOTIFICATION_KINDS = [
  "practice_assigned",
  "teacher_feedback",
  "assignment_completed",
  "organization_request",
  "organization_invitation",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationPracticeKind = "listening" | "reading" | "writing" | "speaking";
export type NotificationRequestKind = "join" | "leave" | "history_access_change";

export interface NotificationInsert {
  kind: NotificationKind;
  recipientUserId: string;
  actorUserId?: string | null;
  organizationId?: string | null;
  entityId: string;
  relatedEntityId?: string | null;
  /** A stable domain-event identifier, not user-authored text. */
  eventId: string;
  createdAt: string;
}

export interface AssignmentCompletionNotificationInsert {
  studentUserId: string;
  /** Stable sync key used by practice_attempts even when an earlier row wins an upsert. */
  sourceKey: string;
  practiceKind: NotificationPracticeKind;
  practiceId: string;
  submittedAt: string;
  createdAt: string;
}

export interface OrganizationRequestNotificationInsert {
  organizationId: string;
  actorUserId: string;
  requestId: string;
  requestKind: NotificationRequestKind;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  type: NotificationKind;
  createdAt: string;
  readAt: string | null;
  actor: { displayName: string | null; username: string | null } | null;
  organization: { id: string; name: string } | null;
  assignment: {
    id: string;
    title: string;
    practiceKind: NotificationPracticeKind;
    practiceId: string;
    dueAt: string | null;
  } | null;
  requestKind: NotificationRequestKind | null;
  actionPath: string;
}

export interface NotificationPage {
  notifications: NotificationDto[];
  unreadCount: number;
  nextCursor: string | null;
}

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  entity_id: string;
  related_entity_id: string | null;
  read_at: string | null;
  created_at: string;
  actor_exists: string | null;
  actor_display_name: string | null;
  actor_username: string | null;
  organization_id: string | null;
  organization_name: string | null;
  assignment_id: string | null;
  assignment_title: string | null;
  assignment_module: NotificationPracticeKind | null;
  assignment_test_id: string | null;
  assignment_due_at: string | null;
  attempt_user_id: string | null;
  attempt_module: string | null;
  attempt_test_id: string | null;
  attempt_submitted_at: string | null;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function boundedText(value: string, maximum: number, label: string): string {
  if (value.length < 1 || value.length > maximum) throw new Error(`Invalid notification ${label}`);
  return value;
}

function notificationDedupeKey(input: NotificationInsert): string {
  const eventId = boundedText(input.eventId, 320, "event identifier");
  return boundedText(`${input.kind}:${input.recipientUserId}:${eventId}`, 600, "dedupe key");
}

/**
 * One prepared statement that callers can put in the same D1 batch as the
 * organization change. This is deliberately synchronous so notification
 * delivery and the source event commit atomically.
 */
export function notificationInsertStatement(
  db: Db,
  input: NotificationInsert,
): D1PreparedStatement {
  boundedText(input.recipientUserId, 80, "recipient");
  boundedText(input.entityId, 180, "entity");
  if (input.relatedEntityId) boundedText(input.relatedEntityId, 180, "related entity");
  if (!ISO.test(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Invalid notification timestamp");
  }
  return db.prepare(`
    INSERT INTO user_notifications (
      id, recipient_user_id, actor_user_id, organization_id, kind,
      entity_id, related_entity_id, dedupe_key, read_at, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
     WHERE (? IS NULL OR ? <> ?)
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
       )
       AND (
         ? IS NULL OR NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
         )
       )
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(
    crypto.randomUUID(),
    input.recipientUserId,
    input.actorUserId ?? null,
    input.organizationId ?? null,
    input.kind,
    input.entityId,
    input.relatedEntityId ?? null,
    notificationDedupeKey(input),
    input.createdAt,
    input.actorUserId ?? null,
    input.actorUserId ?? null,
    input.recipientUserId,
    input.recipientUserId,
    input.actorUserId ?? null,
    input.actorUserId ?? null,
  );
}

/**
 * Completion can satisfy more than one task. A single INSERT ... SELECT keeps
 * every matching teacher notification in the same atomic sync batch without
 * an N+1 read or a race between discovering and inserting assignments.
 */
export function assignmentCompletionNotificationStatement(
  db: Db,
  input: AssignmentCompletionNotificationInsert,
): D1PreparedStatement {
  boundedText(input.studentUserId, 80, "student");
  boundedText(input.sourceKey, 180, "attempt source");
  boundedText(input.practiceId, 180, "practice");
  if (!ISO.test(input.submittedAt) || !ISO.test(input.createdAt)) {
    throw new Error("Invalid notification timestamp");
  }
  return db.prepare(`
    INSERT INTO user_notifications (
      id, recipient_user_id, actor_user_id, organization_id, kind,
      entity_id, related_entity_id, dedupe_key, read_at, created_at
    )
    SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
             || lower(substr(hex(randomblob(2)), 2, 3)) || '-'
             || '8'
             || lower(substr(hex(randomblob(2)), 2, 3)) || '-'
             || lower(hex(randomblob(6))),
           pa.assigned_by_user_id, ?, pa.organization_id,
           'assignment_completed', attempt.id, pa.id,
           'assignment_completed:' || pa.assigned_by_user_id || ':' || pa.id,
           NULL, ?
      FROM organization_practice_assignments pa
      JOIN practice_attempts attempt
        ON attempt.user_id = ? AND attempt.source_key = ?
      JOIN organization_memberships membership
        ON membership.organization_id = pa.organization_id
       AND membership.user_id = pa.student_user_id
      JOIN organization_memberships assigner_membership
        ON assigner_membership.organization_id = pa.organization_id
       AND assigner_membership.user_id = pa.assigned_by_user_id
     WHERE pa.student_user_id = ?
       AND pa.assigned_by_user_id IS NOT NULL
       AND pa.assigned_by_user_id <> ?
       AND pa.module = ?
       AND (pa.module IN ('writing', 'speaking') OR pa.test_id = ?)
       AND pa.assigned_at <= ?
       AND membership.status IN ('active', 'leave_requested')
       AND assigner_membership.status IN ('active', 'leave_requested')
       AND (
         assigner_membership.role IN ('owner', 'manager')
         OR (
           assigner_membership.role = 'teacher'
           AND EXISTS (
             SELECT 1 FROM teacher_student_assignments assignment
              WHERE assignment.organization_id = pa.organization_id
                AND assignment.teacher_user_id = pa.assigned_by_user_id
                AND assignment.student_user_id = pa.student_user_id
                AND assignment.revoked_at IS NULL
           )
         )
       )
       AND membership.share_future_history = 1
       AND ? >= coalesce(membership.joined_at, membership.created_at)
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones
          WHERE user_id IN (pa.assigned_by_user_id, ?)
       )
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(
    input.studentUserId,
    input.createdAt,
    input.studentUserId,
    input.sourceKey,
    input.studentUserId,
    input.studentUserId,
    input.practiceKind,
    input.practiceId,
    input.submittedAt,
    input.submittedAt,
    input.studentUserId,
  );
}

/**
 * Fan a learner's organization request out to its decision-makers without an
 * application-side roster read. Teachers receive only history-access requests
 * for learners currently assigned to them; owners and managers receive all
 * three request kinds.
 */
export function organizationRequestNotificationStatement(
  db: Db,
  input: OrganizationRequestNotificationInsert,
): D1PreparedStatement {
  boundedText(input.organizationId, 80, "organization");
  boundedText(input.actorUserId, 80, "request actor");
  boundedText(input.requestId, 180, "request");
  if (!ISO.test(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Invalid notification timestamp");
  }
  return db.prepare(`
    INSERT INTO user_notifications (
      id, recipient_user_id, actor_user_id, organization_id, kind,
      entity_id, related_entity_id, dedupe_key, read_at, created_at
    )
    SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
             || lower(substr(hex(randomblob(2)), 2, 3)) || '-'
             || '8'
             || lower(substr(hex(randomblob(2)), 2, 3)) || '-'
             || lower(hex(randomblob(6))),
           recipient.user_id, ?, ?, 'organization_request', ?, ?,
           'organization_request:' || recipient.user_id || ':' || ?, NULL, ?
      FROM (
        SELECT membership.user_id
          FROM organization_memberships membership
         WHERE membership.organization_id = ?
           AND membership.status IN ('active', 'leave_requested')
           AND membership.role IN ('owner', 'manager')
        UNION
        SELECT teacher.teacher_user_id
          FROM teacher_student_assignments teacher
          JOIN organization_memberships membership
            ON membership.organization_id = teacher.organization_id
           AND membership.user_id = teacher.teacher_user_id
           AND membership.status IN ('active', 'leave_requested')
         WHERE teacher.organization_id = ?
           AND teacher.student_user_id = ?
           AND teacher.revoked_at IS NULL
           AND ? = 'history_access_change'
      ) AS recipient
     WHERE recipient.user_id <> ?
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones
          WHERE user_id IN (recipient.user_id, ?)
       )
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(
    input.actorUserId,
    input.organizationId,
    input.requestId,
    input.requestKind,
    input.requestId,
    input.createdAt,
    input.organizationId,
    input.organizationId,
    input.actorUserId,
    input.requestKind,
    input.actorUserId,
    input.actorUserId,
  );
}

export function normalizeNotificationLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LIMIT;
  if (!/^\d{1,3}$/.test(value)) return 0;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : 0;
}

function cursorFor(row: Pick<NotificationRow, "created_at" | "id">): string {
  return `${row.created_at}~${row.id}`;
}

function notificationRequestKind(row: NotificationRow): NotificationRequestKind | null {
  if (row.kind !== "organization_request") return null;
  return row.related_entity_id === "join"
    || row.related_entity_id === "leave"
    || row.related_entity_id === "history_access_change"
    ? row.related_entity_id
    : null;
}

function targetWithNotificationContext(target: string, assignmentId: string): string {
  const url = new URL(target, "https://bandup.life");
  url.searchParams.set("assignment", assignmentId);
  url.searchParams.set("from", "notification");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseNotificationCursor(value: string | null): {
  createdAt: string;
  id: string;
} | null | "invalid" {
  if (value === null || value === "") return null;
  const divider = value.lastIndexOf("~");
  if (divider <= 0) return "invalid";
  const createdAt = value.slice(0, divider);
  const id = value.slice(divider + 1);
  return ISO.test(createdAt) && ID.test(id) ? { createdAt, id } : "invalid";
}

function actionPath(row: NotificationRow): string {
  if (row.kind === "practice_assigned") {
    const target = row.assignment_module && row.assignment_test_id
      ? organizationPracticeTarget(row.assignment_module, row.assignment_test_id)
      : null;
    if (target) return targetWithNotificationContext(target.href, row.entity_id);
    const params = new URLSearchParams({
      section: "assignments",
      assignment: row.entity_id,
      from: "notification",
    });
    if (row.organization_id) params.set("organization", row.organization_id);
    return `/organization?${params.toString()}`;
  }
  if (row.kind === "teacher_feedback" && row.organization_id) {
    const params = new URLSearchParams({
      organization: row.organization_id,
      focus: "teacher-feedback",
      attempt: row.entity_id,
    });
    return `/organization?${params.toString()}`;
  }
  if (
    row.kind === "assignment_completed"
    && row.organization_id
    && row.attempt_user_id
  ) {
    const params = new URLSearchParams({
      organization: row.organization_id,
      focus: "assignment-completed",
    });
    return `/organization/students/${encodeURIComponent(row.attempt_user_id)}`
      + `/sittings/${encodeURIComponent(row.entity_id)}?${params.toString()}`;
  }
  if (row.kind === "organization_request" && row.organization_id) {
    const params = new URLSearchParams({
      organization: row.organization_id,
      section: "requests",
      request: row.entity_id,
      focus: "request",
    });
    const requestKind = notificationRequestKind(row);
    if (requestKind) params.set("requestKind", requestKind);
    return `/organization?${params.toString()}`;
  }
  if (row.kind === "organization_invitation") {
    return `/organization/invite?request=${encodeURIComponent(row.entity_id)}`;
  }
  if (row.organization_id) {
    return `/organization?organization=${encodeURIComponent(row.organization_id)}`;
  }
  return "/organization";
}

function dto(row: NotificationRow): NotificationDto {
  const assignment = row.assignment_id
    && row.assignment_title
    && row.assignment_module
    && row.assignment_test_id
    ? {
        id: row.assignment_id,
        title: row.assignment_title,
        practiceKind: row.assignment_module,
        practiceId: row.assignment_test_id,
        dueAt: row.assignment_due_at,
      }
    : null;
  const derivedPath = actionPath(row);
  return {
    id: row.id,
    type: row.kind,
    createdAt: row.created_at,
    readAt: row.read_at,
    actor: row.actor_exists ? {
      displayName: row.actor_display_name,
      username: row.actor_username,
    } : null,
    organization: row.organization_id && row.organization_name ? {
      id: row.organization_id,
      name: row.organization_name,
    } : null,
    assignment,
    requestKind: notificationRequestKind(row),
    actionPath: derivedPath.startsWith("/") && !derivedPath.startsWith("//")
      ? derivedPath
      : "/notifications",
  };
}

export async function listCloudflareNotifications(
  user: Pick<SessionUser, "id">,
  options: { limit: number; cursor: ReturnType<typeof parseNotificationCursor> },
  providedBindings?: BandUpCloudflareBindings,
): Promise<NotificationPage> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const cursor = options.cursor;
  if (options.limit < 1 || options.limit > MAX_LIMIT || cursor === "invalid") {
    throw new Error("Invalid notification page");
  }
  const cursorClause = cursor
    ? "AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))"
    : "";
  const cursorValues = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const [list, unread] = await bindings.db.batch([
    bindings.db.prepare(`
      SELECT n.id, n.kind, n.entity_id, n.related_entity_id, n.read_at, n.created_at,
             actor.id AS actor_exists, actor_profile.display_name AS actor_display_name,
             actor_username.username AS actor_username,
             organization.id AS organization_id, organization.name AS organization_name,
             assignment.id AS assignment_id, assignment.test_title AS assignment_title,
             assignment.module AS assignment_module, assignment.test_id AS assignment_test_id,
             assignment.due_at AS assignment_due_at,
             attempt.user_id AS attempt_user_id, attempt.module AS attempt_module,
             attempt.test_id AS attempt_test_id, attempt.submitted_at AS attempt_submitted_at
        FROM user_notifications n
        LEFT JOIN app_users actor
          ON actor.id = n.actor_user_id AND actor.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones deletion
            WHERE deletion.user_id = actor.id
         )
        LEFT JOIN learner_profiles actor_profile ON actor_profile.user_id = actor.id
        LEFT JOIN usernames actor_username ON actor_username.user_id = actor.id
        LEFT JOIN organizations organization ON organization.id = n.organization_id
        LEFT JOIN organization_practice_assignments assignment
          ON assignment.id = CASE
            WHEN n.kind = 'practice_assigned' THEN n.entity_id
            WHEN n.kind = 'assignment_completed' THEN n.related_entity_id
            ELSE NULL
          END
        LEFT JOIN practice_attempts attempt
          ON attempt.id = CASE
            WHEN n.kind IN ('teacher_feedback', 'assignment_completed') THEN n.entity_id
            ELSE NULL
          END
       WHERE n.recipient_user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones deletion
            WHERE deletion.user_id = n.recipient_user_id
         )
         ${cursorClause}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ?
    `).bind(user.id, ...cursorValues, options.limit + 1),
    bindings.db.prepare(`
      SELECT count(*) AS total
        FROM user_notifications n
       WHERE n.recipient_user_id = ? AND n.read_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_tombstones deletion
            WHERE deletion.user_id = n.recipient_user_id
         )
    `).bind(user.id),
  ]);
  if (!list.success || !unread.success) throw new Error("Notification inbox read failed");
  const rows = (list.results ?? []) as unknown as NotificationRow[];
  const hasMore = rows.length > options.limit;
  const visible = hasMore ? rows.slice(0, options.limit) : rows;
  const unreadCount = Number((unread.results?.[0] as { total?: unknown } | undefined)?.total ?? 0);
  return {
    notifications: visible.map(dto),
    unreadCount: Number.isSafeInteger(unreadCount) && unreadCount >= 0 ? unreadCount : 0,
    nextCursor: hasMore && visible.length > 0 ? cursorFor(visible[visible.length - 1]) : null,
  };
}

export async function markCloudflareNotificationsRead(
  user: Pick<SessionUser, "id">,
  notificationId: string | null,
  providedBindings?: BandUpCloudflareBindings,
): Promise<number> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const timestamp = new Date().toISOString();
  const result = notificationId
    ? await bindings.db.prepare(`
        UPDATE user_notifications SET read_at = ?
         WHERE id = ? AND recipient_user_id = ? AND read_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
           )
      `).bind(timestamp, notificationId, user.id, user.id).run()
    : await bindings.db.prepare(`
        UPDATE user_notifications SET read_at = ?
         WHERE recipient_user_id = ? AND read_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
           )
      `).bind(timestamp, user.id, user.id).run();
  if (!result.success) throw new Error("Notification read state was not saved");
  const unread = await bindings.db.prepare(`
    SELECT count(*) AS total FROM user_notifications
     WHERE recipient_user_id = ? AND read_at IS NULL
  `).bind(user.id).first<{ total: number }>();
  const count = Number(unread?.total ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
