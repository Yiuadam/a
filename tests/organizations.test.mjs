import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const actions = await load("lib", "organizations", "actions.ts");
const payloads = await load("lib", "organizations", "action-payloads.ts");
const server = await load("lib", "organizations", "server.ts");
const historyPolicy = await load("lib", "organizations", "history-policy.ts");
const trends = await load("lib", "organizations", "trends.ts");
const attemptResult = await load("lib", "organizations", "attempt-result.ts");
const returnPath = await load("lib", "auth", "return-path.ts");
const previewAuth = await load("lib", "organizations", "preview-auth.ts");

test("preview practice assignments use the same live destinations as real assignments", () => {
  const previewSource = readFileSync(
    join(process.cwd(), "lib", "organizations", "preview.ts"),
    "utf8",
  );
  assert.match(previewSource, /skill: "speaking",[\s\S]*?href: "\/speaking"/);
  assert.doesNotMatch(previewSource, /href: "\/practice\/speaking"/);
});

test("organization actions are explicit and do not include a learner-owned physical delete", () => {
  assert.equal(actions.isOrganizationAction("archive_attempt"), true);
  assert.equal(actions.isOrganizationAction("remove_attempt_permanently"), true);
  assert.equal(actions.isOrganizationAction("delete_learner_attempt_source"), false);
  assert.equal(actions.isOrganizationAction("anything"), false);
});

