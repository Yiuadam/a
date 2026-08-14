"use client";

import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { normaliseStudentHref } from "@/lib/organizations/student-links";
import {
  organizationPreviewRequestHeaders,
  type OrganizationLivePreviewRole,
} from "@/lib/organizations/preview-client";
import {
  NOTIFICATION_TYPES,
  NOTIFICATIONS_CHANGED_EVENT,
  type AccountNotification,
  type NotificationCopy,
  type NotificationMutationResponse,
  type NotificationPageResponse,
  type NotificationRequestOptions,
  type NotificationRequestKind,
  type NotificationType,
} from "./types";

const TYPE_SET = new Set<string>(NOTIFICATION_TYPES);
const REQUEST_KIND_SET = new Set<NotificationRequestKind>(["join", "leave", "history_access_change"]);
const PREVIEW_READ_STORAGE_PREFIX = "bandup:preview-notifications-read:v1:";
const PREVIEW_READ_STORAGE_LIMIT = 200;

interface PreviewReadRecord {
  id: string;
  createdAt: string;
  readAt: string;
}

interface PreviewReadState {
  version: 1;
  records: PreviewReadRecord[];
}

type PreviewReadStorage = Pick<Storage, "getItem" | "setItem">;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function browserStorage(): PreviewReadStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 40
    && Number.isFinite(new Date(value).getTime());
}

