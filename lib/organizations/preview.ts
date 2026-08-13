import type { OrganizationPortal, StudentHistory } from "./types";

/**
 * Localhost-only visual fixture. The page imports it only when Next is running
 * in development, so a production build can never expose invented learners.
 */
export function managerOrganizationPreview(): OrganizationPortal {
  const organization = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Harbour English Academy",
    slug: "harbour-english",
    status: "active" as const,
    memberCount: 18,
    studentCount: 14,
    createdAt: "2026-07-03T09:00:00.000Z",
  };

  return {
    actor: {
      signedIn: true,
      userId: "22222222-2222-4222-8222-222222222222",
      displayName: "Adam",
      email: "manager@example.com",
      tier: "pro",
      platformAdmin: false,
    },
    eligibility: { canJoin: true, canApplyToCreate: true, reason: null },
    canClearOwnHistory: true,
    activeOrganizationId: organization.id,
    memberships: [{
      id: "33333333-3333-4333-8333-333333333333",
      organization,
      role: "manager",
      status: "active",
      joinedAt: "2026-07-03T09:00:00.000Z",
      shareFutureHistory: true,
      sharePreJoinHistory: false,
      preJoinHistoryRequestStatus: null,
      futureHistoryRequestStatus: null,
      leaveRequestStatus: null,
    }],
    applications: [],
    organizations: null,
    members: [
      {
        membershipId: "40000000-0000-4000-8000-000000000001",
        userId: "50000000-0000-4000-8000-000000000001",
        displayName: "Maya Chen",
        email: "maya@example.com",
        avatarUrl: null,
        role: "teacher",
        status: "active",
        joinedAt: "2026-07-06T09:00:00.000Z",
        assignedTeacherIds: [],
      },
      {
        membershipId: "40000000-0000-4000-8000-000000000002",
        userId: "50000000-0000-4000-8000-000000000002",
        displayName: "Leo Wong",
        email: "leo@example.com",
        avatarUrl: null,
        role: "student",
        status: "active",
        joinedAt: "2026-07-12T09:00:00.000Z",
        assignedTeacherIds: ["50000000-0000-4000-8000-000000000001"],
      },
      {
        membershipId: "40000000-0000-4000-8000-000000000003",
        userId: "50000000-0000-4000-8000-000000000003",
        displayName: "Sofia Lam",
        email: "sofia@example.com",
        avatarUrl: null,
        role: "student",
        status: "active",
        joinedAt: "2026-07-18T09:00:00.000Z",
        assignedTeacherIds: ["50000000-0000-4000-8000-000000000001"],
      },
    ],
    requests: [{
      id: "60000000-0000-4000-8000-000000000001",
      organizationId: organization.id,
      kind: "join",
      status: "pending",
      requesterUserId: "70000000-0000-4000-8000-000000000001",
      requesterName: "Noah Lee",
      requesterEmail: "noah@example.com",
      targetUserId: "70000000-0000-4000-8000-000000000001",
      invitationEmail: null,
      requestedRole: null,
      requestedValue: null,
      note: "Joining the evening IELTS class.",
      createdAt: "2026-08-11T13:30:00.000Z",
      decidedAt: null,
    }],
    students: [
      {
        userId: "50000000-0000-4000-8000-000000000002",
        membershipId: "40000000-0000-4000-8000-000000000002",
        displayName: "Leo Wong",
        email: "leo@example.com",
        avatarUrl: null,
        lastActiveAt: "2026-08-12T08:20:00.000Z",
        completedAttempts: 12,
        latestBands: { listening: 7, reading: 6.5, writing: 6, speaking: 6.5 },
        archivedAt: null,
      },
      {
        userId: "50000000-0000-4000-8000-000000000003",
        membershipId: "40000000-0000-4000-8000-000000000003",
        displayName: "Sofia Lam",
        email: "sofia@example.com",
        avatarUrl: null,
        lastActiveAt: "2026-08-11T12:10:00.000Z",
        completedAttempts: 8,
        latestBands: { listening: 6.5, reading: 7, writing: 6.5, speaking: 6 },
        archivedAt: null,
      },
    ],
    assignments: [
      {
        id: "80000000-0000-4000-8000-000000000001",
        organizationId: organization.id,
        teacherUserId: "50000000-0000-4000-8000-000000000001",
        teacherName: "Maya Chen",
        studentUserId: "50000000-0000-4000-8000-000000000002",
        studentName: "Leo Wong",
        createdAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "80000000-0000-4000-8000-000000000002",
        organizationId: organization.id,
        teacherUserId: "50000000-0000-4000-8000-000000000001",
        teacherName: "Maya Chen",
        studentUserId: "50000000-0000-4000-8000-000000000003",
        studentName: "Sofia Lam",
        createdAt: "2026-07-19T09:00:00.000Z",
      },
    ],
    practiceAssignments: [
      {
        id: "81000000-0000-4000-8000-000000000001",
        organizationId: organization.id,
        assignedByUserId: "50000000-0000-4000-8000-000000000001",
        assignedByName: "Maya Chen",
        studentUserId: "50000000-0000-4000-8000-000000000002",
        studentName: "Leo Wong",
        skill: "reading",
        testId: "reading-1",
        title: "Reading · The Rise of the Lighthouse",
        href: "/practice/reading?id=reading-1",
        note: "Focus on headings: match the writer’s main idea, not repeated words.",
        dueAt: "2026-08-17T00:00:00.000Z",
        assignedAt: "2026-08-12T09:00:00.000Z",
        completedAt: null,
      },
      {
        id: "81000000-0000-4000-8000-000000000002",
        organizationId: organization.id,
        assignedByUserId: "50000000-0000-4000-8000-000000000001",
        assignedByName: "Maya Chen",
        studentUserId: "50000000-0000-4000-8000-000000000002",
        studentName: "Leo Wong",
        skill: "speaking",
        testId: "next-speaking",
        title: "Speaking · next interview",
        href: "/speaking",
        note: "Give one specific example in each longer answer.",
        dueAt: null,
        assignedAt: "2026-08-09T09:00:00.000Z",
        completedAttemptId: "a0000000-0000-4000-8000-000000000001",
        completedAt: "2026-08-12T08:20:00.000Z",
      },
    ],
    recentFeedback: [{
      id: "82000000-0000-4000-8000-000000000001",
      organizationId: organization.id,
      attemptId: "a0000000-0000-4000-8000-000000000001",
      teacherUserId: "50000000-0000-4000-8000-000000000001",
      teacherName: "Maya Chen",
      message: "Your ideas are clear. Next time, add one example before you move to the next point.",
      createdAt: "2026-08-12T09:15:00.000Z",
      updatedAt: "2026-08-12T09:15:00.000Z",
    }],
  };
}