test("former students retain a direct post-leave history-sharing control", () => {
  const commandSource = readFileSync(join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"), "utf8");
  const portalSource = readFileSync(join(process.cwd(), "lib", "cloudflare", "organizations.ts"), "utf8");
  const uiSource = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
  assert.match(commandSource, /membership\.status === "removed"/);
  assert.match(commandSource, /directAfterLeaving: true/);
  assert.match(commandSource, /removed_at = CASE WHEN \? = 1 THEN \? ELSE NULL END/);
  assert.doesNotMatch(portalSource, /m\.user_id = \? AND m\.status <> 'removed'/);
  assert.match(uiSource, /Former membership/);
  assert.match(uiSource, /This change no longer needs organisation approval/);
});

test("organization UI payloads use the identifiers consumed by the atomic command bus", () => {
  assert.deepEqual(payloads.memberActionPayload("org-1", "user-1"), {
    organizationId: "org-1",
    userId: "user-1",
  });
  assert.deepEqual(payloads.teacherAssignmentPayload("org-1", "teacher-1", "student-1"), {
    organizationId: "org-1",
    teacherUserId: "teacher-1",
    studentUserId: "student-1",
  });
  assert.deepEqual(payloads.teacherBatchAssignmentPayload("org-1", "teacher-1", ["student-1", "student-2"]), {
    organizationId: "org-1",
    teacherUserId: "teacher-1",
    studentUserIds: ["student-1", "student-2"],
  });
  assert.deepEqual(
    payloads.practiceBatchAssignmentPayload(
      "org-1",
      ["student-1", "student-2"],
      "listening",
      "listening-1",
      "  Complete before class.  ",
      "2026-08-20T09:00:00.000Z",
    ),
    {
      organizationId: "org-1",
      studentUserIds: ["student-1", "student-2"],
      skill: "listening",
      testId: "listening-1",
      note: "Complete before class.",
      dueAt: "2026-08-20T09:00:00.000Z",
    },
  );
  assert.deepEqual(payloads.attemptActionPayload("org-1", "attempt-1"), {
    organizationId: "org-1",
    attemptId: "attempt-1",
  });
  assert.deepEqual(payloads.attemptActionPayload("org-1", "attempt-1", "Duplicate sitting"), {
    organizationId: "org-1",
    attemptId: "attempt-1",
    reason: "Duplicate sitting",
  });
  assert.deepEqual(payloads.organizationActionPayload("org-1"), {
    organizationId: "org-1",
  });
  assert.equal("membershipId" in payloads.memberActionPayload("org-1", "user-1"), false);
});

test("organization dates hydrate deterministically", () => {
  const source = readFileSync(join(process.cwd(), "components", "organization", "OrganizationUI.tsx"), "utf8");
  assert.match(source, /Intl\.DateTimeFormat\("en-GB"/);
  assert.match(source, /timeZone: "UTC"/);
  assert.doesNotMatch(source, /Intl\.DateTimeFormat\(undefined/);
});

test("student score trends keep valid bands in chronological skill series", () => {
  const base = {
    title: "Sitting",
    score: null,
    scoreOutOf: null,
    feedbackSummary: null,
    review: null,
    archivedAt: null,
  };
  const series = trends.organizationBandSeries([
    { ...base, id: "reading-later", skill: "reading", band: 7, submittedAt: "2026-08-12T08:00:00.000Z" },
    { ...base, id: "reading-earlier", skill: "reading", band: 6.5, submittedAt: "2026-08-01T08:00:00.000Z" },
    { ...base, id: "placement", skill: "placement", band: 8, submittedAt: "2026-08-02T08:00:00.000Z" },
    { ...base, id: "invalid", skill: "listening", band: 99, submittedAt: "2026-08-03T08:00:00.000Z" },
  ]);
  assert.deepEqual(series.reading.map((point) => point.band), [6.5, 7]);
  assert.equal(series.listening.length, 0);
  assert.equal(Object.hasOwn(series, "placement"), false);
  assert.deepEqual(
    trends.organizationAttemptsForSkill([
      { ...base, id: "reading", skill: "reading", band: 7, submittedAt: "2026-08-12T08:00:00.000Z" },
      { ...base, id: "listening", skill: "listening", band: 7, submittedAt: "2026-08-12T08:00:00.000Z" },
    ], "reading").map((attempt) => attempt.id),
    ["reading"],
  );
});

test("organization score cards filter the sitting history", () => {
  const trendsSource = readFileSync(join(process.cwd(), "components", "organization", "StudentBandTrends.tsx"), "utf8");
  const historySource = readFileSync(join(process.cwd(), "components", "organization", "StudentHistoryPage.tsx"), "utf8");
  assert.match(trendsSource, /aria-pressed=\{selected\}/);
  assert.match(trendsSource, /Show \$\{skillLabel\} sittings/);
  assert.match(historySource, /organizationAttemptsForSkill\(history\.attempts, selectedSkill\)/);
  assert.match(historySource, /All sittings/);
  assert.match(historySource, /scrollIntoView/);
});

test("notification destinations focus the exact organization record that needs attention", () => {
  const portal = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
  const sittingPage = readFileSync(join(
    process.cwd(), "app", "organization", "students", "[id]", "sittings", "[attemptId]", "page.tsx",
  ), "utf8");
  const sitting = readFileSync(join(process.cwd(), "components", "organization", "OrganizationSittingReview.tsx"), "utf8");

  assert.match(portal, /notificationFocusFromLocation/);
  assert.match(portal, /focus === "teacher-feedback"/);
  assert.match(portal, /focus === "request" \? params\.get\("request"\) : null/);
  assert.match(portal, /selectedFromLocation[\s\S]*routeOrganizationId/);
  assert.match(portal, /data-notification-target=\{item\.attemptId === focusedAttemptId \? "teacher-feedback"/);
  assert.match(portal, /data-notification-target=\{highlighted \? "organization-request"/);
  assert.match(portal, /That request is no longer pending/);
  assert.match(portal, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(sittingPage, /query\.organization/);
  assert.match(sittingPage, /query\.focus === "assignment-completed"/);
  assert.match(sitting, /endpoint\.set\("organization", organizationId\)/);
  assert.match(sitting, /This student just completed the assigned practice/);
});

test("assigned-practice notification destinations identify and focus the exact task", () => {
  const notice = readFileSync(join(
    process.cwd(), "components", "organization", "AssignedPracticeNotice.tsx",
  ), "utf8");
  const reading = readFileSync(join(process.cwd(), "app", "practice", "reading", "page.tsx"), "utf8");
  const listening = readFileSync(join(process.cwd(), "app", "practice", "listening", "page.tsx"), "utf8");
  const writing = readFileSync(join(process.cwd(), "app", "practice", "writing", "page.tsx"), "utf8");
  const speaking = readFileSync(join(process.cwd(), "components", "speaking", "SpeakingSession.tsx"), "utf8");

  assert.match(notice, /searchParams\.get\("assignment"\)/);
  assert.match(notice, /searchParams\.get\("from"\) === "notification"/);
  assert.match(notice, /data-notification-target="assigned-practice"/);
  assert.match(notice, /data-assignment-id=\{assignmentId\}/);
  assert.match(notice, /focus\(\{ preventScroll: true \}\)/);
  assert.match(notice, /<Suspense fallback=\{null\}>/);
  for (const destination of [reading, listening, writing, speaking]) {
    assert.match(destination, /AssignedPracticeNotice/);
  }
});

test("student history selection remains scoped to the organization from a notification", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "organization", "students", "[id]", "route.ts"), "utf8");
  const bridge = readFileSync(join(process.cwd(), "lib", "organizations", "server.ts"), "utf8");
  const cloudflare = readFileSync(join(process.cwd(), "lib", "cloudflare", "organizations.ts"), "utf8");

  assert.match(route, /searchParams\.get\("organization"\)/);
  assert.match(route, /UUID\.test\(selectedOrganization\)/);
  assert.match(route, /organizationStudentHistory\(user, id, selectedOrganization, selectedAttempt\)/);
  assert.match(bridge, /cloudflareOrganizationStudentHistory\([\s\S]*organizationId/);
  assert.match(cloudflare, /\(\? IS NULL OR student\.organization_id = \?\)/);
  assert.match(cloudflare, /historyAuthorization\(bindings\.db, user\.id, studentId, platformAdmin, organizationId\)/);
});

test("members switch only between eligible organisations and manage student leave from settings", () => {
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  const cloudflare = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organizations.ts"),
    "utf8",
  );
  const bridge = readFileSync(
    join(process.cwd(), "lib", "organizations", "server.ts"),
    "utf8",
  );
  const selectedPortal = readFileSync(
    join(process.cwd(), "supabase", "migrations", "0031_member_organization_workspace_selection.sql"),
    "utf8",
  );
  const preview = readFileSync(
    join(process.cwd(), "lib", "organizations", "preview.ts"),
    "utf8",
  );
  assert.match(portal, /function OrganizationSwitcher/);
  assert.match(portal, /label="Switch organisation"/);
  assert.match(portal, /data-organization-switcher/);
  assert.match(portal, /item\.status === "active" \|\| item\.status === "leave_requested"/);
  assert.match(portal, /window\.history\.pushState/);
  for (const parameter of ["section", "student", "focus", "attempt", "request", "requestKind"]) {
    assert.match(portal, new RegExp(`\\[.*"${parameter}"`));
  }
  assert.match(portal, /Request to leave/);
  assert.match(portal, /act\("request_to_leave", \{ organizationId: membership\.organization\.id \}\)/);
  const managerSettings = portal.slice(portal.indexOf('{view === "settings"'), portal.indexOf("function invitationToken"));
  assert.doesNotMatch(managerSettings, /Join another organisation|JoinOrganizationForm/);
  assert.match(cloudflare, /eligibleMemberships\.find\(\(membership\) => membership\.organization\.id === selectedOrganizationId\)/);
  assert.match(bridge, /if \(selectedOrganizationId\)[\s\S]*organization_portal_selected[\s\S]*p_platform_admin: platformAdmin/);
  assert.match(selectedPortal, /membership\.user_id = p_actor[\s\S]*membership\.organization_id = p_organization[\s\S]*membership\.status in \('active', 'leave_requested'\)/);
  assert.match(selectedPortal, /organization_actor_is_platform_admin\(p_actor\)/);
  assert.match(selectedPortal, /revoke all on function public\.organization_portal_selected[\s\S]*from public, anon, authenticated/);
  assert.match(preview, /role === "teacher"[\s\S]*Bright Path College[\s\S]*role: "teacher"/);
  assert.match(preview, /role === "student"|const student/);
});

test("organization sittings reuse the learner result record without changing feedback", () => {
  const review = { kind: "speaking", transcript: [], grade: { overallBand: 7 } };
  const result = attemptResult.organizationAttemptResult({
    id: "attempt-1",
    skill: "speaking",
    title: "Speaking interview",
    submittedAt: "2026-08-12T08:00:00.000Z",
    score: null,
    scoreOutOf: null,
    band: 7,
    feedbackSummary: "Saved",
    review,
    archivedAt: null,
  });
  assert.equal(result.testId, "attempt-1");
  assert.equal(result.review, review);
  assert.equal(attemptResult.organizationAttemptResult({ ...result, id: "placement", skill: "placement", title: "Placement", submittedAt: result.date, score: null, scoreOutOf: null, feedbackSummary: null, review: null, archivedAt: null }), null);
});

test("the localhost manager preview keeps student drill-downs inside preview data", () => {
  const portal = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
  const page = readFileSync(join(process.cwd(), "app", "organization", "students", "[id]", "page.tsx"), "utf8");
  const history = readFileSync(join(process.cwd(), "components", "organization", "StudentHistoryPage.tsx"), "utf8");
  assert.match(portal, /previewRole=\{preview \|\| previewRole \? "manager" : null\}/);
  assert.match(page, /process\.env\.NODE_ENV === "development"/);
  assert.match(page, /managerStudentHistoryPreview\(id\)/);
  assert.match(history, /Preview only — no student record was changed/);
  assert.match(history, /StudentBandTrends/);
  assert.match(history, /Open sitting/);
});

test("localhost role previews cover every organization workspace without entering production", () => {
  const page = readFileSync(join(process.cwd(), "app", "organization", "page.tsx"), "utf8");
  const preview = readFileSync(join(process.cwd(), "lib", "organizations", "preview.ts"), "utf8");
  assert.match(page, /process\.env\.NODE_ENV === "development"/);
  for (const role of ["manager", "teacher", "student", "former", "admin", "individual"]) {
    assert.match(page, new RegExp(`"${role}"`));
  }
  assert.match(preview, /students: source\.students\?\.filter/);
  assert.match(preview, /status: former \? "removed" : "active"/);
  assert.match(preview, /platformAdmin: true/);
});

test("organization preview roles are enabled only in development or the isolated preview Worker", () => {
  const config = readFileSync(join(process.cwd(), "wrangler.preview.jsonc"), "utf8");
  const page = readFileSync(join(process.cwd(), "app", "organization", "page.tsx"), "utf8");
  const student = readFileSync(join(process.cwd(), "app", "organization", "students", "[id]", "page.tsx"), "utf8");
  assert.match(config, /"ORGANIZATION_UI_PREVIEW": "1"/);
  assert.match(page, /process\.env\.ORGANIZATION_UI_PREVIEW === "1"/);
  assert.match(page, /isolatedPreview \? "manager" : null/);
  assert.match(student, /process\.env\.ORGANIZATION_UI_PREVIEW === "1"/);
  assert.match(student, /previewRole=\{requestedRole \?\? "manager"\}/);
  const previewAuth = readFileSync(join(process.cwd(), "lib", "organizations", "preview-auth.ts"), "utf8");
  assert.match(previewAuth, /if \(process\.env\.ORGANIZATION_UI_PREVIEW !== "1"\) return false/);
  assert.match(previewAuth, /if \(!isOrganizationPreviewRequest\(req\)\) return null/);
  assert.match(previewAuth, /organization-preview\.bandup\.life/);
  assert.match(previewAuth, /x-bandup-organization-preview-role|ORGANIZATION_PREVIEW_HEADER/);
  const productionConfig = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(productionConfig, /"ORGANIZATION_UI_PREVIEW": "0"/);
  assert.doesNotMatch(productionConfig, /"ORGANIZATION_UI_PREVIEW": "1"/);
});

test("the dedicated preview host never falls through to a real account session", () => {
  const previous = process.env.ORGANIZATION_UI_PREVIEW;
  process.env.ORGANIZATION_UI_PREVIEW = "1";
  try {
    const missingRole = new Request("https://organization-preview.bandup.life/api/organization");
    const invalidRole = new Request("https://organization-preview.bandup.life/api/organization", {
      headers: { "x-bandup-organization-preview-role": "owner" },
    });
    const productionHost = new Request("https://bandup.life/api/organization", {
      headers: { "x-bandup-organization-preview-role": "admin" },
    });

    assert.equal(previewAuth.isOrganizationPreviewRequest(missingRole), true);
    assert.equal(previewAuth.organizationPreviewUser(missingRole)?.email, "manager@preview.bandup.invalid");
    assert.equal(previewAuth.isOrganizationPreviewRequest(invalidRole), true);
    assert.equal(previewAuth.organizationPreviewUser(invalidRole), null);
    assert.equal(previewAuth.isOrganizationPreviewRequest(productionHost), false);
    assert.equal(previewAuth.organizationPreviewUser(productionHost), null);
  } finally {
    if (previous === undefined) delete process.env.ORGANIZATION_UI_PREVIEW;
    else process.env.ORGANIZATION_UI_PREVIEW = previous;
  }

  const route = readFileSync(join(process.cwd(), "app/api/organization/route.ts"), "utf8");
  assert.match(route, /if \(previewRequest\) return \{ error: "preview_role" as const \}/);
  assert.match(route, /auth\.error === "preview_role"/);
  assert.match(route, /if \(previewRequest\) \{/);
});

test("the shared role preview refuses real email addresses", () => {
  assert.equal(previewAuth.organizationPreviewPayloadAllowed("invite_member", {
    email: "new.student@preview.bandup.invalid",
  }), true);
  assert.equal(previewAuth.organizationPreviewPayloadAllowed("invite_member", {
    email: "real.person@example.com",
  }), false);
  assert.equal(previewAuth.organizationPreviewPayloadAllowed("submit_application", {
    contactEmail: "real.person@example.com",
  }), false);
  assert.equal(previewAuth.organizationPreviewPayloadAllowed("assign_teacher", {}), true);
  const route = readFileSync(join(process.cwd(), "app/api/organization/route.ts"), "utf8");
  assert.match(route, /organizationPreviewPayloadAllowed/);
  assert.match(route, /This shared preview is read-only/);
});

test("isolated preview drill-downs preserve the selected actor role", () => {
  const portal = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
  const links = readFileSync(join(process.cwd(), "components", "organization", "OrganizationUI.tsx"), "utf8");
  const history = readFileSync(join(process.cwd(), "components", "organization", "StudentHistoryPage.tsx"), "utf8");
  const studentLinks = readFileSync(join(process.cwd(), "lib", "organizations", "student-links.ts"), "utf8");
  assert.match(portal, /previewRole=\{preview \|\| previewRole \? "teacher" : null\}/);
  /* The drill-down URL is now built by lib/organizations/student-links.ts, so
     the guarantee has two halves and both are worth holding: the caller still
     hands the role over, and the helper still serialises it as `preview`.
     Asserting only the first would keep passing if the helper quietly dropped
     it, which is the exact regression this test exists to catch. */
  assert.match(links, /studentHistoryHref\(id, \{ previewRole \}\)/);
  assert.match(studentLinks, /params\.set\("preview", opts\.previewRole\)/);
  assert.match(history, /destinationParams\.set\("preview", previewRoleParam\)/);
  assert.doesNotMatch(links, /preview \? "\?preview=manager"/);
});

test("teacher sitting review uses the learner saved-result renderer", () => {
  const organizationReview = readFileSync(join(process.cwd(), "components/organization/OrganizationSittingReview.tsx"), "utf8");
  const learnerReview = readFileSync(join(process.cwd(), "app/history/result/page.tsx"), "utf8");
  const shared = readFileSync(join(process.cwd(), "components/history/SavedResultView.tsx"), "utf8");
  assert.match(organizationReview, /SavedResultView/);
  assert.match(organizationReview, /organizationAttemptResult/);
  assert.match(learnerReview, /SavedResultView/);
  assert.match(shared, /Original interview transcript/);
  assert.match(shared, /Original passage/);
  assert.match(shared, /Your original answer/);
});

test("the organization workspace uses a compact dashboard shell", () => {
  const portal = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
  const main = readFileSync(join(process.cwd(), "components", "AppMain.tsx"), "utf8");
  const footer = readFileSync(join(process.cwd(), "components", "SiteFooter.tsx"), "utf8");
  assert.match(portal, /organization-dashboard/);
  assert.match(portal, /Organisation summary/);
  assert.match(portal, /md:max-h-\[26rem\] md:overflow-y-auto/);
  assert.match(portal, /Preview data/);
  assert.match(portal, /Recent activity/);
  assert.match(portal, /new Set\(\(portal\.assignments/);
  assert.match(main, /pathname\.startsWith\("\/organization"\)/);
  assert.match(footer, /pathname\.startsWith\("\/organization"\)/);
});

test("organization sections keep desktop workspace navigation and use full-page phone views", () => {
  const portal = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
  assert.match(portal, /focusedOrganizationView/);
  // Focused mobile views normally remove the organisation-name card to save
  // space. Do not remove it when it holds the only control for selecting a
  // second eligible workspace: students, teachers, managers and admins must
  // still be able to leave a focused view by switching organisation.
  assert.match(portal, /compact && !canSwitchOrganization \? "max-sm:hidden"/);
  assert.match(portal, /data-organization-switcher-persistent/);
  assert.doesNotMatch(portal, /managerWorkspace && compact \? "hidden"/);
  assert.match(portal, /function AdminWorkspaceSummary[\s\S]*OrganizationViewTabs portal=\{portal\} view=\{view\}/);
  assert.match(portal, /function AdminOrganizationSwitcher/);
  assert.match(portal, /function OrganizationSettingsButton/);
  assert.match(portal, /data-unselected=\{selectedIndex < 0/);
  assert.match(portal, /ariaLabel = "Back to organisation dashboard"/);
  assert.match(portal, /m7\.5 12 9-6\.5v13Z/);
  assert.match(portal, /aria-label="Organisation dashboard" className="grid gap-1\.5 sm:hidden"/);
  assert.match(portal, /CardIcon name=\{card\.icon\} size=\{34\}/);
});

test("invitation return paths are limited to one internal invitation route", () => {
  const valid = "/organization/invite?request=11111111-1111-4111-8111-111111111111#token=abcdefghijklmnopqrstuvwxyz";
  const accountBound = "/organization/invite?request=11111111-1111-4111-8111-111111111111";
  assert.equal(returnPath.safeAuthReturnPath(valid), true);
  assert.equal(returnPath.safeAuthReturnPath(accountBound), true);
  assert.equal(returnPath.safeAuthReturnPath(`${accountBound}#token=short`), false);
  assert.equal(returnPath.safeAuthReturnPath("//evil.example/organization/invite?request=11111111-1111-4111-8111-111111111111#token=x"), false);
  assert.equal(returnPath.safeAuthReturnPath("/account/?next=https://evil.example"), false);
});

test("invitation UI keeps the secret in the URL fragment and student history avoids destructive controls", () => {
  const portal = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const acceptance = readFileSync(
    join(process.cwd(), "components/organization/InvitationAcceptance.tsx"),
    "utf8",
  );
  const history = readFileSync(
    join(process.cwd(), "components/organization/StudentHistoryPage.tsx"),
    "utf8",
  );
  assert.match(portal, /\/organization\/invite\?request=.*#token=/);
  assert.match(acceptance, /window\.location\.hash/);
  assert.match(acceptance, /token\.length === 0 \|\| token\.length >= 24/);
  assert.match(acceptance, /\.\.\.\(token \? \{ token \} : \{\}\)/);
  assert.match(acceptance, /action: "accept_invitation"/);
  assert.doesNotMatch(history, /Remove from organization/);
  assert.doesNotMatch(history, />\s*Archive\s*</);
  assert.doesNotMatch(history, /remove_attempt_permanently/);
  assert.doesNotMatch(history, /archive_attempt/);
  assert.match(history, /buildReview\(review\.questions, review\.answers\)/);
  assert.match(history, /Student:/);
  assert.match(history, /Answer:/);
});

test("manager UI wires assign, unassign and member commands through exact payload builders", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  assert.match(ui, /"assign_teacher_batch", teacherBatchAssignmentPayload/);
  assert.match(ui, /"assign_practice_batch", practiceBatchAssignmentPayload/);
  assert.match(ui, /multiselectable/);
  assert.match(ui, /FloatingGlassPopover/);
  assert.doesNotMatch(ui, /<select/);
  assert.match(ui, /MemberRolePicker/);
  assert.match(ui, /"unassign_teacher",\s*teacherAssignmentPayload\(/);
  assert.match(ui, /"remove_member", memberActionPayload\(organizationId, member\.userId\)/);
  assert.doesNotMatch(ui, /\{ membershipId: member\.membershipId \}/);
});

test("manager pages separate practice work from teacher-student team grouping", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const overviewStart = ui.indexOf('{view === "overview"');
  const requestsStart = ui.indexOf('{view === "requests"', overviewStart);
  const overview = ui.slice(overviewStart, requestsStart);
  const assignmentsStart = ui.indexOf('{view === "assignments"');
  const studentsStart = ui.indexOf('{view === "students"', assignmentsStart);
  const assignments = ui.slice(assignmentsStart, studentsStart);
  const teamStart = ui.indexOf('{view === "members"');
  const inviteStart = ui.indexOf('{view === "team-invite"', teamStart);
  const teamAssignmentStart = ui.indexOf('{view === "team-assignment"', inviteStart);
  const pairingsStart = ui.indexOf('{view === "team-pairings"', teamAssignmentStart);
  const settingsStart = ui.indexOf('{view === "settings"', teamStart);
  const team = ui.slice(teamStart, inviteStart);
  const invite = ui.slice(inviteStart, teamAssignmentStart);
  const teamAssignment = ui.slice(teamAssignmentStart, pairingsStart);
  const pairings = ui.slice(pairingsStart, settingsStart);

  assert.match(overview, /title="Practice assignments"/);
  assert.doesNotMatch(overview, /<TeacherAssignments/);
  assert.match(overview, /onOpenStudent=\{\(studentId\) => onOpenAssignmentDirectory\(studentId\)\}/);
  assert.match(assignments, /<PracticeAssignmentForm/);
  assert.match(assignments, /<AssignmentDirectoryCard/);
  assert.match(assignments, /view === "assignment-directory"/);
  assert.match(assignments, /<AssignmentDirectory/);
  assert.match(team, /data-team-directory/);
  assert.match(team, /destination="invite"/);
  assert.match(team, /destination="assignment"/);
  assert.match(team, /destination="pairings"/);
  assert.match(team, /onOpen=\{\(\) => onOpenView\("team-invite"\)\}/);
  assert.match(team, /onOpen=\{\(\) => onOpenView\("team-assignment"\)\}/);
  assert.match(team, /onOpen=\{\(\) => onOpenView\("team-pairings"\)\}/);
  assert.doesNotMatch(team, /<InvitationForm/);
  assert.doesNotMatch(team, /<TeacherAssignments/);
  assert.doesNotMatch(team, /<TeamGroups/);
  assert.match(invite, /data-team-invite-page/);
  assert.match(invite, /<InvitationForm/);
  assert.match(invite, /onBack=\{\(\) => onOpenView\("members", true\)\}/);
  assert.match(teamAssignment, /data-team-assignment-page/);
  assert.match(teamAssignment, /<TeacherAssignments/);
  assert.match(teamAssignment, /onBack=\{\(\) => onOpenView\("members", true\)\}/);
  assert.match(pairings, /title="Team pairings"/);
  assert.match(pairings, /onBack=\{\(\) => onOpenView\("members", true\)\}/);
  assert.match(pairings, /<TeamGroups/);
  assert.match(ui, /type ManagerView = [^;]+"team-invite"/);
  assert.match(ui, /type ManagerView = [^;]+"team-assignment"/);
  assert.match(ui, /type ManagerView = [^;]+"team-pairings"/);
  assert.match(ui, /section", nextView/);
  assert.match(ui, /organization-view-tabs premade-glass/);
  assert.match(ui, /<RefractiveGlassLayer radius=\{18\} interactive/);
});

test("practice assignment controls share one standard height", () => {
  const select = readFileSync(
    join(process.cwd(), "components/GlassSelect.tsx"),
    "utf8",
  );
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  assert.match(select, /compact \? "min-h-8 px-2\.5 text-xs" : "min-h-11 px-3 text-sm"/);
  assert.match(ui, /className="input h-11 min-h-11 w-full rounded-xl/);
  assert.match(ui, /className="btn-primary mt-\[1\.375rem\] h-11 min-h-11 w-full whitespace-nowrap/);
});

test("practice assignments use responsive master-detail records with exact completed sitting links", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const page = readFileSync(join(process.cwd(), "app/organization/page.tsx"), "utf8");
  assert.match(ui, /grid min-w-0 grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\] gap-2 overflow-hidden/);
  assert.match(ui, /function AssignmentDesktopWorkspace/);
  assert.match(ui, /role="listbox" aria-label="Student assignment records"/);
  assert.match(ui, /className="sm:hidden"/);
  assert.match(ui, /PracticeAssignmentSummary/);
  assert.match(ui, /aria-label="Student practice progress"/);
  assert.match(ui, /role="progressbar"/);
  assert.match(ui, /onClick=\{\(\) => onOpenStudent\(item\.studentId\)\}/);
  assert.doesNotMatch(ui, /PracticeAssignmentList/);
  assert.match(ui, /\? "Select students"/);
  assert.match(ui, /\? `Assign \(\$\{studentUserIds\.length\}\)` : "Assign"/);
  assert.match(ui, /Student assignments/);
  assert.match(ui, /selected\.assignments\.map/);
  assert.match(ui, /completedAttemptId && organizationId/);
  /* Same split as the preview-role test above: the caller passes `from`, and
     student-links.ts is what turns it into a query parameter. Both halves are
     asserted so neither can drop it alone. */
  assert.match(ui, /from: "assignment-directory"/);
  assert.match(
    readFileSync(join(process.cwd(), "lib", "organizations", "student-links.ts"), "utf8"),
    /params\.set\("from", opts\.from\)/,
  );
  assert.match(ui, /section", "assignment-directory"/);
  assert.match(ui, /url\.searchParams\.set\("student", selected\)/);
  assert.match(ui, /btn-secondary !hidden[\s\S]*sm:!inline-flex/);
  assert.match(page, /routeAssignmentStudentId/);

  const desktopStart = ui.indexOf("function AssignmentDesktopWorkspace");
  const directoryStart = ui.indexOf("function AssignmentDirectory", desktopStart);
  const desktop = ui.slice(desktopStart, directoryStart);
  assert.match(desktop, /Assignment progress/);
  assert.match(desktop, /\{selectedTodo\.length\} to do · \{selectedDone\.length\} done/);
  assert.equal((desktop.match(/<Person /g) ?? []).length, 1);
});

test("team assignment composer and pairing review keep atomic actions in responsive views", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const composerStart = ui.indexOf("function TeacherAssignments");
  const composerEnd = ui.indexOf("function Chevron", composerStart);
  const composer = ui.slice(composerStart, composerEnd);
  const cardStart = ui.indexOf("function TeamDirectoryCard");
  const groupsStart = ui.indexOf("function TeamGroups", cardStart);
  const card = ui.slice(cardStart, groupsStart);
  const groupsEnd = ui.indexOf("function InvitationForm", groupsStart);
  const groups = ui.slice(groupsStart, groupsEnd);

  assert.match(composer, /"assign_teacher_batch", teacherBatchAssignmentPayload/);
  assert.match(composer, /\? "Select students" : `\$\{selectedStudents\.length\} selected`/);
  assert.match(composer, /className="btn-primary col-span-2 min-h-11/);
  assert.doesNotMatch(composer, /showList/);
  assert.match(card, /data-team-directory-card=\{destination\}/);
  assert.match(card, /organization-team-directory-card liquid-glass/);
  assert.match(card, /title: string/);
  assert.match(groups, /"unassign_teacher", teacherAssignmentPayload\(organizationId, teacher\.userId, student\.userId\)/);
  assert.match(groups, /const \[pendingUnassign, setPendingUnassign\] = useState<string \| null>\(null\)/);
  assert.match(groups, /window\.setTimeout\(\(\) => setPendingUnassign\(null\), 6_000\)/);
  assert.match(groups, /pendingUnassign !== pairingKey/);
  assert.match(groups, /aria-label="Cancel unassign"/);
  assert.match(groups, /"Confirm unassign" : "Unassign"/);
  assert.match(groups, /<span role="status"[^>]*>Confirm\?<\/span>/);
  assert.match(groups, /organization-team-unassign/);
  assert.doesNotMatch(groups, />\s*Unassign\s*</);
  assert.doesNotMatch(groups, /window\.confirm/);
  assert.match(groups, /<MemberManagement member=\{student\}/);
});

test("manager invitations have a dedicated page and canonicalise the legacy deep link", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const managerStart = ui.indexOf("function ManagerArea");
  const invitationStart = ui.indexOf("function InvitationForm", managerStart);
  const usernameStart = ui.indexOf("function UsernameInvitationForm", invitationStart);
  const manager = ui.slice(managerStart, invitationStart);
  const invitation = ui.slice(invitationStart, usernameStart);

  assert.match(manager, /Invite students or teachers/);
  assert.match(manager, /onOpenView\("team-invite"\)/);
  assert.match(manager, /onOpenView\("team-invite", true\)/);
  assert.match(manager, /data-team-invite-page/);
  assert.match(manager, /aria-labelledby="organisation-invite-people"/);
  assert.match(manager, /<h3 id="organisation-invite-people"[^>]*>Invite people<\/h3>/);
  assert.doesNotMatch(manager, /<summary[^>]*>Invite a team member<\/summary>/);
  assert.match(manager, /invitationPanelRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(ui, /section === "members" \|\| section === "team-invite"/);

  const selector = invitation.indexOf("Invitation role");
  const usernameForm = invitation.indexOf("<UsernameInvitationForm");
  assert.ok(selector >= 0 && selector < usernameForm, "role choice must appear before username search");
  assert.match(invitation, /\{ value: "student", label: "Student" \}/);
  assert.match(invitation, /\{ value: "teacher", label: "Teacher" \}/);
  assert.match(invitation, /actorRole === "owner" \|\| platformAdmin/);
  assert.match(invitation, /key=\{role\}/);
  assert.equal((invitation.match(/label="Invitation role"/g) ?? []).length, 1);
  assert.match(ui, /for \(const parameter of \["focus", "attempt", "request", "requestKind", "invite"\]\) \{/);
  assert.match(ui, /"requestKind", "invite"/);
});

test("team directory routes clear stale targets and keep team management manager-only", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );

  assert.match(ui, /const TEAM_MANAGEMENT_VIEWS = new Set<ManagerView>\(\["members", "team-invite", "team-assignment", "team-pairings"\]\)/);
  assert.match(ui, /portal\.actor\.platformAdmin && Boolean\(portal\.activeOrganizationId\)/);
  assert.match(ui, /membership\?\.status === "active"[\s\S]*membership\.role === "manager" \|\| membership\.role === "owner"/);
  assert.match(ui, /if \(canManageTeam\) return;[\s\S]*url\.searchParams\.delete\(parameter\);/);
  assert.match(ui, /TEAM_MANAGEMENT_VIEWS\.has\(managerView\) && !canManageTeam[\s\S]*\? "overview"/);
  assert.match(ui, /requestAnimationFrame\(\(\) => \{[\s\S]*setManagerView\("overview"\);[\s\S]*setAssignmentStudentId\(null\);[\s\S]*setNotificationFocus\(\{ kind: null, id: null \}\);/);
  assert.match(ui, /if \(nextView !== "assignment-directory"\) url\.searchParams\.delete\("student"\);/);
  assert.match(ui, /for \(const parameter of \["focus", "attempt", "request", "requestKind", "invite"\]\) \{[\s\S]*url\.searchParams\.delete\(parameter\);/);
  assert.match(ui, /const section = params\.get\("section"\);[\s\S]*section === "members" \|\| section === "team-invite"/);
  assert.match(ui, /onOpenView\("team-invite", true\)/);
});

test("team pairing review removes the redundant outer glass and compacts phone rows", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const pairingsStart = ui.indexOf('{view === "team-pairings"');
  const settingsStart = ui.indexOf('{view === "settings"', pairingsStart);
  const pairings = ui.slice(pairingsStart, settingsStart);

  assert.match(pairings, /className="organization-team-pairings-page/);
  assert.match(pairings, /searchPlaceholder="Search team"/);
  assert.match(ui, /organization-team-pairing-group card/);
  assert.match(ui, /organization-team-pairing-member/);
  assert.match(ui, /organization-team-pairing-manage/);
  assert.match(ui, /sm:max-h-80 sm:overflow-y-auto/);
  assert.match(css, /\.organization-team-pairings-page\.card\.card \{[\s\S]*border-color: transparent;[\s\S]*padding: 0 !important;[\s\S]*backdrop-filter: none;/);
  assert.match(css, /\.organization-team-pairing-group\.card\.card \{[\s\S]*padding: 0\.75rem !important;/);
  assert.match(css, /@media \(max-width: 39\.999rem\)[\s\S]*\.organization-team-pairing-identity > div > img/);
});

test("dark organization warning pills use a neutral high-contrast capsule", () => {
  const ui = readFileSync(
    join(process.cwd(), "components/organization/OrganizationUI.tsx"),
    "utf8",
  );
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  assert.match(ui, /data-tone=\{tone\}/);
  assert.match(ui, /organization-status-pill/);
  assert.match(css, /html\[data-theme="dark"\] \.organization-status-pill\[data-tone="warn"\]/);
  assert.match(css, /background: #d1d5db/);
  assert.match(css, /color: #111113/);
});

test("organization applicants can withdraw a pending application from the UI", () => {
  const ui = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  assert.match(ui, /<ApplicationList applications=\{portal\.applications\} act=\{act\} busy=\{busy\}/);
  assert.match(ui, /"withdraw_application", \{ applicationId: application\.id \}/);
  assert.match(ui, /Withdraw application/);
});

test("organization attempt normalization retains detailed reviews but refuses malformed rows", () => {
  const valid = {
    module: "writing",
    testId: "writing-1",
    testTitle: "Task 2",
    band: 6.5,
    date: "2026-08-12T01:00:00.000Z",
    review: {
      kind: "writing",
      attempts: [{ response: "The original essay", grade: { overallBand: 6.5 } }],
    },
  };
  const normalized = server.organizationAttempts([
    valid,
    { ...valid, band: 99 },
    { ...valid, module: "admin" },
    { ...valid, date: "not a date" },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].review.attempts[0].response, "The original essay");
});

test("Cloudflare membership summaries expose the organization id, not the membership id", () => {
  const source = readFileSync(
    join(process.cwd(), "lib/cloudflare/organizations.ts"),
    "utf8",
  );
  assert.match(source, /"organization_id" in row/);
  assert.match(source, /id: row\.organization_id/);
  assert.doesNotMatch(source, /organization\.id \?\? membership\.organization_id/);
});

test("portal and command eligibility require the same currently valid organisation seat", () => {
  const portal = readFileSync(join(process.cwd(), "lib", "cloudflare", "organizations.ts"), "utf8");
  const commands = readFileSync(join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"), "utf8");
  for (const source of [portal, commands]) {
    assert.match(source, /JOIN organization_seat_pools pool/);
    assert.match(source, /allocation\.starts_at <= \?/);
    assert.match(source, /pool\.status = 'active'/);
    assert.match(source, /pool\.starts_at IS NULL OR pool\.starts_at <= \?/);
    assert.match(source, /pool\.ends_at IS NULL OR pool\.ends_at > \?/);
  }
});

test("organization endpoints are private, bounded, idempotent and database-authorized", () => {
  const portal = readFileSync(join(process.cwd(), "app/api/organization/route.ts"), "utf8");
  const history = readFileSync(
    join(process.cwd(), "app/api/organization/students/[id]/route.ts"),
    "utf8",
  );
  const bridge = readFileSync(join(process.cwd(), "lib/organizations/server.ts"), "utf8");
  assert.match(portal, /MAX_COMMAND_BYTES/);
  assert.match(portal, /idempotencyKey/);
  assert.match(portal, /private, no-store/);
  assert.match(history, /organizationStudentHistory/);
  assert.match(history, /Not found/);
  assert.match(bridge, /organization_command/);
  assert.match(bridge, /organization_assign_teacher_batch/);
  assert.match(bridge, /organization_portal_selected/);
  assert.match(bridge, /organization_consent_command/);
  assert.match(bridge, /p_idempotency_key: idempotencyKey/);
  assert.match(bridge, /p_actor/);
  assert.match(bridge, /p_platform_admin/);
});

test("organization applications do not collect or display a free-text purpose", () => {
  const forms = readFileSync(
    join(process.cwd(), "components/organization/OrganizationForms.tsx"),
    "utf8",
  );
  const portal = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );
  const commands = readFileSync(
    join(process.cwd(), "lib/cloudflare/organization-commands.ts"),
    "utf8",
  );
  const bridge = readFileSync(
    join(process.cwd(), "lib/organizations/server.ts"),
    "utf8",
  );
  const types = readFileSync(
    join(process.cwd(), "lib/organizations/types.ts"),
    "utf8",
  );
  const compatibilityMigration = readFileSync(
    join(process.cwd(), "supabase/migrations/0023_organization_application_without_purpose.sql"),
    "utf8",
  );

  assert.doesNotMatch(forms, /label="Purpose"|form\.purpose|payload\.purpose/);
  assert.doesNotMatch(portal, /application\.purpose/);
  assert.doesNotMatch(types, /interface OrganizationApplication[\s\S]{0,300}\n\s+purpose:/);
  assert.doesNotMatch(commands, /text\(payload\.purpose/);
  assert.match(commands, /APPLICATION_PURPOSE = "Organization workspace request\."/);
  assert.match(bridge, /action === "submit_application"[\s\S]*purpose: APPLICATION_PURPOSE/);
  assert.match(compatibilityMigration, /organization_applications_neutral_purpose/);
});

test("creating an organization stays behind a compact optional card", () => {
  const forms = readFileSync(
    join(process.cwd(), "components/organization/OrganizationForms.tsx"),
    "utf8",
  );
  const portal = readFileSync(
    join(process.cwd(), "components/organization/OrganizationPortal.tsx"),
    "utf8",
  );

  assert.match(forms, /<details[\s\S]*data-organization-application/);
  assert.match(forms, /<summary[\s\S]*Create an organisation[\s\S]*For people who run a school or teaching team\./);
  assert.match(forms, /group-open:rotate-90/);
  // The grid now stretches (the CSS grid default) instead of items-start, so
  // the create card can match the join card's height; this still asserts
  // the same two-up grid layout, just without the alignment override.
  assert.match(portal, /grid gap-4 lg:grid-cols-2/);
  assert.match(portal, /const hasOpenApplication = portal\.applications\?\.some/);
  assert.match(portal, /portal\.eligibility\.canApplyToCreate && !hasOpenApplication && \([\s\S]*<OrganizationApplicationForm/);
  assert.doesNotMatch(portal, /Applications are not available for this account\./);
});

test("authenticated organization APIs cannot inherit public document caching", () => {
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(config, /api\(\?:\/\|\$\)/);
  const files = [
    "app/api/organization/route.ts",
    "app/api/organization/history-policy/route.ts",
    "app/api/organization/students/[id]/route.ts",
  ];
  for (const file of files) {
    assert.match(
      readFileSync(join(process.cwd(), file), "utf8"),
      /private, no-store, max-age=0/,
    );
  }
});

test("student join keeps sharing settings out of the request form while invitations require consent", () => {
  const forms = readFileSync(join(process.cwd(), "components/organization/OrganizationForms.tsx"), "utf8");
  const invite = readFileSync(join(process.cwd(), "components/organization/InvitationAcceptance.tsx"), "utf8");
  const portal = readFileSync(join(process.cwd(), "components/organization/OrganizationPortal.tsx"), "utf8");
  assert.match(forms, /shareFutureHistoryConsent: true/);
  assert.doesNotMatch(forms, /type="checkbox"/);
  assert.match(portal, /Privacy settings/);
  assert.match(invite, /shareFutureHistoryConsent: consent/);
  assert.match(invite, /disabled=\{busy \|\| !consent\}/);
});

test("inviting a member never mutates an existing membership before acceptance", () => {
  const commands = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"),
    "utf8",
  );
  const invitationStart = commands.indexOf('if (action === "invite_member")');
  const acceptanceStart = commands.indexOf('if (action === "accept_invitation")');
  assert.ok(invitationStart >= 0 && acceptanceStart > invitationStart);
  const invitation = commands.slice(invitationStart, acceptanceStart);
  assert.match(invitation, /existing\.status !== "removed"/);
  assert.match(invitation, /already has a membership/);
  assert.doesNotMatch(invitation, /UPDATE organization_memberships/);
  assert.doesNotMatch(invitation, /INSERT INTO organization_memberships/);
});

test("accepting one invitation cannot let an older token rewrite the live role", () => {
  const commands = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"),
    "utf8",
  );
  const acceptanceStart = commands.indexOf('if (action === "accept_invitation")');
  const assignmentStart = commands.indexOf('if (action === "assign_teacher"', acceptanceStart);
  const acceptance = commands.slice(acceptanceStart, assignmentStart);
  assert.match(acceptance, /existing\.status !== "removed"/);
  assert.match(acceptance, /already have an active membership/);
  assert.match(acceptance, /status = 'cancelled'/);
  assert.match(acceptance, /id <> \?/);
});

test("role changes and restores cannot bypass learner consent", () => {
  const commands = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"),
    "utf8",
  );
  assert.match(commands, /Invite this person as a student so they can accept history sharing first/);
  assert.match(commands, /target\.status !== "suspended"/);
  assert.match(commands, /former member must accept a new invitation/i);
  assert.match(commands, /change_member_role" && requestedRole !== target\.role/);
});

test("active learners can request future-history changes and assigned teachers can decide them", () => {
  const commands = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"),
    "utf8",
  );
  const organizations = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organizations.ts"),
    "utf8",
  );
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  assert.match(commands, /historyScope === "future"/);
  assert.match(commands, /share_future_history = \?/);
  assert.match(organizations, /active\.role === "teacher" \? requestsFor/);
  assert.match(organizations, /a\.teacher_user_id = \?/);
  assert.match(portal, /Request to stop/);
  assert.match(portal, /Sharing requests/);
});

test("student privacy settings show membership-scoped current and pending sharing states", () => {
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  assert.match(portal, /These choices apply only to \{membership\.organization\.name\}/);
  assert.match(portal, /membership\.shareFutureHistory/);
  assert.match(portal, /membership\.sharePreJoinHistory/);
  assert.match(portal, /membership\.futureHistoryRequestStatus === "pending"/);
  assert.match(portal, /membership\.preJoinHistoryRequestStatus === "pending"/);
  assert.match(portal, /Current access stays unchanged until approval/);
  assert.match(portal, /Request to stop/);
  assert.match(portal, /Request to share/);
  assert.match(portal, /const studentView = visibleManagerView === "settings" \? "settings" : "overview"/);
  assert.match(portal, /studentView === "settings" \? \(/);
  assert.match(portal, /membership\.role === "student" && membership\.status === "active"/);
  assert.match(portal, /aria-label="Open organisation settings"/);
  const studentDashboard = portal.slice(portal.indexOf("function StudentArea"), portal.indexOf("function StudentOrganizationSettings"));
  assert.doesNotMatch(studentDashboard, /Privacy settings|shareFutureHistory|sharePreJoinHistory/);
});

test("the organization settings gear is geometrically centered", () => {
  const icons = readFileSync(join(process.cwd(), "components", "CardIcon.tsx"), "utf8");
  const gear = icons.slice(icons.indexOf("gear:"), icons.indexOf("practice:"));
  assert.match(gear, /<circle cx="12" cy="12" r="3" \/>/);
  assert.match(gear, /M12\.22 2h-\.44/);
  assert.doesNotMatch(gear, /<circle cx="(?!12)|<circle cx="12" cy="(?!12)/);
});

test("organization discovery is privacy bounded and supports username invitations", () => {
  const readSource = (file) => readFileSync(join(process.cwd(), file), "utf8");
  const searchRoute = readSource("app/api/organization/search/route.ts");
  const discovery = readSource("lib/cloudflare/organization-discovery.ts");
  const commands = readSource("lib/cloudflare/organization-commands.ts");
  const forms = readSource("components/organization/OrganizationForms.tsx");
  const portal = readSource("components/organization/OrganizationPortal.tsx");
  const migration = readSource("supabase/migrations/0022_organization_discovery.sql");

  assert.match(searchRoute, /Cache-Control.*private, no-store/);
  assert.match(discovery, /n\.username = \? COLLATE NOCASE/);
  assert.doesNotMatch(discovery, /SELECT[^;]*u\.email/is);
  assert.match(discovery, /role !== "teacher"/);
  assert.match(discovery, /m\.status <> 'removed'/);
  assert.match(commands, /Teachers can invite students only/);
  assert.match(commands, /typeof payload\.userId === "string"/);
  assert.match(forms, /Search for your school or learning organisation/);
  assert.match(forms, /organizationId: organization\.organizationId/);
  assert.match(portal, /Search their exact BandUp username/);
  assert.match(portal, /userId: result\.userId/);
  assert.match(migration, /revoke all on function public\.organization_discovery/);
  assert.match(migration, /grant execute on function public\.organization_invite_account[\s\S]*to service_role/);
});

test("Cloudflare commands report committed success without requiring a portal refresh", () => {
  const commands = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "organization-commands.ts"),
    "utf8",
  );
  const commandStart = commands.indexOf("export async function cloudflareOrganizationCommand");
  const command = commands.slice(commandStart);
  assert.doesNotMatch(command, /cloudflareOrganizationPortal/);
  assert.match(command, /return \{ ok: true, \.\.\.result \}/);

  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  assert.match(portal, /retryKeys = useRef/);
  assert.match(portal, /response\.status < 500/);
  assert.match(portal, /await load\(\)/);
});

test("organization students cannot erase stored history through a progress snapshot", () => {
  const stored = {
    results: [
      {
        module: "reading",
        testId: "reading-1",
        testTitle: "The lighthouse",
        band: 7,
        date: "2026-08-10T09:00:00.000Z",
      },
    ],
    targetBand: 7,
  };
  const incoming = {
    results: [],
    mockReports: [],
    historyClearedAt: "2026-08-12T09:00:00.000Z",
    targetBand: 8,
  };
  const protectedProfile = historyPolicy.preserveOrganizationStudentHistory(
    incoming,
    stored,
    Date.parse("2026-08-12T09:00:00.000Z"),
    Date.parse("2026-08-10T09:00:00.000Z"),
  );

  assert.equal(protectedProfile.results.length, 1);
  assert.equal(protectedProfile.results[0].testId, "reading-1");
  assert.equal(protectedProfile.historyClearedAt, undefined);
  assert.equal(protectedProfile.targetBand, 8);

  const restoredTab = historyPolicy.restoreAcceptedOrganizationHistory(
    incoming,
    protectedProfile,
  );
  assert.equal(restoredTab.results.length, 1);
  assert.equal(restoredTab.historyClearedAt, undefined);
  assert.equal(restoredTab.targetBand, 8);
});

test("both history clear controls require positive organization-policy permission", () => {
  const historyButton = readFileSync(
    join(process.cwd(), "components/history/ClearHistoryButton.tsx"),
    "utf8",
  );
  const deviceButton = readFileSync(
    join(process.cwd(), "components/account/ClearDeviceSection.tsx"),
    "utf8",
  );
  const progressRoute = readFileSync(
    join(process.cwd(), "app/api/account/progress/route.ts"),
    "utf8",
  );
  assert.match(historyButton, /access !== "allowed"/);
  assert.match(deviceButton, /access !== "allowed"/);
  assert.match(progressRoute, /organizationHistoryClearPolicy/);
  assert.match(progressRoute, /mergeProgressSnapshotPayload/);
  assert.match(
    readFileSync(join(process.cwd(), "lib/progress/server-snapshots.ts"), "utf8"),
    /preserveOrganizationStudentHistory/,
  );
});

test("progress remains primary and organization copying runs only after it succeeds", () => {
  const progress = readFileSync(join(process.cwd(), "app/api/account/progress/route.ts"), "utf8");
  const primary = progress.indexOf("const written = acceptedSnapshots.length");
  const copy = progress.indexOf("const attempts = organizationAttempts", primary);
  const outbox = progress.indexOf("enqueueCloudflareOrganizationAttemptSync", copy);
  const afterCall = progress.indexOf("after(async", copy);
  assert.ok(primary >= 0 && copy > primary && outbox > copy && afterCall > outbox);
  assert.match(progress, /organization attempt sync failed after primary snapshot write/);
});
