import type { SessionUser } from "@/lib/auth/session";
import type { OrganizationAction } from "@/lib/organizations/actions";
import type {
  OrganizationActionResponse,
  OrganizationRole,
} from "@/lib/organizations/types";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { ensureCloudflareUser } from "./learner-data";
import { organizationPracticeTarget } from "@/lib/organizations/practice-assignments";
import { sha256 } from "./payloads";
import {
  notificationInsertStatement,
  organizationRequestNotificationStatement,
} from "./notifications";

type Db = Env["BANDUP_DB"];

interface RequestRow {
  id: string;
  organization_id: string;
  kind: "join" | "leave" | "history_access_change" | "invitation";
  status: "pending" | "approved" | "rejected" | "cancelled";
  requester_user_id: string;
  target_user_id: string | null;
  requested_role: OrganizationRole | null;
  requested_value: number | null;
  invitation_email: string | null;
  invitation_token_hash: string | null;
  expires_at: string | null;
  note: string | null;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  status: string;
  joined_at: string | null;
}

interface ApplicationRow {
  id: string;
  applicant_user_id: string;
  organization_name: string;
  status: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  status: string;
}

interface AttemptRow {
  id: string;
  user_id: string;
  submitted_at: string;
}

interface PracticeAssignmentRow {
  id: string;
  student_user_id: string;
}

interface ReceiptRow {
  action: string;
  request_hash: string | null;
  response_json: string;
}

const IDEMPOTENCY = /^[A-Za-z0-9._:-]{12,120}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The original schema requires this legacy column. Applications no longer ask
// people for a free-text purpose, so every new row receives the same neutral
// internal value instead of storing arbitrary text that BandUp does not need.
const APPLICATION_PURPOSE = "Organization workspace request.";

export type OrganizationCommandErrorCode =
  | "validation"
  | "forbidden"
  | "not_found"
  | "conflict";

export class OrganizationCommandError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: OrganizationCommandErrorCode;

  constructor(
    message: string,
    status: 400 | 403 | 404 | 409 = 400,
    code: OrganizationCommandErrorCode = "validation",
  ) {
    super(message);
    this.name = "OrganizationCommandError";
    this.status = status;
    this.code = code;
  }
}

function fail(
  message: string,
  status: 400 | 403 | 404 | 409 = 400,
  code: OrganizationCommandErrorCode = "validation",
): never {
  throw new OrganizationCommandError(message, status, code);
}

function forbidden(message = "Not permitted."): never {
  return fail(message, 403, "forbidden");
}

function notFound(message: string): never {
  return fail(message, 404, "not_found");
}

function conflict(message: string): never {
  return fail(message, 409, "conflict");
}

function stamp(): string {
  return new Date().toISOString();
}

function id(value: unknown, label = "identifier"): string {
  if (typeof value !== "string" || !ID.test(value)) fail(`Invalid ${label}.`);
  return value;
}

function text(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") fail(`${label} is required.`);
  const clean = value.trim();
  if (clean.length < minimum || clean.length > maximum) fail(`Invalid ${label.toLowerCase()}.`);
  return clean;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail("Invalid text.");
  const clean = value.trim();
  if (clean.length > maximum) fail("That text is too long.");
  return clean || null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function role(value: unknown, allowOwner = false): OrganizationRole {
  if (
    value !== "student"
    && value !== "teacher"
    && value !== "manager"
    && (!allowOwner || value !== "owner")
  ) fail("Invalid role.");
  return value as OrganizationRole;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

async function digest(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify(canonical(value))));
}

async function member(db: Db, organizationId: string, userId: string): Promise<MembershipRow | null> {
  return db.prepare(`
    SELECT id, organization_id, user_id, role, status, joined_at
      FROM organization_memberships
     WHERE organization_id = ? AND user_id = ?
  `).bind(organizationId, userId).first<MembershipRow>();
}

async function activeRole(db: Db, organizationId: string, userId: string): Promise<OrganizationRole | null> {
  const row = await db.prepare(`
    SELECT role FROM organization_memberships
     WHERE organization_id = ? AND user_id = ?
       AND status IN ('active', 'leave_requested')
  `).bind(organizationId, userId).first<{ role: OrganizationRole }>();
  return row?.role ?? null;
}

async function organizationActive(db: Db, organizationId: string): Promise<boolean> {
  return Boolean(await db.prepare(
    "SELECT 1 AS ok FROM organizations WHERE id = ? AND status = 'active'",
  ).bind(organizationId).first<{ ok: number }>());
}

async function hasLiveExternalSeatPool(db: Db, organizationId: string): Promise<boolean> {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM organization_seat_pools
     WHERE organization_id = ?
       AND (
         status IN ('pending', 'active')
         OR source_status IN ('pending', 'active', 'past_due', 'paused')
       )
       AND (
         provider <> 'manual'
         OR (source_provider IS NOT NULL AND source_provider <> 'manual')
         OR (
           source_external_subscription_id IS NOT NULL
           AND coalesce(source_provider, '') <> 'manual'
         )
       )
     LIMIT 1
  `).bind(organizationId).first<{ ok: number }>());
}

async function assigned(db: Db, organizationId: string, teacherId: string, studentId: string) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM teacher_student_assignments
     WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?
       AND revoked_at IS NULL LIMIT 1
  `).bind(organizationId, teacherId, studentId).first<{ ok: number }>());
}

async function studentEligible(db: Db, userId: string): Promise<boolean> {
  const now = stamp();
  const paid = await db.prepare(`
    SELECT 1 AS ok FROM subscriptions
     WHERE user_id = ? AND status IN ('active', 'trialing')
       AND tier IN ('standard', 'plus', 'pro', 'admin')
       AND (current_period_end IS NULL OR current_period_end > ?) LIMIT 1
  `).bind(userId, now).first<{ ok: number }>();
  if (paid) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
      FROM organization_seat_allocations allocation
      JOIN organization_seat_pools pool ON pool.id = allocation.seat_pool_id
     WHERE allocation.user_id = ?
       AND allocation.status IN ('reserved', 'active')
       AND allocation.starts_at <= ?
       AND pool.status = 'active'
       AND (allocation.ends_at IS NULL OR allocation.ends_at > ?)
       AND (pool.starts_at IS NULL OR pool.starts_at <= ?)
       AND (pool.ends_at IS NULL OR pool.ends_at > ?)
     LIMIT 1
  `).bind(userId, now, now, now, now).first<{ ok: number }>());
}

function canManage(actorRole: OrganizationRole | null, platformAdmin: boolean): boolean {
  return platformAdmin || actorRole === "manager" || actorRole === "owner";
}

function audit(
  db: Db,
  actorId: string,
  action: OrganizationAction,
  organizationId: string | null,
  targetType: string | null,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
) {
  return db.prepare(`
    INSERT INTO organization_audit_log (
      id, organization_id, actor_user_id, action, target_type, target_id,
      metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), organizationId, actorId, action, targetType, targetId,
    JSON.stringify(metadata), stamp(),
  );
}

