import type { SessionUser } from "@/lib/auth/session";
import type { ModuleResult } from "@/lib/types";
import type { HomeOrganizationShortcut } from "@/lib/dashboard-home";
import {
  organizationAttemptHasReview,
  organizationAttempts,
} from "@/lib/organizations/attempt-sync";
import type {
  OrganizationPracticeAssignment,
  OrganizationTeacherFeedback,
  OrganizationMember,
  OrganizationMembership,
  OrganizationPortal,
  OrganizationRequest,
  OrganizationRole,
  OrganizationSummary,
  StudentHistory,
  StudentHistoryAttempt,
  StudentProgressSummary,
  TeacherAssignment,
} from "@/lib/organizations/types";
import { organizationPracticeTarget } from "@/lib/organizations/practice-assignments";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { ensureCloudflareUser } from "./learner-data";
import {
  reconcileOrganizationAttemptObjects,
  retireOrganizationAttemptObjects,
} from "./organization-attempt-objects";
import { readStoredJson, sha256, storeJson, type StoredJson } from "./payloads";
import { assignmentCompletionNotificationStatement } from "./notifications";

type Db = Env["BANDUP_DB"];

interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  status: OrganizationMembership["status"];
  share_future_history: number;
  share_pre_join_history: number;
  joined_at: string | null;
  created_at: string;
  org_name: string;
  org_slug: string | null;
  org_status: OrganizationSummary["status"];
  org_created_at: string;
  member_count: number;
  student_count: number;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string | null;
  status: OrganizationSummary["status"];
  created_at: string;
  member_count: number;
  student_count: number;
}

interface MemberRow {
  membership_id: string;
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: OrganizationRole;
  status: OrganizationMembership["status"];
  joined_at: string | null;
}