function previewReadRecords(
  previewRole: OrganizationLivePreviewRole,
  storage: PreviewReadStorage | null = browserStorage(),
): PreviewReadRecord[] {
  if (!storage) return [];
  try {
    const payload = object(JSON.parse(storage.getItem(previewNotificationReadStorageKey(previewRole)) ?? "null"));
    if (!payload || payload.version !== 1 || !Array.isArray(payload.records)) return [];
    const records: PreviewReadRecord[] = [];
    const seen = new Set<string>();
    for (const value of payload.records) {
      const record = object(value);
      const id = record && text(record.id);
      const createdAt = record?.createdAt;
      const readAt = record?.readAt;
      if (!id || id.length > 200 || !validTimestamp(createdAt) || !validTimestamp(readAt)) continue;
      const key = `${id}\u0000${createdAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ id, createdAt, readAt });
      if (records.length >= PREVIEW_READ_STORAGE_LIMIT) break;
    }
    return records;
  } catch {
    return [];
  }
}

function writePreviewReadRecords(
  previewRole: OrganizationLivePreviewRole,
  records: PreviewReadRecord[],
  storage: PreviewReadStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  const state: PreviewReadState = {
    version: 1,
    records: records
      .sort((left, right) => right.readAt.localeCompare(left.readAt))
      .slice(0, PREVIEW_READ_STORAGE_LIMIT),
  };
  try {
    storage.setItem(previewNotificationReadStorageKey(previewRole), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function emitNotificationsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
  }
}

/**
 * The public organization preview is intentionally read-only. Its notification
 * read state therefore belongs only to this browser and never mutates shared
 * synthetic D1 rows.
 */
export function previewNotificationReadStorageKey(
  previewRole: OrganizationLivePreviewRole,
): string {
  return `${PREVIEW_READ_STORAGE_PREFIX}${previewRole}`;
}

export function applyPreviewNotificationReadState(
  page: NotificationPageResponse,
  previewRole: OrganizationLivePreviewRole,
  options: {
    storage?: PreviewReadStorage | null;
    completeSnapshot?: boolean;
  } = {},
): NotificationPageResponse {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let records = previewReadRecords(previewRole, storage);
  const byFingerprint = new Map(
    page.notifications.map((item) => [`${item.id}\u0000${item.createdAt}`, item]),
  );

  // A complete first page lets us safely discard read markers for an older
  // preview seed. Partial and cursor pages must retain markers they cannot see.
  if (options.completeSnapshot) {
    const reconciled = records.filter((record) => byFingerprint.has(`${record.id}\u0000${record.createdAt}`));
    if (reconciled.length !== records.length) {
      records = reconciled;
      writePreviewReadRecords(previewRole, records, storage);
    }
  }

  const recordByFingerprint = new Map(
    records.map((record) => [`${record.id}\u0000${record.createdAt}`, record]),
  );
  const notifications = page.notifications.map((item) => {
    if (item.readAt) return item;
    const record = recordByFingerprint.get(`${item.id}\u0000${item.createdAt}`);
    return record ? { ...item, readAt: record.readAt } : item;
  });
  const locallyReadUnread = records.reduce((total, record) => {
    const visible = byFingerprint.get(`${record.id}\u0000${record.createdAt}`);
    if (visible?.readAt) return total;
    return total + 1;
  }, 0);

  return {
    ...page,
    notifications,
    unreadCount: Math.max(0, page.unreadCount - locallyReadUnread),
  };
}

export function rememberPreviewNotificationRead(
  item: AccountNotification,
  previewRole: OrganizationLivePreviewRole,
  readAt = new Date().toISOString(),
  storage: PreviewReadStorage | null = browserStorage(),
): string {
  if (item.readAt) return item.readAt;
  const records = previewReadRecords(previewRole, storage)
    .filter((record) => !(record.id === item.id && record.createdAt === item.createdAt));
  records.unshift({ id: item.id, createdAt: item.createdAt, readAt });
  writePreviewReadRecords(previewRole, records, storage);
  emitNotificationsChanged();
  return readAt;
}

/**
 * API data remains untrusted at the browser boundary. In particular, never
 * hand an absolute or protocol-relative action URL to browser navigation.
 */
export function safeNotificationActionPath(value: unknown): string | null {
  const path = text(value);
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  if (/[^\x20-\x7E]/.test(path)) return null;
  try {
    const parsed = new URL(path, "https://bandup.life");
    return parsed.origin === "https://bandup.life" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
  } catch {
    return null;
  }
}

export function notificationPathForPreview(
  path: string,
  previewRole: OrganizationLivePreviewRole | null | undefined,
): string {
  if (!previewRole) return path;
  const parsed = new URL(path, "https://bandup.life");
  parsed.searchParams.set("preview", previewRole);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Resolve the final browser destination at the last possible boundary. Feed
 * responses are already decoded through `safeNotificationActionPath`, but a
 * notification link should remain safe even when it is rendered from a local
 * fixture or another future caller. Keeping the query and hash intact is
 * important for same-page organisation links, where those values identify the
 * exact request or piece of feedback that needs attention.
 */
export function notificationActionDestination(
  actionPath: unknown,
  previewRole: OrganizationLivePreviewRole | null | undefined,
): string | null {
  const path = safeNotificationActionPath(actionPath);
  // lib/cloudflare/notifications.ts builds an `assignment_completed` link as
  // an `/organization/students/<id>/sittings/<attemptId>` path, correctly for
  // the website — the only route that exists there. The iOS bundle has no
  // such route (see lib/organizations/student-links.ts), so the path is
  // rewritten to the query form here, at the point it becomes a real `href`,
  // rather than teaching the server-side builder about the platform reading
  // its output.
  return path ? normaliseStudentHref(notificationPathForPreview(path, previewRole)) : null;
}

function readNotification(value: unknown): AccountNotification | null {
  const item = object(value);
  if (!item) return null;
  const id = text(item.id);
  const type = text(item.type);
  const createdAt = text(item.createdAt);
  if (!id || !type || !TYPE_SET.has(type) || !createdAt) return null;

  const actor = object(item.actor);
  const organization = object(item.organization);
  const assignment = object(item.assignment);
  const organizationId = organization ? text(organization.id) : null;
  const organizationName = organization ? text(organization.name) : null;
  const assignmentId = assignment ? text(assignment.id) : null;
  const assignmentTitle = assignment ? text(assignment.title) : null;
  const rawRequestKind = nullableText(item.requestKind);
  const requestKind = rawRequestKind && REQUEST_KIND_SET.has(rawRequestKind as NotificationRequestKind)
    ? rawRequestKind as NotificationRequestKind
    : null;

  return {
    id,
    type: type as NotificationType,
    createdAt,
    readAt: nullableText(item.readAt),
    actor: actor
      ? { displayName: nullableText(actor.displayName), username: nullableText(actor.username) }
      : null,
    organization: organizationId && organizationName
      ? { id: organizationId, name: organizationName }
      : null,
    assignment: assignment && assignmentId && assignmentTitle
      ? {
          id: assignmentId,
          title: assignmentTitle,
          practiceKind: nullableText(assignment.practiceKind),
          practiceId: nullableText(assignment.practiceId),
          dueAt: nullableText(assignment.dueAt),
        }
      : null,
    requestKind,
    actionPath: safeNotificationActionPath(item.actionPath),
  };
}

function errorMessage(payload: unknown, fallback: string): string {
  const body = object(payload);
  return body && typeof body.error === "string" && body.error.trim()
    ? body.error.trim()
    : fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchNotifications(
  limit: number,
  options: NotificationRequestOptions = {},
): Promise<NotificationPageResponse> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
  const params = new URLSearchParams({ limit: String(safeLimit) });
  if (options.cursor) params.set("cursor", options.cursor);
  const response = await authedFetch(apiUrl(`/api/account/notifications?${params.toString()}`), {
    cache: "no-store",
    signal: options.signal,
    headers: organizationPreviewRequestHeaders(options.previewRole),
  });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, "Notifications are unavailable right now."));
  const body = object(payload);
  if (!body || !Array.isArray(body.notifications) || typeof body.unreadCount !== "number") {
    throw new Error("Notifications returned an unexpected response.");
  }
  const result: NotificationPageResponse = {
    notifications: body.notifications.map(readNotification).filter((item): item is AccountNotification => item !== null),
    unreadCount: Math.max(0, Math.trunc(body.unreadCount)),
    nextCursor: typeof body.nextCursor === "string" && body.nextCursor.trim()
      ? body.nextCursor.trim()
      : null,
  };
  return options.previewRole
    ? applyPreviewNotificationReadState(result, options.previewRole, {
        completeSnapshot: !options.cursor && result.nextCursor === null,
      })
    : result;
}

async function mutateNotifications(
  body: { action: "mark_read"; notificationId: string } | { action: "mark_all_read" },
  previewRole?: OrganizationLivePreviewRole | null,
): Promise<NotificationMutationResponse> {
  const response = await authedFetch(apiUrl("/api/account/notifications"), {
    method: "POST",
    // An actionable notification uses a native link so it cannot be trapped by
    // client navigation state. Keep this tiny read receipt alive while the old
    // document unloads, otherwise the destination can open while the notice
    // returns as unread on the next visit.
    keepalive: body.action === "mark_read",
    headers: {
      "Content-Type": "application/json",
      ...organizationPreviewRequestHeaders(previewRole),
    },
    body: JSON.stringify(body),
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, previewRole
      ? "The shared preview cannot change notification status."
      : "The notification could not be updated."));
  }
  const result = object(payload);
  if (!result || result.ok !== true || typeof result.unreadCount !== "number") {
    throw new Error("The notification update returned an unexpected response.");
  }
  emitNotificationsChanged();
  return { ok: true, unreadCount: Math.max(0, Math.trunc(result.unreadCount)) };
}

export function markNotificationRead(
  notificationId: string,
  previewRole?: OrganizationLivePreviewRole | null,
): Promise<NotificationMutationResponse> {
  return mutateNotifications({ action: "mark_read", notificationId }, previewRole);
}

export function markAllNotificationsRead(
  previewRole?: OrganizationLivePreviewRole | null,
): Promise<NotificationMutationResponse> {
  return mutateNotifications({ action: "mark_all_read" }, previewRole);
}

function actorName(item: AccountNotification, fallback: string): string {
  return item.actor?.displayName || (item.actor?.username ? `@${item.actor.username}` : fallback);
}

export function notificationCopy(item: AccountNotification): NotificationCopy {
  const assignment = item.assignment?.title ? `“${item.assignment.title}”` : "a practice task";
  const organization = item.organization?.name ?? "your organisation";
  switch (item.type) {
    case "practice_assigned":
      return {
        title: "New practice assigned",
        body: `${actorName(item, "Your teacher")} assigned ${assignment}${item.organization ? ` in ${organization}` : ""}.`,
        actionLabel: "Open practice",
        attentionLabel: "To do",
      };
    case "teacher_feedback":
      return {
        title: "New teacher feedback",
        body: `${actorName(item, "Your teacher")} added feedback${item.assignment ? ` for ${assignment}` : " to your work"}.`,
        actionLabel: "Read feedback",
        attentionLabel: "Review",
      };
    case "assignment_completed":
      return {
        title: "Assignment completed",
        body: `${actorName(item, "A student")} completed ${assignment}.`,
        actionLabel: "Review sitting",
        attentionLabel: "Ready to review",
      };
    case "organization_request":
      if (item.requestKind === "join") return {
        title: "Join request",
        body: `${actorName(item, "A learner")} wants to join ${organization}.`,
        actionLabel: "Review join request",
        attentionLabel: "Decision needed",
      };
      if (item.requestKind === "leave") return {
        title: "Leave request",
        body: `${actorName(item, "A member")} has asked to leave ${organization}.`,
        actionLabel: "Review leave request",
        attentionLabel: "Decision needed",
      };
      if (item.requestKind === "history_access_change") return {
        title: "History sharing request",
        body: `${actorName(item, "A learner")} wants to change history sharing in ${organization}.`,
        actionLabel: "Review sharing request",
        attentionLabel: "Decision needed",
      };
      return {
        title: "Organisation request update",
        body: `${actorName(item, "A member")} has an update waiting in ${organization}.`,
        actionLabel: "Review request",
        attentionLabel: "Decision needed",
      };
    case "organization_invitation":
      return {
        title: "Organisation invitation",
        body: `You have been invited to join ${organization}.`,
        actionLabel: "Review invitation",
        attentionLabel: "Response needed",
      };
  }
}