async function commandOrganization(
  db: Db,
  action: OrganizationAction,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (typeof payload.organizationId === "string" && ID.test(payload.organizationId)) {
    return payload.organizationId;
  }
  if (action === "request_to_join" && typeof payload.code === "string") {
    const row = await db.prepare(
      "SELECT id FROM organizations WHERE join_code = ?",
    ).bind(payload.code.trim().toLowerCase()).first<{ id: string }>();
    return row?.id ?? null;
  }
  if (
    (action.startsWith("decide_") || action === "accept_invitation")
    && typeof payload.requestId === "string"
  ) {
    const row = await db.prepare(
      "SELECT organization_id FROM organization_requests WHERE id = ?",
    ).bind(payload.requestId).first<{ organization_id: string }>();
    return row?.organization_id ?? null;
  }
  return null;
}

async function acquireLock(db: Db, scope: string, owner: string): Promise<void> {
  const now = stamp();
  const expires = new Date(Date.now() + 30_000).toISOString();
  const result = await db.batch([
    db.prepare("DELETE FROM organization_command_locks WHERE scope_key = ? AND expires_at <= ?")
      .bind(scope, now),
    db.prepare(`
      INSERT OR IGNORE INTO organization_command_locks
        (scope_key, owner_key, expires_at, created_at) VALUES (?, ?, ?, ?)
    `).bind(scope, owner, expires, now),
  ]);
  if ((result[1]?.meta.changes ?? 0) !== 1) conflict("Another organisation change is still being saved. Try again.");
}

async function releaseLock(db: Db, scope: string, owner: string): Promise<void> {
  await db.prepare(
    "DELETE FROM organization_command_locks WHERE scope_key = ? AND owner_key = ?",
  ).bind(scope, owner).run();
}

async function priorReceipt(
  db: Db,
  userId: string,
  key: string,
  action: OrganizationAction,
  requestHash: string,
): Promise<{ invitation?: { requestId: string } } | null> {
  const row = await db.prepare(`
    SELECT action, request_hash, response_json
      FROM organization_command_receipts
     WHERE actor_user_id = ? AND idempotency_key = ?
  `).bind(userId, key).first<ReceiptRow>();
  if (!row) return null;
  if (row.action !== action || row.request_hash !== requestHash) {
    conflict("That request identifier was already used with different data.");
  }
  return JSON.parse(row.response_json) as { invitation?: { requestId: string } };
}