export type OrganizationPreviewRole = "manager" | "teacher" | "student" | "former" | "admin" | "individual";

/** Development-only role views built from one internally consistent fixture. */
export function organizationRolePreview(role: OrganizationPreviewRole): OrganizationPortal {
  const source = managerOrganizationPreview();
  if (role === "manager") return source;
  if (role === "admin") {
    return {
      ...source,
      actor: { ...source.actor, platformAdmin: true, displayName: "BandUp administrator" },
      activeOrganizationId: source.memberships[0]?.organization.id ?? null,
      memberships: [],
      organizations: source.memberships[0] ? [source.memberships[0].organization] : [],
    };
  }
  if (role === "individual") {
    return {
      ...source,
      actor: { ...source.actor, displayName: "Independent learner", email: "learner@example.com", tier: "plus" },
      activeOrganizationId: null,
      memberships: [],
      organizations: null,
      members: null,
      requests: null,
      students: null,
      assignments: null,
      practiceAssignments: null,
      recentFeedback: null,
    };
  }
  if (role === "teacher") {
    const teacher = source.members?.find((member) => member.role === "teacher");
    const organization = source.memberships[0]?.organization;
    if (!teacher || !organization) return source;
    const assignedStudentIds = new Set(
      source.assignments
        ?.filter((assignment) => assignment.teacherUserId === teacher.userId)
        .map((assignment) => assignment.studentUserId),
    );
    const secondOrganization = {
      id: "11111111-1111-4111-8111-111111111112",
      name: "Bright Path College",
      slug: "bright-path-college",
      status: "active" as const,
      memberCount: 9,
      studentCount: 7,
      createdAt: "2026-07-16T09:00:00.000Z",
    };
    return {
      ...source,
      actor: { ...source.actor, userId: teacher.userId, displayName: teacher.displayName, email: teacher.email },
      activeOrganizationId: organization.id,
      memberships: [
        {
          id: teacher.membershipId,
          organization,
          role: "teacher",
          status: "active",
          joinedAt: teacher.joinedAt,
          shareFutureHistory: false,
          sharePreJoinHistory: false,
          preJoinHistoryRequestStatus: null,
          futureHistoryRequestStatus: null,
          leaveRequestStatus: null,
        },
        {
          id: "40000000-0000-4000-8000-000000000005",
          organization: secondOrganization,
          role: "teacher",
          status: "active",
          joinedAt: "2026-08-03T09:00:00.000Z",
          shareFutureHistory: false,
          sharePreJoinHistory: false,
          preJoinHistoryRequestStatus: null,
          futureHistoryRequestStatus: null,
          leaveRequestStatus: null,
        },
      ],
      applications: [],
      members: null,
      requests: null,
      students: source.students?.filter((student) => assignedStudentIds.has(student.userId)) ?? [],
      assignments: null,
      practiceAssignments: source.practiceAssignments?.filter((item) => assignedStudentIds.has(item.studentUserId)) ?? [],
      recentFeedback: source.recentFeedback,
    };
  }
  const student = source.members?.find((member) => member.role === "student");
  const organization = source.memberships[0]?.organization;
  if (!student || !organization) return source;
  const former = role === "former";
  const secondOrganization = {
    id: "11111111-1111-4111-8111-111111111112",
    name: "Bright Path College",
    slug: "bright-path-college",
    status: "active" as const,
    memberCount: 26,
    studentCount: 21,
    createdAt: "2026-07-16T09:00:00.000Z",
  };
  return {
    ...source,
    actor: { ...source.actor, userId: student.userId, displayName: student.displayName, email: student.email },
    canClearOwnHistory: former,
    activeOrganizationId: former ? null : organization.id,
    memberships: [
      {
        id: student.membershipId,
        organization,
        role: "student",
        status: former ? "removed" : "active",
        joinedAt: student.joinedAt,
        shareFutureHistory: !former,
        sharePreJoinHistory: true,
        preJoinHistoryRequestStatus: null,
        futureHistoryRequestStatus: null,
        leaveRequestStatus: former ? "approved" : null,
      },
      ...(former ? [] : [{
        id: "40000000-0000-4000-8000-000000000004",
        organization: secondOrganization,
        role: "student" as const,
        status: "active" as const,
        joinedAt: "2026-08-02T09:00:00.000Z",
        shareFutureHistory: true,
        sharePreJoinHistory: false,
        preJoinHistoryRequestStatus: null,
        futureHistoryRequestStatus: null,
        leaveRequestStatus: null,
      }]),
    ],
    applications: [],
    members: null,
    requests: null,
    students: null,
    assignments: null,
  };
}