interface RequestRow {
  id: string;
  organization_id: string;
  kind: OrganizationRequest["kind"];
  status: OrganizationRequest["status"];
  requester_user_id: string;
  requester_name: string | null;
  requester_email: string | null;
  target_user_id: string | null;
  invitation_email: string | null;
  requested_role: OrganizationRole | null;
  requested_value: number | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

interface AssignmentRow {
  id: string;
  organization_id: string;
  teacher_user_id: string;
  teacher_name: string | null;
  student_user_id: string;
  student_name: string | null;
  created_at: string;
}

interface AttemptRow {
  id: string;
  user_id: string;
  module: StudentHistoryAttempt["skill"];
  test_title: string;
  submitted_at: string;
  score: number | null;
  score_out_of: number | null;
  band: number | null;
  feedback_summary: string | null;
  result_inline: string | null;
  result_object_key: string | null;
  result_sha256: string;
  result_bytes: number;
  archived_at: string | null;
}

interface PracticeAssignmentRow {
  id: string;
  organization_id: string;
  assigned_by_user_id: string | null;
  assigned_by_name: string | null;
  student_user_id: string;
  student_name: string | null;
  module: OrganizationPracticeAssignment["skill"];
  test_id: string;
  test_title: string;
  note: string | null;
  due_at: string | null;
  assigned_at: string;
  completed_attempt_id: string | null;
  completed_at: string | null;
}

interface TeacherFeedbackRow {
  id: string;
  organization_id: string;
  attempt_id: string;
  teacher_user_id: string | null;
  teacher_name: string | null;
  message: string;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

async function rows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results;
}

function summary(row: OrganizationRow | MembershipRow): OrganizationSummary {
  if ("organization_id" in row) {
    return {
      id: row.organization_id,
      name: row.org_name,
      slug: row.org_slug,
      status: row.org_status,
      memberCount: Number(row.member_count),
      studentCount: Number(row.student_count),
      createdAt: row.org_created_at,
    };
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    memberCount: Number(row.member_count),
    studentCount: Number(row.student_count),
    createdAt: row.created_at,
  };
}

function paidTier(tier: string): tier is "standard" | "plus" | "pro" | "admin" {
  return tier === "standard" || tier === "plus" || tier === "pro" || tier === "admin";
}

async function actorTier(db: Db, user: SessionUser, platformAdmin: boolean) {
  if (platformAdmin) return "admin" as const;
  const stamp = now();
  const active = await db.prepare(`
    SELECT tier
      FROM subscriptions
     WHERE user_id = ?
       AND status IN ('active', 'trialing')
       AND (current_period_end IS NULL OR current_period_end > ?)
     ORDER BY CASE tier WHEN 'pro' THEN 3 WHEN 'plus' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END DESC,
              verified_at DESC
     LIMIT 1
  `).bind(user.id, stamp).first<{ tier: string }>();
  return active && paidTier(active.tier) ? active.tier : "free";
}

function membershipFrom(row: MembershipRow, latestRequests: Map<string, OrganizationRequest["status"]>) {
  return {
    id: row.id,
    organization: summary(row),
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at,
    shareFutureHistory: row.share_future_history === 1,
    sharePreJoinHistory: row.share_pre_join_history === 1,
    preJoinHistoryRequestStatus: latestRequests.get(`${row.organization_id}:history_access_change:prior`) ?? null,
    futureHistoryRequestStatus: latestRequests.get(`${row.organization_id}:history_access_change:future`) ?? null,
    leaveRequestStatus: latestRequests.get(`${row.organization_id}:leave`) ?? null,
  } satisfies OrganizationMembership;
}

async function organizationMemberships(db: Db, userId: string): Promise<OrganizationMembership[]> {
  const [membershipRows, requestRows] = await Promise.all([
    rows<MembershipRow>(db.prepare(`
      SELECT m.id, m.organization_id, m.user_id, m.role, m.status,
             m.share_future_history, m.share_pre_join_history, m.joined_at, m.created_at,
             o.name AS org_name, o.slug AS org_slug, o.status AS org_status,
             o.created_at AS org_created_at,
             (SELECT count(*) FROM organization_memberships c
               WHERE c.organization_id = o.id AND c.status <> 'removed') AS member_count,
             (SELECT count(*) FROM organization_memberships c
               WHERE c.organization_id = o.id AND c.role = 'student' AND c.status <> 'removed') AS student_count
        FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = ?
       ORDER BY m.created_at DESC
    `).bind(userId)),
    rows<{ organization_id: string; kind: string; status: OrganizationRequest["status"]; note: string | null }>(db.prepare(`
      SELECT organization_id, kind, status, note
        FROM organization_requests
       WHERE requester_user_id = ? AND kind IN ('leave', 'history_access_change')
       ORDER BY created_at DESC
    `).bind(userId)),
  ]);
  const latest = new Map<string, OrganizationRequest["status"]>();
  for (const request of requestRows) {
    const scope = request.kind === "history_access_change" && request.note === "scope:future"
      ? "future" : request.kind === "history_access_change" ? "prior" : "";
    const key = `${request.organization_id}:${request.kind}${scope ? `:${scope}` : ""}`;
    if (!latest.has(key)) latest.set(key, request.status);
  }
  return membershipRows.map((row) => membershipFrom(row, latest));
}

async function organizationRows(db: Db): Promise<OrganizationRow[]> {
  return rows<OrganizationRow>(db.prepare(`
    SELECT o.id, o.name, o.slug, o.status, o.created_at,
           (SELECT count(*) FROM organization_memberships m
             WHERE m.organization_id = o.id AND m.status <> 'removed') AS member_count,
           (SELECT count(*) FROM organization_memberships m
             WHERE m.organization_id = o.id AND m.role = 'student' AND m.status <> 'removed') AS student_count
      FROM organizations o
     ORDER BY o.created_at DESC
  `));
}

function activeOrganization(
  memberships: OrganizationMembership[],
  organizations: OrganizationSummary[] | null,
  selectedOrganizationId: string | null,
  platformAdmin: boolean,
): { id: string; role: OrganizationRole } | null {
  if (platformAdmin) {
    const selected = selectedOrganizationId
      ? organizations?.find((organization) => organization.id === selectedOrganizationId)
      : organizations?.find((organization) => organization.status === "active") ?? organizations?.[0];
    return selected ? { id: selected.id, role: "owner" } : null;
  }
  const eligibleMemberships = memberships.filter((membership) =>
    (membership.status === "active" || membership.status === "leave_requested")
    && membership.organization.status === "active"
  );
  /*
    A learner may belong to more than one organization. The URL-selected
    workspace is still checked against that learner's own active memberships;
    an arbitrary query string can never make another roster visible. When an
    old link names a membership that has since ended, fall back to the newest
    active workspace instead of presenting an empty, misleading dashboard.
  */
  const active = selectedOrganizationId
    ? eligibleMemberships.find((membership) => membership.organization.id === selectedOrganizationId)
      ?? eligibleMemberships[0]
    : eligibleMemberships[0];
  return active ? { id: active.organization.id, role: active.role } : null;
}

async function membersFor(db: Db, organizationId: string): Promise<OrganizationMember[]> {
  const [memberRows, assignmentRows] = await Promise.all([
    rows<MemberRow>(db.prepare(`
      SELECT m.id AS membership_id, m.user_id, p.display_name, u.email,
             m.role, m.status, m.joined_at
        FROM organization_memberships m
        JOIN app_users u ON u.id = m.user_id
        LEFT JOIN learner_profiles p ON p.user_id = m.user_id
       WHERE m.organization_id = ? AND m.status <> 'removed'
       ORDER BY m.role, coalesce(p.display_name, u.email)
    `).bind(organizationId)),
    rows<{ teacher_user_id: string; student_user_id: string }>(db.prepare(`
      SELECT teacher_user_id, student_user_id
        FROM teacher_student_assignments
       WHERE organization_id = ? AND revoked_at IS NULL
    `).bind(organizationId)),
  ]);
  return memberRows.map((row) => ({
    membershipId: row.membership_id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: null,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at,
    assignedTeacherIds: assignmentRows
      .filter((assignment) => assignment.student_user_id === row.user_id)
      .map((assignment) => assignment.teacher_user_id),
  }));
}

async function requestsFor(
  db: Db,
  organizationId: string,
  teacherUserId?: string,
): Promise<OrganizationRequest[]> {
  const list = await rows<RequestRow>(db.prepare(`
    SELECT r.id, r.organization_id, r.kind, r.status, r.requester_user_id,
           p.display_name AS requester_name, u.email AS requester_email,
           r.target_user_id, r.invitation_email, r.requested_role,
           r.requested_value, r.note, r.created_at, r.decided_at
      FROM organization_requests r
      JOIN app_users u ON u.id = r.requester_user_id
      LEFT JOIN learner_profiles p ON p.user_id = r.requester_user_id
     WHERE r.organization_id = ?
       ${teacherUserId ? `AND r.kind = 'history_access_change' AND r.status = 'pending'
         AND EXISTS (
           SELECT 1 FROM teacher_student_assignments a
            WHERE a.organization_id = r.organization_id
              AND a.teacher_user_id = ? AND a.student_user_id = r.requester_user_id
              AND a.revoked_at IS NULL
         )` : ""}
     ORDER BY r.created_at DESC
  `).bind(...(teacherUserId ? [organizationId, teacherUserId] : [organizationId])));
  return list.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    status: row.status,
    requesterUserId: row.requester_user_id,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
    targetUserId: row.target_user_id,
    invitationEmail: row.invitation_email,
    requestedRole: row.requested_role,
    requestedValue: row.requested_value === null ? null : row.requested_value === 1,
    note: row.note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }));
}