function receipt(
  db: Db,
  userId: string,
  key: string,
  action: OrganizationAction,
  requestHash: string,
  response: { ok: true; invitation?: { requestId: string } },
) {
  return db.prepare(`
    INSERT INTO organization_command_receipts (
      actor_user_id, idempotency_key, action, response_json, created_at, request_hash
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(userId, key, action, JSON.stringify(response), stamp(), requestHash);
}

function requireSuccess(results: D1Result[]): void {
  if (!results.every((result) => result.success)) fail("The organisation change was not saved.");
}

async function runBatch(
  db: Db,
  statements: D1PreparedStatement[],
  receiptStatement: D1PreparedStatement,
): Promise<void> {
  requireSuccess(await db.batch([...statements, receiptStatement]));
}

async function executeCommand(
  db: Db,
  user: SessionUser,
  platformAdmin: boolean,
  action: OrganizationAction,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ ok: true; invitation?: { requestId: string } }> {
  const now = stamp();
  const organizationId = await commandOrganization(db, action, payload);
  if (
    organizationId
    && action !== "suspend_organization"
    && action !== "restore_organization"
    && action !== "delete_organization"
    && action !== "decide_application"
    && !(await organizationActive(db, organizationId))
  ) fail("Organisation is not active.");

  if (action === "submit_application") {
    const organizationName = text(payload.organizationName, "Organisation name", 2, 120);
    const country = text(payload.country, "Country or region", 2, 80);
    const contactEmail = text(payload.contactEmail, "Contact email", 3, 320).toLowerCase();
    const applicantRole = text(payload.applicantRole, "Applicant role", 2, 80);
    if (!EMAIL.test(contactEmail)) fail("Invalid contact email.");
    const estimate = payload.estimatedStudents === null || payload.estimatedStudents === undefined
      ? null : Number(payload.estimatedStudents);
    if (estimate !== null && (!Number.isInteger(estimate) || estimate < 1 || estimate > 1_000_000)) {
      fail("Invalid estimated students.");
    }
    const applicationId = crypto.randomUUID();
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare(`
        INSERT INTO organization_applications (
          id, applicant_user_id, organization_name, purpose, country,
          contact_email, estimated_students, applicant_role, status,
          submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)
      `).bind(
        applicationId, user.id, organizationName, APPLICATION_PURPOSE, country,
        contactEmail, estimate, applicantRole, now, now, now,
      ),
      audit(db, user.id, action, null, "application", applicationId),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "withdraw_application") {
    const applicationId = id(payload.applicationId, "application");
    const application = await db.prepare(`
      SELECT id FROM organization_applications
       WHERE id = ? AND applicant_user_id = ?
         AND status IN ('draft', 'submitted', 'under_review')
    `).bind(applicationId, user.id).first<{ id: string }>();
    if (!application) fail("Application cannot be withdrawn.");
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare(`
        UPDATE organization_applications SET status = 'rejected',
          review_note = 'Withdrawn by applicant', reviewed_at = ?,
          reviewed_by = ?, updated_at = ? WHERE id = ?
      `).bind(now, user.id, now, applicationId),
      audit(db, user.id, action, null, "application", applicationId),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "decide_application") {
    if (!platformAdmin) forbidden();
    const applicationId = id(payload.applicationId, "application");
    const application = await db.prepare(`
      SELECT id, applicant_user_id, organization_name, status
        FROM organization_applications WHERE id = ?
    `).bind(applicationId).first<ApplicationRow>();
    if (!application || (application.status !== "submitted" && application.status !== "under_review")) {
      fail("Application is no longer awaiting review.");
    }
    const approve = bool(payload.approve);
    const note = optionalText(payload.note, 2000);
    const response = { ok: true } as const;
    const statements: D1PreparedStatement[] = [
      db.prepare(`
        UPDATE organization_applications
           SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?, updated_at = ?
         WHERE id = ? AND status IN ('submitted', 'under_review')
      `).bind(approve ? "approved" : "rejected", now, user.id, note, now, applicationId),
    ];
    let createdOrganization: string | null = null;
    if (approve) {
      createdOrganization = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const joinCode = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      statements.push(
        db.prepare(`
          INSERT INTO organizations (
            id, application_id, name, slug, status, created_by,
            created_at, updated_at, join_code
          ) VALUES (?, ?, ?, NULL, 'active', ?, ?, ?, ?)
        `).bind(createdOrganization, applicationId, application.organization_name, application.applicant_user_id, now, now, joinCode),
        db.prepare(`
          INSERT INTO organization_memberships (
            id, organization_id, user_id, role, status,
            share_future_history, share_pre_join_history, joined_at,
            created_at, updated_at, status_changed_at
          ) VALUES (?, ?, ?, 'owner', 'active', 1, 0, ?, ?, ?, ?)
        `).bind(membershipId, createdOrganization, application.applicant_user_id, now, now, now, now),
      );
    }
    statements.push(audit(
      db, user.id, action, createdOrganization, "application", applicationId,
      { approved: approve },
    ));
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "suspend_organization" || action === "restore_organization") {
    if (!platformAdmin) forbidden();
    const orgId = id(payload.organizationId, "organisation");
    const organization = await db.prepare(
      "SELECT status FROM organizations WHERE id = ? AND status <> 'closed'",
    ).bind(orgId).first<{ status: string }>();
    if (!organization) notFound("Organisation not found.");
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare("UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?")
        .bind(action === "suspend_organization" ? "suspended" : "active", now, orgId),
      audit(db, user.id, action, orgId, "organization", orgId),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "delete_organization") {
    const orgId = id(payload.organizationId, "organisation");
    const organization = await db.prepare(`
      SELECT id, name, status FROM organizations WHERE id = ?
    `).bind(orgId).first<OrganizationRow>();
    if (!organization) notFound("Organisation not found.");

    const actorRole = await activeRole(db, orgId, user.id);
    if (!canManage(actorRole, platformAdmin)) forbidden();
    // A suspended organisation is visible only to platform administration.
    // Do not let a manager bypass that boundary with a hand-written command.
    if (!platformAdmin && organization.status !== "active") forbidden();
    // The browser confirmation is backed by the command boundary: outer
    // whitespace is ignored, but spelling and case must match exactly.
    const confirmationName = text(
      payload.confirmationName,
      "Confirmation name",
      2,
      120,
    );
    if (confirmationName !== organization.name.trim()) {
      fail("Type the organisation name exactly to confirm deletion.");
    }
    // Provider cancellation cannot be made atomic with D1. Keep the local
    // organisation until billing has reached a non-live state, otherwise a
    // deleted workspace could leave an external subscription charging.
    if (await hasLiveExternalSeatPool(db, orgId)) {
      conflict("Cancel this organisation's external seat subscription before deleting it.");
    }

    const response = { ok: true } as const;
    await runBatch(db, [
      // Audit rows deliberately have no organisation foreign key, so this
      // immutable deletion record and the earlier audit trail survive the
      // following cascade. Learner-owned attempts and their R2 payloads are
      // not children of an organisation and therefore remain untouched.
      audit(db, user.id, action, orgId, "organization", orgId, {
        name: organization.name,
        previousStatus: organization.status,
        actorRole: actorRole ?? (platformAdmin ? "platform_admin" : null),
      }),
      db.prepare("DELETE FROM organizations WHERE id = ?").bind(orgId),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "request_to_join") {
    if (!bool(payload.shareFutureHistoryConsent)) fail("Future-history consent is required.");
    const requestedOrganizationId = typeof payload.organizationId === "string"
      ? id(payload.organizationId, "organisation")
      : null;
    const organization = requestedOrganizationId
      ? await db.prepare(`
          SELECT id FROM organizations WHERE id = ? AND status = 'active'
        `).bind(requestedOrganizationId).first<{ id: string }>()
      : await db.prepare(`
          SELECT id FROM organizations WHERE join_code = ? AND status = 'active'
        `).bind(text(payload.code, "Organisation code", 8, 80).toLowerCase()).first<{ id: string }>();
    if (!organization) notFound(requestedOrganizationId ? "Organisation not found." : "Organisation code not found.");
    if (!(await studentEligible(db, user.id))) fail("A Standard, Plus or Pro plan, or an organisation seat, is required.");
    const current = await member(db, organization.id, user.id);
    if (current?.status === "pending") {
      conflict("Your join request is already awaiting review.");
    }
    if (current && current.status !== "removed") conflict("You already belong to this organisation.");
    const requestId = crypto.randomUUID();
    const response = { ok: true } as const;
    await runBatch(db, [
      current
        ? db.prepare(`UPDATE organization_memberships SET status = 'pending', role = 'student',
            share_future_history = 1, updated_at = ?, status_changed_at = ? WHERE id = ?`)
          .bind(now, now, current.id)
        : db.prepare(`
            INSERT INTO organization_memberships (
              id, organization_id, user_id, role, status,
              share_future_history, share_pre_join_history,
              created_at, updated_at, status_changed_at
            ) VALUES (?, ?, ?, 'student', 'pending', 1, 0, ?, ?, ?)
          `).bind(crypto.randomUUID(), organization.id, user.id, now, now, now),
      db.prepare(`
        INSERT INTO organization_requests (
          id, organization_id, kind, status, requester_user_id,
          target_user_id, created_at, updated_at
        ) VALUES (?, ?, 'join', 'pending', ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).bind(requestId, organization.id, user.id, user.id, now, now),
      organizationRequestNotificationStatement(db, {
        organizationId: organization.id,
        actorUserId: user.id,
        requestId,
        requestKind: "join",
        createdAt: now,
      }),
      audit(db, user.id, action, organization.id, "membership", current?.id ?? null),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (
    action === "decide_join_request"
    || action === "decide_leave_request"
    || action === "decide_access_request"
  ) {
    const requestId = id(payload.requestId, "request");
    const request = await db.prepare(`
      SELECT id, organization_id, kind, status, requester_user_id,
             target_user_id, requested_role, requested_value,
             invitation_email, invitation_token_hash, expires_at, note
        FROM organization_requests WHERE id = ?
    `).bind(requestId).first<RequestRow>();
    const expected = action === "decide_join_request"
      ? "join" : action === "decide_leave_request" ? "leave" : "history_access_change";
    if (!request || request.status !== "pending") conflict("Request is no longer awaiting review.");
    if (request.kind !== expected) fail("Request type does not match the decision.");
    const actorRole = await activeRole(db, request.organization_id, user.id);
    const allowed = canManage(actorRole, platformAdmin)
      || (expected === "history_access_change" && actorRole === "teacher"
        && await assigned(db, request.organization_id, user.id, request.requester_user_id));
    if (!allowed) forbidden();
    const approve = bool(payload.approve);
    if (expected === "join" && approve && !(await studentEligible(db, request.requester_user_id))) {
      fail("The student no longer has an eligible plan or seat.");
    }
    const response = { ok: true } as const;
    const statements = [
      db.prepare(`
        UPDATE organization_requests SET status = ?, decided_by = ?,
          decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'
      `).bind(approve ? "approved" : "rejected", user.id, now, now, requestId),
    ];
    if (expected === "join") {
      statements.push(db.prepare(`
        UPDATE organization_memberships SET status = ?,
          joined_at = CASE WHEN ? = 1 THEN coalesce(joined_at, ?) ELSE joined_at END,
          updated_at = ?, status_changed_at = ?
         WHERE organization_id = ? AND user_id = ?
      `).bind(approve ? "active" : "removed", approve ? 1 : 0, now, now, now, request.organization_id, request.requester_user_id));
    } else if (expected === "leave") {
      statements.push(db.prepare(`
        UPDATE organization_memberships SET status = ?,
          removed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
          updated_at = ?, status_changed_at = ?
         WHERE organization_id = ? AND user_id = ?
      `).bind(
        approve ? "removed" : "active",
        approve ? 1 : 0,
        now,
        now,
        now,
        request.organization_id,
        request.requester_user_id,
      ));
      if (approve) statements.push(db.prepare(`
        UPDATE teacher_student_assignments SET revoked_at = ?, revoked_by = ?
         WHERE organization_id = ? AND student_user_id = ? AND revoked_at IS NULL
      `).bind(now, user.id, request.organization_id, request.requester_user_id));
    } else if (approve && request.note === "scope:future") {
      statements.push(db.prepare(`
        UPDATE organization_memberships SET share_future_history = ?, updated_at = ?
         WHERE organization_id = ? AND user_id = ?
      `).bind(request.requested_value ?? 0, now, request.organization_id, request.requester_user_id));
    } else if (approve) {
      statements.push(db.prepare(`
        UPDATE organization_memberships SET share_pre_join_history = ?, updated_at = ?
         WHERE organization_id = ? AND user_id = ?
      `).bind(request.requested_value ?? 0, now, request.organization_id, request.requester_user_id));
    }
    statements.push(audit(db, user.id, action, request.organization_id, "request", requestId, { approved: approve }));
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "request_to_leave") {
    const orgId = id(payload.organizationId, "organisation");
    const membership = await member(db, orgId, user.id);
    if (!membership || membership.role !== "student" || membership.status !== "active") fail("No active student membership.");
    const requestId = crypto.randomUUID();
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare(`
        INSERT INTO organization_requests (
          id, organization_id, kind, status, requester_user_id,
          target_user_id, note, created_at, updated_at
        ) VALUES (?, ?, 'leave', 'pending', ?, ?, ?, ?, ?)
      `).bind(requestId, orgId, user.id, user.id, optionalText(payload.note, 2000), now, now),
      db.prepare(`UPDATE organization_memberships SET status = 'leave_requested',
        updated_at = ?, status_changed_at = ? WHERE id = ?`).bind(now, now, membership.id),
      organizationRequestNotificationStatement(db, {
        organizationId: orgId,
        actorUserId: user.id,
        requestId,
        requestKind: "leave",
        createdAt: now,
      }),
      audit(db, user.id, action, orgId, "membership", membership.id),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "request_access_change" || action === "set_prior_history_sharing") {
    const orgId = id(payload.organizationId, "organisation");
    const membership = await member(db, orgId, user.id);
    if (!membership || membership.role !== "student") fail("No student membership.");
    const requested = bool(payload.share);
    const historyScope = payload.scope === "future" ? "future" : "prior";

    // While the learner belongs to the organization, sharing changes require
    // approval and must not silently remove a teacher's existing access. Once
    // an approved leave has changed the membership to `removed`, the learner
    // regains direct control of the pre-join-history consent.
    if (action === "set_prior_history_sharing" && membership.status === "removed" && historyScope === "prior") {
      const response = { ok: true } as const;
      await runBatch(db, [
        db.prepare(`UPDATE organization_memberships
          SET share_pre_join_history = ?, updated_at = ? WHERE id = ?`)
          .bind(requested ? 1 : 0, now, membership.id),
        audit(db, user.id, action, orgId, "membership", membership.id, {
          requestedValue: requested,
          directAfterLeaving: true,
        }),
      ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
      return response;
    }
    if (membership.status !== "active" && membership.status !== "leave_requested") {
      fail("No active student membership.");
    }
    const requestId = crypto.randomUUID();
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare(`
        INSERT INTO organization_requests (
          id, organization_id, kind, status, requester_user_id,
          target_user_id, requested_value, note, created_at, updated_at
        ) VALUES (?, ?, 'history_access_change', 'pending', ?, ?, ?, ?, ?, ?)
      `).bind(
        requestId, orgId, user.id, user.id, requested ? 1 : 0,
        historyScope === "future" ? "scope:future" : optionalText(payload.note, 2000),
        now, now,
      ),
      organizationRequestNotificationStatement(db, {
        organizationId: orgId,
        actorUserId: user.id,
        requestId,
        requestKind: "history_access_change",
        createdAt: now,
      }),
      audit(db, user.id, action, orgId, "membership", membership.id, {
        requestedValue: requested,
        historyScope,
      }),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "invite_member") {
    const orgId = id(payload.organizationId, "organisation");
    const actorRole = await activeRole(db, orgId, user.id);
    const teacherInvite = actorRole === "teacher" && typeof payload.userId === "string";
    if (!canManage(actorRole, platformAdmin) && !teacherInvite) forbidden();
    const requestedRole = role(payload.role);
    if (teacherInvite && requestedRole !== "student") forbidden("Teachers can invite students only.");
    if (requestedRole === "manager" && !platformAdmin && actorRole !== "owner") fail("Only an owner can invite a manager.");
    const token = text(payload.token, "Invitation token", 24, 512);
    const targetUserId = typeof payload.userId === "string" ? id(payload.userId, "account") : null;
    const email = targetUserId ? null : text(payload.email, "Invitation email", 3, 320).toLowerCase();
    if (email !== null && !EMAIL.test(email)) fail("Invalid invitation email.");
    const invited = targetUserId
      ? await db.prepare(
          "SELECT id FROM app_users WHERE id = ? AND deleted_at IS NULL",
        ).bind(targetUserId).first<{ id: string }>()
      : await db.prepare(
          "SELECT id FROM app_users WHERE lower(email) = ? AND deleted_at IS NULL",
        ).bind(email).first<{ id: string }>();
    if (targetUserId && !invited) notFound("Account not found.");
    if (requestedRole === "student" && invited && !(await studentEligible(db, invited.id))) {
      fail("The student needs an eligible plan or seat.");
    }
    const existing = invited ? await member(db, orgId, invited.id) : null;
    if (existing && existing.status !== "removed") {
      conflict("That person already has a membership in this organisation.");
    }
    const pendingInvitation = await db.prepare(`
      SELECT id FROM organization_requests
       WHERE organization_id = ? AND kind = 'invitation' AND status = 'pending'
         AND (
           (? IS NOT NULL AND target_user_id = ?)
           OR (? IS NOT NULL AND invitation_email IS NOT NULL AND lower(invitation_email) = ?)
         )
       LIMIT 1
    `).bind(
      orgId,
      invited?.id ?? null,
      invited?.id ?? null,
      email,
      email,
    ).first<{ id: string }>();
    if (pendingInvitation) {
      conflict("An invitation for that account is already awaiting a response.");
    }
    const requestId = crypto.randomUUID();
    const tokenHash = await digest(token);
    const response = { ok: true, invitation: { requestId } } as const;
    // An invitation is only a request. It must never mutate a live, pending,
    // suspended or former membership before the recipient explicitly accepts
    // the consent prompt. A removed member can be invited again, but their
    // row stays removed until accept_invitation atomically restores it.
    const statements: D1PreparedStatement[] = [
      db.prepare(`
        INSERT INTO organization_requests (
          id, organization_id, kind, status, requester_user_id,
          target_user_id, invitation_email, invitation_token_hash,
          requested_role, expires_at, created_at, updated_at
        ) VALUES (?, ?, 'invitation', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        requestId, orgId, user.id, invited?.id ?? null, email, tokenHash,
        requestedRole, new Date(Date.now() + 14 * 86_400_000).toISOString(), now, now,
      ),
      audit(db, user.id, action, orgId, "request", requestId, { role: requestedRole }),
    ];
    // Only account/username invitations are actionable from the private
    // inbox without carrying a secret. Email invitations deliberately keep
    // their token in the email URL and must not create a dead in-app link.
    if (invited && targetUserId) {
      statements.push(notificationInsertStatement(db, {
        kind: "organization_invitation",
        recipientUserId: invited.id,
        actorUserId: user.id,
        organizationId: orgId,
        entityId: requestId,
        eventId: requestId,
        createdAt: now,
      }));
    }
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "accept_invitation") {
    if (!bool(payload.shareFutureHistoryConsent)) fail("Future-history consent is required.");
    const requestId = id(payload.requestId, "request");
    const token = optionalText(payload.token, 512);
    const request = await db.prepare(`
      SELECT id, organization_id, kind, status, requester_user_id,
             target_user_id, requested_role, requested_value,
             invitation_email, invitation_token_hash, expires_at, note
        FROM organization_requests WHERE id = ?
    `).bind(requestId).first<RequestRow>();
    const accountBound = token === null
      && request?.target_user_id === user.id
      && request.invitation_email === null;
    const secretBound = Boolean(
      request
      && token
      && token.length >= 24
      && request.invitation_token_hash === await digest(token)
      && (request.target_user_id === null || request.target_user_id === user.id)
      && (request.invitation_email === null
        || request.invitation_email.toLowerCase() === user.email?.toLowerCase()),
    );
    if (
      !request || request.kind !== "invitation" || request.status !== "pending"
      || (!accountBound && !secretBound)
      || request.expires_at === null
      || Date.parse(request.expires_at) <= Date.now()
    ) notFound("Invitation not found.");
    const requestedRole = request.requested_role;
    if (!requestedRole) notFound("Invitation not found.");
    if (requestedRole === "student" && !(await studentEligible(db, user.id))) fail("An eligible plan or seat is required.");
    const existing = await member(db, request.organization_id, user.id);
    if (existing && existing.status !== "removed") {
      conflict("You already have an active membership in this organisation.");
    }
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare(`UPDATE organization_requests SET status = 'approved', target_user_id = ?,
        decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(user.id, user.id, now, now, requestId),
      existing
        ? db.prepare(`UPDATE organization_memberships SET role = ?, status = 'active',
            share_future_history = 1, joined_at = coalesce(joined_at, ?),
            updated_at = ?, status_changed_at = ? WHERE id = ?`)
          .bind(requestedRole, now, now, now, existing.id)
        : db.prepare(`
            INSERT INTO organization_memberships (
              id, organization_id, user_id, role, status,
              share_future_history, share_pre_join_history, joined_at,
              created_at, updated_at, status_changed_at
            ) VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?)
          `).bind(crypto.randomUUID(), request.organization_id, user.id, requestedRole, now, now, now, now),
      db.prepare(`
        UPDATE organization_requests
           SET status = 'cancelled', decided_by = ?, decided_at = ?, updated_at = ?
         WHERE organization_id = ? AND kind = 'invitation' AND status = 'pending'
           AND id <> ?
           AND (
             target_user_id = ?
             OR (invitation_email IS NOT NULL AND lower(invitation_email) = ?)
           )
      `).bind(
        user.id, now, now, request.organization_id, requestId,
        user.id, user.email?.toLowerCase() ?? "",
      ),
      audit(db, user.id, action, request.organization_id, "request", requestId),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "assign_teacher" || action === "assign_teacher_batch" || action === "unassign_teacher") {
    const orgId = id(payload.organizationId, "organisation");
    const actorRole = await activeRole(db, orgId, user.id);
    if (!canManage(actorRole, platformAdmin)) forbidden();
    const teacherId = id(payload.teacherUserId, "teacher");
    const teacher = await member(db, orgId, teacherId);
    if (!teacher || teacher.role !== "teacher" || teacher.status !== "active") fail("Teacher is not active.");
    const studentIds = action === "assign_teacher_batch"
      ? Array.isArray(payload.studentUserIds) ? [...new Set(payload.studentUserIds.map((item) => id(item, "student")))] : fail("Choose students.")
      : [id(payload.studentUserId, "student")];
    if (studentIds.length < 1 || studentIds.length > 500) fail("Choose between 1 and 500 students.");
    for (const studentId of studentIds) {
      const student = await member(db, orgId, studentId);
      if (!student || student.role !== "student" || (student.status !== "active" && student.status !== "leave_requested")) {
        fail("Student is not active.");
      }
    }
    const response = { ok: true } as const;
    const statements = studentIds.map((studentId) => action === "unassign_teacher"
      ? db.prepare(`UPDATE teacher_student_assignments SET revoked_at = ?, revoked_by = ?
          WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ? AND revoked_at IS NULL`)
        .bind(now, user.id, orgId, teacherId, studentId)
      : db.prepare(`
          INSERT INTO teacher_student_assignments (
            id, organization_id, teacher_user_id, student_user_id,
            assigned_by, created_at, revoked_at, revoked_by
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(organization_id, teacher_user_id, student_user_id)
            WHERE revoked_at IS NULL DO NOTHING
        `).bind(crypto.randomUUID(), orgId, teacherId, studentId, user.id, now));
    statements.push(audit(db, user.id, action, orgId, "assignment", null, {
      teacherUserId: teacherId,
      studentUserIds: studentIds,
    }));
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (
    action === "assign_practice"
    || action === "assign_practice_batch"
    || action === "remove_practice_assignment"
  ) {
    const orgId = id(payload.organizationId, "organisation");
    const actorRole = await activeRole(db, orgId, user.id);

    if (action === "remove_practice_assignment") {
      const studentId = id(payload.studentUserId, "student");
      const student = await member(db, orgId, studentId);
      const teacherAllowed = actorRole === "teacher" && await assigned(db, orgId, user.id, studentId);
      if (!student || student.role !== "student" || !["active", "leave_requested"].includes(student.status)) {
        fail("Student is not active.");
      }
      if (!canManage(actorRole, platformAdmin) && !teacherAllowed) forbidden();
      const assignmentId = id(payload.assignmentId, "practice assignment");
      const assignment = await db.prepare(`
        SELECT id, student_user_id FROM organization_practice_assignments
         WHERE id = ? AND organization_id = ?
      `).bind(assignmentId, orgId).first<PracticeAssignmentRow>();
      if (!assignment || assignment.student_user_id !== studentId) notFound("Practice assignment not found.");
      const response = { ok: true } as const;
      await runBatch(db, [
        db.prepare("DELETE FROM organization_practice_assignments WHERE id = ? AND organization_id = ?")
          .bind(assignmentId, orgId),
        audit(db, user.id, action, orgId, "practice_assignment", assignmentId),
      ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
      return response;
    }

    const studentIds = action === "assign_practice_batch"
      ? Array.isArray(payload.studentUserIds)
        ? [...new Set(payload.studentUserIds.map((item) => id(item, "student")))]
        : fail("Choose students.")
      : [id(payload.studentUserId, "student")];
    // One task can fan out to a class, but this remains deliberately bounded:
    // each student adds one assignment and one private notification statement
    // to the single atomic D1 batch below.
    if (studentIds.length < 1 || studentIds.length > 40) {
      fail("Choose between 1 and 40 students.");
    }
    const studentPlaceholders = studentIds.map(() => "?").join(", ");
    const activeStudents = await db.prepare(`
      SELECT user_id FROM organization_memberships
       WHERE organization_id = ?
         AND user_id IN (${studentPlaceholders})
         AND role = 'student'
         AND status IN ('active', 'leave_requested')
    `).bind(orgId, ...studentIds).all<{ user_id: string }>();
    if (activeStudents.results.length !== studentIds.length) fail("Student is not active.");
    if (!canManage(actorRole, platformAdmin)) {
      if (actorRole !== "teacher") forbidden();
      const assignedStudents = await db.prepare(`
        SELECT student_user_id FROM teacher_student_assignments
         WHERE organization_id = ? AND teacher_user_id = ?
           AND student_user_id IN (${studentPlaceholders})
           AND revoked_at IS NULL
      `).bind(orgId, user.id, ...studentIds).all<{ student_user_id: string }>();
      if (assignedStudents.results.length !== studentIds.length) forbidden();
    }

    const target = organizationPracticeTarget(payload.skill, payload.testId);
    if (!target) fail("Choose a BandUp practice item.");
    const note = optionalText(payload.note, 1200);
    const dueAt = optionalText(payload.dueAt, 40);
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) fail("Invalid due date.");
    const assignments = studentIds.map((studentId) => ({
      assignmentId: crypto.randomUUID(),
      studentId,
    }));
    const response = { ok: true } as const;
    const statements: D1PreparedStatement[] = [];
    for (const { assignmentId, studentId } of assignments) {
      statements.push(db.prepare(`
        INSERT INTO organization_practice_assignments (
          id, organization_id, assigned_by_user_id, student_user_id,
          module, test_id, test_title, note, due_at, assigned_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        assignmentId, orgId, user.id, studentId, target.skill, target.testId,
        target.title, note, dueAt ? new Date(dueAt).toISOString() : null, now, now,
      ));
      statements.push(notificationInsertStatement(db, {
        kind: "practice_assigned",
        recipientUserId: studentId,
        actorUserId: user.id,
        organizationId: orgId,
        entityId: assignmentId,
        eventId: assignmentId,
        createdAt: now,
      }));
    }
    statements.push(audit(db, user.id, action, orgId, "practice_assignment_batch", null, {
      studentUserIds: studentIds,
      assignmentIds: assignments.map(({ assignmentId }) => assignmentId),
      skill: target.skill,
      testId: target.testId,
    }));
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "save_teacher_feedback" || action === "remove_teacher_feedback") {
    const orgId = id(payload.organizationId, "organisation");
    const attemptId = id(payload.attemptId, "attempt");
    const actorRole = await activeRole(db, orgId, user.id);
    const attempt = await db.prepare(`
      SELECT a.id, a.user_id, a.submitted_at FROM practice_attempts a
      JOIN organization_memberships m ON m.organization_id = ? AND m.user_id = a.user_id
      WHERE a.id = ?
        AND (m.share_pre_join_history = 1 OR (m.share_future_history = 1 AND a.submitted_at >= coalesce(m.joined_at, m.created_at)))
        AND NOT EXISTS (SELECT 1 FROM organization_attempt_tombstones t WHERE t.organization_id = m.organization_id AND t.attempt_id = a.id)
    `).bind(orgId, attemptId).first<AttemptRow>();
    if (!attempt) notFound("Sitting not found.");
    const teacherAllowed = actorRole === "teacher" && await assigned(db, orgId, user.id, attempt.user_id);
    if (!canManage(actorRole, platformAdmin) && !teacherAllowed) forbidden();

    if (action === "remove_teacher_feedback") {
      const feedbackId = id(payload.feedbackId, "feedback");
      const response = { ok: true } as const;
      const ownOnly = !canManage(actorRole, platformAdmin);
      await runBatch(db, [
        db.prepare(`DELETE FROM organization_teacher_feedback
          WHERE id = ? AND organization_id = ? ${ownOnly ? "AND teacher_user_id = ?" : ""}`)
          .bind(...(ownOnly ? [feedbackId, orgId, user.id] : [feedbackId, orgId])),
        audit(db, user.id, action, orgId, "teacher_feedback", feedbackId),
      ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
      return response;
    }

    const message = text(payload.message, "Feedback", 1, 3000);
    const feedbackId = crypto.randomUUID();
    const response = { ok: true } as const;
    await runBatch(db, [
      db.prepare(`
        INSERT INTO organization_teacher_feedback (
          id, organization_id, attempt_id, student_user_id, teacher_user_id,
          message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organization_id, attempt_id, teacher_user_id) DO UPDATE SET
          message = excluded.message, updated_at = excluded.updated_at
      `).bind(feedbackId, orgId, attemptId, attempt.user_id, user.id, message, now, now),
      notificationInsertStatement(db, {
        kind: "teacher_feedback",
        recipientUserId: attempt.user_id,
        actorUserId: user.id,
        organizationId: orgId,
        entityId: attemptId,
        eventId: `feedback:${attemptId}:${user.id}:${idempotencyKey}`,
        createdAt: now,
      }),
      audit(db, user.id, action, orgId, "teacher_feedback", attemptId, { studentUserId: attempt.user_id }),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (
    action === "change_member_role" || action === "suspend_member"
    || action === "restore_member" || action === "remove_member"
  ) {
    const orgId = id(payload.organizationId, "organisation");
    const targetId = id(payload.userId ?? payload.targetUserId, "member");
    const actorRole = await activeRole(db, orgId, user.id);
    const target = await member(db, orgId, targetId);
    if (!canManage(actorRole, platformAdmin) || !target) forbidden();
    if (target.role === "owner" && !platformAdmin) fail("Only BandUp can manage an owner.");
    if (actorRole === "manager" && (target.role === "manager" || target.role === "owner") && !platformAdmin) {
      fail("A manager cannot manage peers or owners.");
    }
    let requestedRole: OrganizationRole | null = null;
    if (action === "change_member_role") {
      requestedRole = role(payload.role, true);
      if ((requestedRole === "manager" || requestedRole === "owner") && !platformAdmin && actorRole !== "owner") fail("Invalid role.");
      if (requestedRole === "student" && target.role !== "student") {
        conflict("Invite this person as a student so they can accept history sharing first.");
      }
      if (requestedRole === "student" && !(await studentEligible(db, targetId))) fail("The student needs an eligible plan or seat.");
    }
    if (action === "restore_member" && target.status !== "suspended") {
      conflict("A former member must accept a new invitation before rejoining.");
    }
    if (action === "restore_member" && target.role === "student" && !(await studentEligible(db, targetId))) {
      fail("The student needs an eligible plan or seat.");
    }
    const response = { ok: true } as const;
    const statements: D1PreparedStatement[] = [
      action === "change_member_role"
        ? db.prepare("UPDATE organization_memberships SET role = ?, updated_at = ? WHERE id = ?")
          .bind(requestedRole, now, target.id)
        : db.prepare(`UPDATE organization_memberships SET status = ?,
            joined_at = CASE WHEN ? = 'active' THEN coalesce(joined_at, ?) ELSE joined_at END,
            removed_at = CASE WHEN ? = 'removed' THEN ? ELSE removed_at END,
            updated_at = ?, status_changed_at = ? WHERE id = ?`)
          .bind(
            action === "suspend_member" ? "suspended" : action === "restore_member" ? "active" : "removed",
            action === "restore_member" ? "active" : "other", now,
            action === "remove_member" ? "removed" : "other", now,
            now, now, target.id,
          ),
    ];
    if (action === "remove_member" || (action === "change_member_role" && requestedRole !== target.role)) statements.push(db.prepare(`
      UPDATE teacher_student_assignments SET revoked_at = ?, revoked_by = ?
       WHERE organization_id = ? AND revoked_at IS NULL
         AND (teacher_user_id = ? OR student_user_id = ?)
    `).bind(now, user.id, orgId, targetId, targetId));
    statements.push(audit(db, user.id, action, orgId, "membership", target.id, requestedRole ? { role: requestedRole } : {}));
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "archive_attempt" || action === "restore_attempt" || action === "remove_attempt_permanently") {
    const orgId = id(payload.organizationId, "organisation");
    const attemptId = id(payload.attemptId, "attempt");
    const actorRole = await activeRole(db, orgId, user.id);
    const attempt = await db.prepare(`
      SELECT a.id, a.user_id, a.submitted_at FROM practice_attempts a
      JOIN organization_memberships m ON m.organization_id = ? AND m.user_id = a.user_id
      WHERE a.id = ?
        AND (m.share_pre_join_history = 1 OR (m.share_future_history = 1 AND a.submitted_at >= coalesce(m.joined_at, m.created_at)))
        AND NOT EXISTS (SELECT 1 FROM organization_attempt_tombstones t WHERE t.organization_id = m.organization_id AND t.attempt_id = a.id)
    `).bind(orgId, attemptId).first<AttemptRow>();
    if (!attempt) notFound("Attempt not found.");
    const teacherAllowed = actorRole === "teacher" && await assigned(db, orgId, user.id, attempt.user_id);
    if (action === "remove_attempt_permanently") {
      if (!canManage(actorRole, platformAdmin)) forbidden();
    } else if (!canManage(actorRole, platformAdmin) && !teacherAllowed) forbidden();
    const reason = optionalText(payload.reason, 2000);
    if (action === "remove_attempt_permanently" && (!reason || reason.length < 3)) fail("A reason is required for permanent removal.");
    const response = { ok: true } as const;
    const change = action === "archive_attempt"
      ? db.prepare(`
          INSERT INTO organization_attempt_archives (
            organization_id, attempt_id, archived_by, reason, archived_at,
            restored_by, restored_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(organization_id, attempt_id) DO UPDATE SET
            archived_by = excluded.archived_by, reason = excluded.reason,
            archived_at = excluded.archived_at, restored_by = NULL, restored_at = NULL
        `).bind(orgId, attemptId, user.id, reason, now)
      : action === "restore_attempt"
        ? db.prepare(`UPDATE organization_attempt_archives SET restored_by = ?, restored_at = ?
            WHERE organization_id = ? AND attempt_id = ? AND restored_at IS NULL`)
          .bind(user.id, now, orgId, attemptId)
        : db.prepare(`
            INSERT OR IGNORE INTO organization_attempt_tombstones (
              organization_id, attempt_id, student_user_id, removed_by, reason, removed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).bind(orgId, attemptId, attempt.user_id, user.id, reason, now);
    await runBatch(db, [
      change,
      audit(db, user.id, action, orgId, "attempt", attemptId, { reason }),
    ], receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  if (action === "reserve_seat" || action === "release_seat") {
    const orgId = id(payload.organizationId, "organisation");
    const targetId = id(payload.userId ?? payload.targetUserId, "member");
    const actorRole = await activeRole(db, orgId, user.id);
    if (!canManage(actorRole, platformAdmin)) forbidden();
    const response = { ok: true } as const;
    const statements: D1PreparedStatement[] = [];
    if (action === "reserve_seat") {
      const seatPoolId = id(payload.seatPoolId, "seat pool");
      const pool = await db.prepare(`
        SELECT id, seat_count FROM organization_seat_pools
         WHERE id = ? AND organization_id = ? AND status = 'active'
           AND (ends_at IS NULL OR ends_at > ?)
      `).bind(seatPoolId, orgId, now).first<{ id: string; seat_count: number }>();
      if (!pool) fail("Active seat pool not found.");
      const used = await db.prepare(`
        SELECT count(*) AS total FROM organization_seat_allocations
         WHERE seat_pool_id = ? AND status IN ('reserved', 'active')
      `).bind(seatPoolId).first<{ total: number }>();
      if (Number(used?.total ?? 0) >= pool.seat_count) fail("No seats are available.");
      statements.push(db.prepare(`
        INSERT INTO organization_seat_allocations (
          id, organization_id, seat_pool_id, user_id, status, starts_at,
          allocated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?)
        ON CONFLICT(organization_id, user_id) WHERE status IN ('reserved', 'active') DO NOTHING
      `).bind(crypto.randomUUID(), orgId, seatPoolId, targetId, now, user.id, now, now));
    } else {
      statements.push(db.prepare(`
        UPDATE organization_seat_allocations SET status = 'released', ends_at = ?, updated_at = ?
         WHERE organization_id = ? AND user_id = ? AND status IN ('reserved', 'active')
      `).bind(now, now, orgId, targetId));
    }
    statements.push(audit(db, user.id, action, orgId, "seat", targetId));
    await runBatch(db, statements, receipt(db, user.id, idempotencyKey, action, requestHash, response));
    return response;
  }

  fail("Unknown organisation action.");
}

export async function cloudflareOrganizationCommand(
  user: SessionUser,
  platformAdmin: boolean,
  action: OrganizationAction,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<OrganizationActionResponse> {
  if (!IDEMPOTENCY.test(idempotencyKey)) fail("Invalid request identifier.");
  if (JSON.stringify(payload).length > 65_536) fail("Invalid command data.");
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const { db } = bindings;
  await ensureCloudflareUser(user, bindings);
  const requestHash = await digest({ action, payload });
  const existing = await priorReceipt(db, user.id, idempotencyKey, action, requestHash);
  if (existing) {
    return { ok: true, ...existing };
  }
  const organizationId = await commandOrganization(db, action, payload);
  const scope = organizationId
    ? `organization:${organizationId}`
    : typeof payload.applicationId === "string"
      ? `application:${payload.applicationId}`
      : `actor:${user.id}`;
  const owner = `${user.id}:${idempotencyKey}`;
  await acquireLock(db, scope, owner);
  try {
    const afterLock = await priorReceipt(db, user.id, idempotencyKey, action, requestHash);
    const result = afterLock ?? await executeCommand(
      db, user, platformAdmin, action, payload, idempotencyKey, requestHash,
    );
    // Mutation + receipt have committed. A portal refresh is a separate read
    // and must never make a durable success look like an uncommitted 503.
    return { ok: true, ...result };
  } finally {
    await releaseLock(db, scope, owner).catch(() => undefined);
  }
}