/**
 * A matching drill-down fixture for the manager preview. Keeping this beside
 * the portal fixture prevents its learner links from falling through to the
 * protected live API during local visual review.
 */
export function managerStudentHistoryPreview(studentId: string): StudentHistory | null {
  const portal = managerOrganizationPreview();
  const student = portal.students?.find((item) => item.userId === studentId);
  const organization = portal.memberships[0]?.organization;
  if (!student || !organization) return null;

  return {
    organization,
    student,
    canArchive: true,
    canPermanentlyDelete: true,
    canProvideFeedback: true,
    attempts: [
      {
        id: "a0000000-0000-4000-8000-000000000010",
        skill: "listening",
        title: "Booking a badminton class",
        submittedAt: "2026-07-22T08:00:00.000Z",
        score: 27,
        scoreOutOf: 40,
        band: 6.5,
        feedbackSummary: "Check singular and plural endings before moving on.",
        review: null,
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000011",
        skill: "listening",
        title: "Renting an allotment plot",
        submittedAt: "2026-08-08T08:00:00.000Z",
        score: 30,
        scoreOutOf: 40,
        band: student.latestBands.listening ?? 7,
        feedbackSummary: "Stronger detail recognition in the final section.",
        review: null,
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000012",
        skill: "reading",
        title: "The rise of the lighthouse",
        submittedAt: "2026-07-20T08:00:00.000Z",
        score: 24,
        scoreOutOf: 40,
        band: 6,
        feedbackSummary: "Match headings by purpose rather than repeated words.",
        review: null,
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000013",
        skill: "reading",
        title: "Urban farming",
        submittedAt: "2026-08-09T08:00:00.000Z",
        score: 27,
        scoreOutOf: 40,
        band: student.latestBands.reading ?? 6.5,
        feedbackSummary: "Better control of True, False and Not Given questions.",
        review: null,
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000014",
        skill: "writing",
        title: "Household recycling rates",
        submittedAt: "2026-07-25T08:00:00.000Z",
        score: null,
        scoreOutOf: null,
        band: 5.5,
        feedbackSummary: "Overview present; comparisons need greater precision.",
        review: null,
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000015",
        skill: "speaking",
        title: "IELTS speaking interview",
        submittedAt: "2026-07-28T08:00:00.000Z",
        score: null,
        scoreOutOf: null,
        band: 6,
        feedbackSummary: "Clear answers; extend Part 2 with connected detail.",
        review: null,
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000001",
        skill: "speaking",
        title: "IELTS speaking interview",
        submittedAt: "2026-08-12T08:20:00.000Z",
        score: null,
        scoreOutOf: null,
        band: student.latestBands.speaking ?? 6.5,
        feedbackSummary: "Clear ideas; develop answers with more precise examples.",
        review: {
          kind: "speaking",
          transcript: [
            { role: "examiner", part: 1, text: "What do you enjoy about where you live?" },
            { role: "candidate", part: 1, text: "I enjoy the harbour because it is peaceful in the evening and easy to reach from home." },
          ],
          grade: {
            overallBand: student.latestBands.speaking ?? 6.5,
            criteria: [
              { name: "Fluency and coherence", band: 6.5, comment: "Ideas are clear, with occasional hesitation." },
              { name: "Lexical resource", band: 6.5, comment: "Appropriate everyday vocabulary with room for greater precision." },
            ],
            strengths: ["Direct response", "Natural pace"],
            improvements: ["Extend answers with one specific example", "Use a wider range of linking phrases"],
            betterAnswerExample: "I especially enjoy the harbour in the evening, when it becomes quieter and the lights reflect across the water.",
            pronunciationNote: "Word stress is generally clear; keep final consonants audible.",
          },
        },
        archivedAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000002",
        skill: "writing",
        title: "Remote working — opinion essay",
        submittedAt: "2026-08-10T11:00:00.000Z",
        score: null,
        scoreOutOf: null,
        band: student.latestBands.writing ?? 6,
        feedbackSummary: "A clear position with relevant support; paragraph development needs more depth.",
        review: {
          kind: "writing",
          attempts: [{
            task: {
              id: "preview-writing-task",
              task: 2,
              variant: "academic",
              title: "Remote working",
              prompt: "To what extent do you agree that remote working benefits both employers and employees?",
              minWords: 250,
              timeMinutes: 40,
            },
            response: "Remote working can benefit both sides because employees save commuting time and employers can recruit from a wider area.",
            grade: {
              overallBand: student.latestBands.writing ?? 6,
              criteria: [
                { name: "Task response", band: 6, comment: "The position is clear but supporting ideas need fuller development." },
                { name: "Coherence and cohesion", band: 6, comment: "The argument is logically ordered." },
              ],
              strengths: ["Clear position", "Relevant main ideas"],
              improvements: ["Add a specific example", "Develop the counterargument"],
              rewrittenExcerpt: "Remote work can benefit both parties: employees regain commuting time, while employers can recruit beyond their immediate region.",
            },
          }],
        },
        archivedAt: null,
      },
    ],
  };
}