async function assignmentsFor(db: Db, organizationId: string): Promise<TeacherAssignment[]> {
  const list = await rows<AssignmentRow>(db.prepare(`
    SELECT a.id, a.organization_id, a.teacher_user_id,
           tp.display_name AS teacher_name, a.student_user_id,
           sp.display_name AS student_name, a.created_at
      FROM teacher_student_assignments a
      LEFT JOIN learner_profiles tp ON tp.user_id = a.teacher_user_id
      LEFT JOIN learner_profiles sp ON sp.user_id = a.student_user_id
     WHERE a.organization_id = ? AND a.revoked_at IS NULL
     ORDER BY a.created_at DESC
  `).bind(organizationId));
  return list.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    teacherUserId: row.teacher_user_id,
    teacherName: row.teacher_name,
    studentUserId: row.student_user_id,
    studentName: row.student_name,
    createdAt: row.created_at,
  }));
}

function practiceAssignmentFrom(row: PracticeAssignmentRow): OrganizationPracticeAssignment | null {
  const target = organizationPracticeTarget(row.module, row.test_id);
  if (!target) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedByName: row.assigned_by_name,
    studentUserId: row.student_user_id,
    studentName: row.student_name,
    skill: row.module,
    testId: row.test_id,
    title: row.test_title,
    href: target.href,
    note: row.note,
    dueAt: row.due_at,
    assignedAt: row.assigned_at,
    completedAttemptId: row.completed_attempt_id,
    completedAt: row.completed_at,
  };
}

async function practiceAssignmentsFor(
  db: Db,
  organizationId: string,
  actorId: string,
  role: OrganizationRole,
  platformAdmin: boolean,
): Promise<OrganizationPracticeAssignment[]> {
  const accessClause = platformAdmin || role === "manager" || role === "owner"
    ? ""
    : role === "teacher"
      ? "AND EXISTS (SELECT 1 FROM teacher_student_assignments ta WHERE ta.organization_id = pa.organization_id AND ta.teacher_user_id = ? AND ta.student_user_id = pa.student_user_id AND ta.revoked_at IS NULL)"
      : "AND pa.student_user_id = ?";
  const bind = accessClause ? [organizationId, actorId] : [organizationId];
  const list = await rows<PracticeAssignmentRow>(db.prepare(`
    SELECT pa.id, pa.organization_id, pa.assigned_by_user_id,
           assigner.display_name AS assigned_by_name, pa.student_user_id,
           student.display_name AS student_name, pa.module, pa.test_id,
           pa.test_title, pa.note, pa.due_at, pa.assigned_at,
           completed.id AS completed_attempt_id,
           completed.submitted_at AS completed_at
      FROM organization_practice_assignments pa
      LEFT JOIN learner_profiles assigner ON assigner.user_id = pa.assigned_by_user_id
      LEFT JOIN learner_profiles student ON student.user_id = pa.student_user_id
      LEFT JOIN practice_attempts completed ON completed.id = (
        SELECT a.id
          FROM practice_attempts a
         WHERE a.user_id = pa.student_user_id
           AND a.module = pa.module
           AND a.submitted_at >= pa.assigned_at
           AND (pa.module IN ('writing', 'speaking') OR a.test_id = pa.test_id)
           AND EXISTS (
             SELECT 1
               FROM organization_memberships m
              WHERE m.organization_id = pa.organization_id
                AND m.user_id = a.user_id
                AND (
                  m.share_pre_join_history = 1 OR (
                    m.share_future_history = 1
                    AND a.submitted_at >= coalesce(m.joined_at, m.created_at)
                  )
                )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM organization_attempt_tombstones t
              WHERE t.organization_id = pa.organization_id
                AND t.attempt_id = a.id
           )
         ORDER BY a.submitted_at, a.id
         LIMIT 1
      )
     WHERE pa.organization_id = ? ${accessClause}
     ORDER BY CASE WHEN pa.due_at IS NULL THEN 1 ELSE 0 END, pa.due_at, pa.assigned_at DESC
  `).bind(...bind));
  return list.map(practiceAssignmentFrom).filter((item): item is OrganizationPracticeAssignment => item !== null);
}

