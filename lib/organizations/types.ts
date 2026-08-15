import type { Tier } from "@/lib/billing/tiers";
import type { ModuleResultReview } from "@/lib/types";
import type { OrganizationAction } from "@/lib/organizations/actions";

export type { OrganizationAction } from "@/lib/organizations/actions";

/** Roles inside one organization. Platform administration is kept separate. */
export type OrganizationRole = "student" | "teacher" | "manager" | "owner";

export type MembershipStatus =
  | "invited"
  | "pending"
  | "active"
  | "leave_requested"
  | "suspended"
  | "removed";

export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string | null;
  status: "pending" | "active" | "suspended" | "closed";
  memberCount: number | null;
  studentCount: number | null;
  createdAt: string;
}

export interface OrganizationMembership {
  id: string;
  organization: OrganizationSummary;
  role: OrganizationRole;
  status: MembershipStatus;
  joinedAt: string | null;
  shareFutureHistory: boolean;
  sharePreJoinHistory: boolean;
  preJoinHistoryRequestStatus: RequestStatus | null;
  futureHistoryRequestStatus: RequestStatus | null;
  leaveRequestStatus: RequestStatus | null;
}

export interface OrganizationMember {
  membershipId: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: OrganizationRole;
  status: MembershipStatus;
  joinedAt: string | null;
  assignedTeacherIds: string[];
}

export interface StudentProgressSummary {
  userId: string;
  membershipId: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  lastActiveAt: string | null;
  completedAttempts: number;
  latestBands: Partial<Record<"listening" | "reading" | "writing" | "speaking", number>>;
  archivedAt: string | null;
}

export type OrganizationRequestKind =
  | "join"
  | "leave"
  | "history_access_change"
  | "invitation";

export interface OrganizationRequest {
  id: string;
  organizationId: string;
  kind: OrganizationRequestKind;
  status: RequestStatus;
  requesterUserId: string;
  requesterName: string | null;
  requesterEmail: string | null;
  targetUserId: string | null;
  invitationEmail: string | null;
  requestedRole: OrganizationRole | null;
  requestedValue: boolean | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface TeacherAssignment {
  id: string;
  organizationId: string;
  teacherUserId: string;
  teacherName: string | null;
  studentUserId: string;
  studentName: string | null;
  createdAt: string;
}

/** A teacher-set practice item. The title and link always come from BandUp's
 * own practice catalogue; managers cannot inject arbitrary destinations. */
export interface OrganizationPracticeAssignment {
  id: string;
  organizationId: string;
  assignedByUserId: string | null;
  assignedByName: string | null;
  studentUserId: string;
  studentName: string | null;
  skill: "listening" | "reading" | "writing" | "speaking";
  testId: string;
  title: string;
  href: string;
  note: string | null;
  dueAt: string | null;
  assignedAt: string;
  /** Exact shared sitting that first completed this assignment, when one exists. */
  completedAttemptId?: string | null;
  completedAt: string | null;
}

/** A teacher's separate note on one saved sitting. It never replaces the
 * learner's original answers or automated feedback. */
export interface OrganizationTeacherFeedback {
  id: string;
  organizationId: string;
  attemptId: string;
  teacherUserId: string | null;
  teacherName: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationActor {
  signedIn: boolean;
  userId: string | null;
  displayName: string | null;
  email: string | null;
  tier: Tier | null;
  platformAdmin: boolean;
}

export interface OrganizationEligibility {
  canJoin: boolean;
  reason: string | null;
}

/**
 * One role-filtered portal response. Sections the actor may not read are null,
 * rather than empty, so the UI cannot confuse "not permitted" with "none".
 */
export interface OrganizationPortal {
  actor: OrganizationActor;
  eligibility: OrganizationEligibility;
  canClearOwnHistory: boolean;
  activeOrganizationId: string | null;
  memberships: OrganizationMembership[];
  organizations: OrganizationSummary[] | null;
  members: OrganizationMember[] | null;
  /** Only present for someone who can manage the active organisation — never for a teacher or student. */
  joinCode: string | null;
  requests: OrganizationRequest[] | null;
  students: StudentProgressSummary[] | null;
  assignments: TeacherAssignment[] | null;
  /** Present once the organization data authority supports assigned work. */
  practiceAssignments?: OrganizationPracticeAssignment[] | null;
  recentFeedback?: OrganizationTeacherFeedback[] | null;
}

export interface OrganizationActionRequest {
  action: OrganizationAction;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface OrganizationActionResponse {
  ok: true;
  /** Older RPCs may include a snapshot; Cloudflare commands return only the durable result. */
  portal?: OrganizationPortal;
  /** Present only after creating an invitation; the token never comes back. */
  invitation?: { requestId: string };
  /** Present only after create_organization; the new organisation's id. */
  organizationId?: string;
}

export interface OrganizationUserSearchResult {
  userId: string;
  username: string;
  displayName: string | null;
}

export interface OrganizationNameSearchResult {
  organizationId: string;
  name: string;
}

export type OrganizationDiscoveryResponse =
  | { kind: "user"; results: OrganizationUserSearchResult[] }
  | { kind: "organization"; results: OrganizationNameSearchResult[] };

export interface StudentHistoryAttempt {
  id: string;
  skill: "listening" | "reading" | "writing" | "speaking" | "placement";
  title: string;
  submittedAt: string;
  score: number | null;
  scoreOutOf: number | null;
  band: number | null;
  feedbackSummary: string | null;
  /** Complete stored feedback, including essays and speaking transcripts. */
  review: ModuleResultReview | null;
  teacherFeedback?: OrganizationTeacherFeedback[];
  archivedAt: string | null;
}

export interface StudentHistory {
  organization: OrganizationSummary;
  student: StudentProgressSummary;
  canArchive: boolean;
  canPermanentlyDelete: boolean;
  canProvideFeedback?: boolean;
  attempts: StudentHistoryAttempt[];
}