function teacherFeedbackFrom(row: TeacherFeedbackRow): OrganizationTeacherFeedback {
  return {
    id: row.id,
    organizationId: row.organization_id,
    attemptId: row.attempt_id,
    teacherUserId: row.teacher_user_id,
    teacherName: row.teacher_name,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function feedbackForAttempts(
  db: Db,
  organizationId: string,
  attemptIds: readonly string[],
): Promise<Map<string, OrganizationTeacherFeedback[]>> {
  if (attemptIds.length === 0) return new Map();
  const marks = attemptIds.map(() => "?").join(",");
  const list = await rows<TeacherFeedbackRow>(db.prepare(`
    SELECT f.id, f.organization_id, f.attempt_id, f.teacher_user_id,
           p.display_name AS teacher_name, f.message, f.created_at, f.updated_at
      FROM organization_teacher_feedback f
      LEFT JOIN learner_profiles p ON p.user_id = f.teacher_user_id
     WHERE f.organization_id = ? AND f.attempt_id IN (${marks})
     ORDER BY f.updated_at DESC
  `).bind(organizationId, ...attemptIds));
  const grouped = new Map<string, OrganizationTeacherFeedback[]>();
  for (const row of list) {
    const current = grouped.get(row.attempt_id) ?? [];
    current.push(teacherFeedbackFrom(row));
    grouped.set(row.attempt_id, current);
  }
  return grouped;
}

async function recentFeedbackFor(
  db: Db,
  organizationId: string,
  actorId: string,
  role: OrganizationRole,
  platformAdmin: boolean,
): Promise<OrganizationTeacherFeedback[]> {
  const accessClause = platformAdmin || role === "manager" || role === "owner"
    ? ""
    : role === "teacher"
      ? "AND EXISTS (SELECT 1 FROM teacher_student_assignments ta WHERE ta.organization_id = f.organization_id AND ta.teacher_user_id = ? AND ta.student_user_id = f.student_user_id AND ta.revoked_at IS NULL)"
      : "AND f.student_user_id = ?";
  const bind = accessClause ? [organizationId, actorId] : [organizationId];
  const list = await rows<TeacherFeedbackRow>(db.prepare(`
    SELECT f.id, f.organization_id, f.attempt_id, f.teacher_user_id,
           p.display_name AS teacher_name, f.message, f.created_at, f.updated_at
      FROM organization_teacher_feedback f
      LEFT JOIN learner_profiles p ON p.user_id = f.teacher_user_id
     WHERE f.organization_id = ? ${accessClause}
     ORDER BY f.updated_at DESC LIMIT 12
  `).bind(...bind));
  return list.map(teacherFeedbackFrom);
}

async function studentsFor(
  db: Db,
  organizationId: string,
  actorId: string,
  role: OrganizationRole,
  platformAdmin: boolean,
  studentId?: string,
): Promise<StudentProgressSummary[]> {
  const assignmentClause = platformAdmin || role === "manager" || role === "owner"
    ? ""
    : "AND EXISTS (SELECT 1 FROM teacher_student_assignments ta WHERE ta.organization_id = m.organization_id AND ta.teacher_user_id = ? AND ta.student_user_id = m.user_id AND ta.revoked_at IS NULL)";
  const studentClause = studentId ? "AND m.user_id = ?" : "";
  const studentBindings = [
    organizationId,
    ...(assignmentClause ? [actorId] : []),
    ...(studentId ? [studentId] : []),
  ];
  const studentRows = await rows<MemberRow>(db.prepare(`
    SELECT m.id AS membership_id, m.user_id, p.display_name, u.email,
           m.role, m.status, m.joined_at
      FROM organization_memberships m
      JOIN app_users u ON u.id = m.user_id
      LEFT JOIN learner_profiles p ON p.user_id = m.user_id
     WHERE m.organization_id = ? AND m.role = 'student'
       AND m.status IN ('active', 'leave_requested', 'suspended')
       ${assignmentClause}
       ${studentClause}
     ORDER BY coalesce(p.display_name, u.email)
  `).bind(...studentBindings));
  if (studentRows.length === 0) return [];

  const ids = studentRows.map((student) => student.user_id);
  const markers = ids.map(() => "?").join(",");
  const attempts = await rows<{ user_id: string; module: string; band: number | null; submitted_at: string }>(db.prepare(`
    SELECT a.user_id, a.module, a.band, a.submitted_at
      FROM practice_attempts a
      JOIN organization_memberships m ON m.organization_id = ? AND m.user_id = a.user_id
     WHERE a.user_id IN (${markers})
       AND (m.share_pre_join_history = 1 OR (m.share_future_history = 1 AND a.submitted_at >= coalesce(m.joined_at, m.created_at)))
       AND NOT EXISTS (SELECT 1 FROM organization_attempt_tombstones t WHERE t.organization_id = m.organization_id AND t.attempt_id = a.id)
     ORDER BY a.submitted_at DESC
  `).bind(organizationId, ...ids));

  return studentRows.map((student) => {
    const own = attempts.filter((attempt) => attempt.user_id === student.user_id);
    const latestBands: StudentProgressSummary["latestBands"] = {};
    for (const attempt of own) {
      if (
        attempt.band !== null
        && (attempt.module === "listening" || attempt.module === "reading" || attempt.module === "writing" || attempt.module === "speaking")
        && latestBands[attempt.module] === undefined
      ) latestBands[attempt.module] = attempt.band;
    }
    return {
      userId: student.user_id,
      membershipId: student.membership_id,
      displayName: student.display_name,
      email: student.email,
      avatarUrl: null,
      lastActiveAt: own[0]?.submitted_at ?? null,
      completedAttempts: own.length,
      latestBands,
      archivedAt: null,
    };
  });
}

export async function cloudflareOrganizationPortal(
  user: SessionUser,
  platformAdmin: boolean,
  selectedOrganizationId?: string | null,
  providedBindings?: BandUpCloudflareBindings,
): Promise<OrganizationPortal> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const { db } = bindings;
  await ensureCloudflareUser(user, bindings);
  const [tier, memberships, allOrganizationRows, profile] = await Promise.all([
    actorTier(db, user, platformAdmin),
    organizationMemberships(db, user.id),
    platformAdmin ? organizationRows(db) : Promise.resolve([]),
    db.prepare("SELECT display_name FROM learner_profiles WHERE user_id = ?").bind(user.id).first<{ display_name: string | null }>(),
  ]);
  const organizations = platformAdmin ? allOrganizationRows.map(summary) : null;
  const active = activeOrganization(memberships, organizations, selectedOrganizationId ?? null, platformAdmin);
  const canManage = active && (platformAdmin || active.role === "manager" || active.role === "owner");
  const canTeach = active && (canManage || active.role === "teacher");
  const [members, requests, students, assignments, practiceAssignments, recentFeedback] = active ? await Promise.all([
    canManage ? membersFor(db, active.id) : Promise.resolve(null),
    canManage ? requestsFor(db, active.id)
      : active.role === "teacher" ? requestsFor(db, active.id, user.id)
        : Promise.resolve(null),
    canTeach ? studentsFor(db, active.id, user.id, active.role, platformAdmin) : Promise.resolve(null),
    canManage ? assignmentsFor(db, active.id) : Promise.resolve(null),
    practiceAssignmentsFor(db, active.id, user.id, active.role, platformAdmin),
    recentFeedbackFor(db, active.id, user.id, active.role, platformAdmin),
  ]) : [null, null, null, null, null, null];
  const seatClock = now();
  const hasSeat = await db.prepare(`
    SELECT 1 AS ok
      FROM organization_seat_allocations allocation
      JOIN organization_seat_pools pool ON pool.id = allocation.seat_pool_id
       AND pool.organization_id = allocation.organization_id
     WHERE allocation.user_id = ?
       AND allocation.status IN ('reserved', 'active')
       AND allocation.starts_at <= ?
       AND (allocation.ends_at IS NULL OR allocation.ends_at > ?)
       AND pool.status = 'active'
       AND (pool.starts_at IS NULL OR pool.starts_at <= ?)
       AND (pool.ends_at IS NULL OR pool.ends_at > ?)
     LIMIT 1
  `).bind(user.id, seatClock, seatClock, seatClock, seatClock).first<{ ok: number }>();
  const eligible = platformAdmin || paidTier(tier) || Boolean(hasSeat);
  return {
    actor: {
      signedIn: true,
      userId: user.id,
      displayName: profile?.display_name ?? null,
      email: user.email,
      tier,
      platformAdmin,
    },
    eligibility: {
      canJoin: eligible,
      reason: eligible ? null : "A Standard, Plus or Pro plan, or an organisation seat, is required to join as a student.",
    },
    canClearOwnHistory: !memberships.some((membership) =>
      membership.role === "student"
      && (membership.status === "active" || membership.status === "leave_requested" || membership.status === "suspended")
    ),
    activeOrganizationId: active?.id ?? null,
    memberships,
    organizations,
    members,
    requests,
    students,
    assignments,
    practiceAssignments,
    recentFeedback,
  };
}

/**
 * The homepage needs one name and destination, not a manager's complete
 * roster, request queue and progress archive. Keep this read deliberately
 * separate from `cloudflareOrganizationPortal` so opening `/` cannot trigger
 * those heavier organisation queries in the background.
 */
export async function cloudflareOrganizationHomeShortcut(
  user: SessionUser,
  providedBindings?: BandUpCloudflareBindings,
): Promise<HomeOrganizationShortcut | null> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT o.id, o.name, m.role,
           (SELECT count(*) FROM organization_memberships member
             WHERE member.organization_id = o.id AND member.status <> 'removed') AS member_count,
           (SELECT count(*) FROM organization_memberships student
             WHERE student.organization_id = o.id AND student.role = 'student'
               AND student.status <> 'removed') AS student_count
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ? AND m.status = 'active' AND o.status = 'active'
     ORDER BY coalesce(m.joined_at, m.created_at) DESC
     LIMIT 1
  `).bind(user.id).first<{
    id: string;
    name: string;
    role: OrganizationRole;
    member_count: number;
    student_count: number;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    memberCount: Number(row.member_count),
    studentCount: Number(row.student_count),
  };
}

async function historyAuthorization(
  db: Db,
  actorId: string,
  studentId: string,
  platformAdmin: boolean,
  organizationId?: string | null,
): Promise<{ organization: OrganizationSummary; role: OrganizationRole; student: StudentProgressSummary } | null> {
  const candidates = await rows<{ organization_id: string; actor_role: OrganizationRole; student_membership_id: string }>(db.prepare(`
    SELECT student.organization_id, actor.role AS actor_role,
           student.id AS student_membership_id
      FROM organization_memberships student
      JOIN organizations o ON o.id = student.organization_id
      LEFT JOIN organization_memberships actor
        ON actor.organization_id = student.organization_id AND actor.user_id = ?
       AND actor.status IN ('active', 'leave_requested')
     WHERE student.user_id = ? AND student.role = 'student'
       AND (? IS NULL OR student.organization_id = ?)
       AND student.status IN ('active', 'leave_requested', 'suspended')
       AND (? = 1 OR o.status = 'active')
       AND (
         ? = 1 OR actor.role IN ('manager', 'owner') OR (
           actor.role = 'teacher' AND EXISTS (
             SELECT 1 FROM teacher_student_assignments a
              WHERE a.organization_id = student.organization_id
                AND a.teacher_user_id = ? AND a.student_user_id = ?
                AND a.revoked_at IS NULL
           )
         )
       )
     ORDER BY student.joined_at DESC LIMIT 1
  `).bind(actorId, studentId, organizationId ?? null, organizationId ?? null, platformAdmin ? 1 : 0, platformAdmin ? 1 : 0, actorId, studentId));
  const access = candidates[0];
  if (!access) return null;
  const [organization] = (await organizationRows(db)).filter((item) => item.id === access.organization_id).map(summary);
  if (!organization) return null;
  const [selected] = await studentsFor(
    db,
    access.organization_id,
    actorId,
    access.actor_role ?? "owner",
    platformAdmin,
    studentId,
  );
  return selected ? { organization, role: access.actor_role ?? "owner", student: selected } : null;
}

export async function cloudflareOrganizationStudentHistory(
  user: SessionUser,
  platformAdmin: boolean,
  studentId: string,
  providedBindings?: BandUpCloudflareBindings,
  organizationId?: string | null,
  attemptId?: string | null,
): Promise<StudentHistory> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const access = await historyAuthorization(bindings.db, user.id, studentId, platformAdmin, organizationId);
  if (!access) throw new Error("Student not found");
  const attemptRows = await rows<AttemptRow>(bindings.db.prepare(`
    SELECT a.id, a.user_id, a.module, a.test_title, a.submitted_at,
           a.score, a.score_out_of, a.band, a.feedback_summary,
           a.result_inline, a.result_object_key, a.result_sha256, a.result_bytes,
           ar.archived_at
      FROM practice_attempts a
      JOIN organization_memberships m ON m.organization_id = ? AND m.user_id = a.user_id
      LEFT JOIN organization_attempt_archives ar
        ON ar.organization_id = m.organization_id AND ar.attempt_id = a.id
       AND ar.restored_at IS NULL
     WHERE a.user_id = ?
       AND (? IS NULL OR a.id = ?)
       AND (m.share_pre_join_history = 1 OR (m.share_future_history = 1 AND a.submitted_at >= coalesce(m.joined_at, m.created_at)))
       AND NOT EXISTS (SELECT 1 FROM organization_attempt_tombstones t WHERE t.organization_id = m.organization_id AND t.attempt_id = a.id)
     ORDER BY a.submitted_at DESC
  `).bind(access.organization.id, studentId, attemptId ?? null, attemptId ?? null));
  // Keep an unknown, unshared or removed sitting indistinguishable from an
  // unauthorized student. The route maps every one of these cases to 404.
  if (attemptId && attemptRows.length === 0) throw new Error("Sitting not found");
  const feedbackByAttempt = await feedbackForAttempts(
    bindings.db,
    access.organization.id,
    attemptRows.map((row) => row.id),
  );
  const attempts: StudentHistoryAttempt[] = [];
  for (const row of attemptRows) {
    const stored: StoredJson = {
      inline: row.result_inline,
      objectKey: row.result_object_key,
      sha256: row.result_sha256,
      bytes: row.result_bytes,
    };
    const result = await readStoredJson(bindings, stored) as ModuleResult;
    attempts.push({
      id: row.id,
      skill: row.module,
      title: row.test_title,
      submittedAt: row.submitted_at,
      score: row.score,
      scoreOutOf: row.score_out_of,
      band: row.band,
      feedbackSummary: row.feedback_summary,
      review: result.review ?? null,
      teacherFeedback: feedbackByAttempt.get(row.id) ?? [],
      archivedAt: row.archived_at,
    });
  }
  return {
    organization: access.organization,
    student: attemptId
      ? access.student
      : { ...access.student, completedAttempts: attempts.length },
    canArchive: platformAdmin || access.role === "manager" || access.role === "owner" || access.role === "teacher",
    canPermanentlyDelete: platformAdmin || access.role === "manager" || access.role === "owner",
    canProvideFeedback: platformAdmin || access.role === "manager" || access.role === "owner" || access.role === "teacher",
    attempts,
  };
}

function attemptSource(result: ModuleResult): string {
  return `${result.module}|${result.testId}|${result.date}`;
}

async function attemptSourceKey(result: ModuleResult): Promise<string> {
  const bytes = new TextEncoder().encode(attemptSource(result));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function laterWatermark(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function normalizeWatermark(value: string | null): string | null {
  if (!value || value.length > 40 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

async function attemptSyncRequestHash(
  attempts: readonly ModuleResult[],
  historyClearedAt: string | null,
): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify({ attempts, historyClearedAt })));
}

export async function syncCloudflareOrganizationAttempts(
  user: SessionUser,
  attempts: readonly ModuleResult[],
  idempotencyKey: string,
  providedBindings?: BandUpCloudflareBindings,
  historyClearedAt: string | null = null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const incomingWatermark = normalizeWatermark(historyClearedAt);
  const normalizedAttempts = organizationAttempts(attempts);
  if (normalizedAttempts.length === 0 && incomingWatermark === null) return true;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const requestHash = await attemptSyncRequestHash(normalizedAttempts, incomingWatermark);
  const existing = await bindings.db.prepare(`
    SELECT response_json, request_hash FROM organization_sync_receipts
     WHERE user_id = ? AND idempotency_key = ?
  `).bind(user.id, idempotencyKey).first<{
    response_json: string | null;
    request_hash: string | null;
  }>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new Error("Organization attempt idempotency key was reused with different data");
    }
    return true;
  }

  const currentWatermark = await bindings.db.prepare(`
    SELECT cleared_at FROM organization_history_clear_watermarks WHERE user_id = ?
  `).bind(user.id).first<{ cleared_at: string }>();
  const effectiveWatermark = laterWatermark(
    currentWatermark?.cleared_at ?? null,
    incomingWatermark,
  );
  const acceptedAttempts = normalizedAttempts.filter((attempt) =>
    !effectiveWatermark || Date.parse(attempt.date) > Date.parse(effectiveWatermark)
  );
  const prepared = await Promise.all(acceptedAttempts.map(async (result) => ({
    result,
    source: await attemptSourceKey(result),
  })));
  const statements: D1PreparedStatement[] = [];
  if (incomingWatermark) {
    const currentStamp = new Date(nowMs).toISOString();
    statements.push(bindings.db.prepare(`
      INSERT INTO organization_history_clear_watermarks (user_id, cleared_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        cleared_at = CASE
          WHEN julianday(excluded.cleared_at) > julianday(organization_history_clear_watermarks.cleared_at)
            THEN excluded.cleared_at
          ELSE organization_history_clear_watermarks.cleared_at
        END,
        updated_at = CASE
          WHEN julianday(excluded.cleared_at) > julianday(organization_history_clear_watermarks.cleared_at)
            THEN excluded.updated_at
          ELSE organization_history_clear_watermarks.updated_at
        END
    `).bind(user.id, incomingWatermark, currentStamp));
  }
  // Re-apply the durable watermark on every reconciliation so an older device
  // cannot restore a sitting even if it arrives without the clear marker.
  statements.push(bindings.db.prepare(`
    DELETE FROM practice_attempts
     WHERE user_id = ? AND EXISTS (
       SELECT 1 FROM organization_history_clear_watermarks w
        WHERE w.user_id = practice_attempts.user_id
          AND julianday(practice_attempts.submitted_at) <= julianday(w.cleared_at)
     )
  `).bind(user.id));

  const uploadedObjectKeys: string[] = [];
  try {
    for (const { result, source } of prepared) {
      const stored = await storeJson(bindings, "attempts", user.id, result);
      if (stored.objectKey) uploadedObjectKeys.push(stored.objectKey);
      const currentStamp = new Date(nowMs).toISOString();
      const resultHasReview = organizationAttemptHasReview(result) ? 1 : 0;
      const attemptId = crypto.randomUUID();
    statements.push(bindings.db.prepare(`
      INSERT INTO practice_attempts (
        id, user_id, module, test_id, test_title, submitted_at,
        score, score_out_of, band, feedback_summary,
        result_inline, result_object_key, result_sha256, result_bytes,
        created_at, updated_at, source_key, result_has_review
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM organization_history_clear_watermarks
          WHERE user_id = ? AND julianday(cleared_at) >= julianday(?)
       )
      ON CONFLICT(user_id, source_key) WHERE source_key IS NOT NULL DO UPDATE SET
        test_title = excluded.test_title,
        score = excluded.score,
        score_out_of = excluded.score_out_of,
        band = excluded.band,
        feedback_summary = excluded.feedback_summary,
        result_inline = CASE
          WHEN practice_attempts.result_has_review = 1 AND excluded.result_has_review = 0
            THEN practice_attempts.result_inline ELSE excluded.result_inline END,
        result_object_key = CASE
          WHEN practice_attempts.result_has_review = 1 AND excluded.result_has_review = 0
            THEN practice_attempts.result_object_key ELSE excluded.result_object_key END,
        result_sha256 = CASE
          WHEN practice_attempts.result_has_review = 1 AND excluded.result_has_review = 0
            THEN practice_attempts.result_sha256 ELSE excluded.result_sha256 END,
        result_bytes = CASE
          WHEN practice_attempts.result_has_review = 1 AND excluded.result_has_review = 0
            THEN practice_attempts.result_bytes ELSE excluded.result_bytes END,
        result_has_review = max(practice_attempts.result_has_review, excluded.result_has_review),
        updated_at = excluded.updated_at
      WHERE NOT EXISTS (
        SELECT 1 FROM organization_history_clear_watermarks
         WHERE user_id = excluded.user_id
           AND julianday(cleared_at) >= julianday(excluded.submitted_at)
      )
    `).bind(
      attemptId, user.id, result.module, result.testId, result.testTitle,
      result.date, typeof result.raw === "number" ? result.raw : null,
      typeof result.total === "number" ? result.total : null, result.band,
      result.review?.kind === "writing" || result.review?.kind === "speaking" ? null : null,
      stored.inline, stored.objectKey, stored.sha256, stored.bytes,
      currentStamp, currentStamp, source, resultHasReview,
      user.id, result.date,
    ));
      statements.push(assignmentCompletionNotificationStatement(bindings.db, {
        studentUserId: user.id,
        sourceKey: source,
        practiceKind: result.module,
        practiceId: result.testId,
        submittedAt: result.date,
        createdAt: currentStamp,
      }));
    }
    statements.push(bindings.db.prepare(`
      INSERT INTO organization_sync_receipts (
        user_id, idempotency_key, attempt_count, created_at,
        request_hash, response_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      user.id,
      idempotencyKey,
      acceptedAttempts.length,
      new Date(nowMs).toISOString(),
      requestHash,
      JSON.stringify({ ok: true, synced: acceptedAttempts.length }),
    ));
    const result = await bindings.db.batch(statements);
    if (!result.every((item) => item.success)) {
      throw new Error("Cloudflare organization attempt batch failed");
    }
  } catch (error) {
    await retireOrganizationAttemptObjects(
      bindings,
      user.id,
      uploadedObjectKeys,
      nowMs,
    ).catch(() => undefined);
    throw error;
  }

  // Rejected uploads (for example a score-only retry that must preserve an
  // existing detailed review) are not named by D1 and can be retired now.
  // Superseded/deleted pointers are captured atomically by migration 0006's
  // D1 triggers and reconciled from that durable ledger.
  const cleaned = await retireOrganizationAttemptObjects(
    bindings,
    user.id,
    uploadedObjectKeys,
    nowMs,
  );
  if (!cleaned) {
    console.error(JSON.stringify({
      message: "organization attempt object cleanup deferred",
      userId: user.id,
    }));
  }
  await reconcileOrganizationAttemptObjects(bindings, { limit: 8, nowMs })
    .catch(() => undefined);
  return true;
}

export async function cloudflareHistoryClearAllowed(
  user: SessionUser,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const { db } = bindings;
  await ensureCloudflareUser(user, bindings);
  const restricted = await db.prepare(`
    SELECT 1 AS blocked FROM organization_memberships
     WHERE user_id = ? AND role = 'student'
       AND status IN ('active', 'leave_requested', 'suspended') LIMIT 1
  `).bind(user.id).first<{ blocked: number }>();
  return !restricted;
}
