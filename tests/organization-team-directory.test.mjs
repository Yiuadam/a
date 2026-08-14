import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const portal = read("components", "organization", "OrganizationPortal.tsx");
const commands = read("lib", "organizations", "server.ts");

function viewBlock(name) {
  const marker = `{view === "${name}"`;
  const start = portal.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} manager view`);

  const next = [...portal.matchAll(/\{view === "[^"]+"/g)]
    .map((match) => match.index)
    .filter((index) => index > start)
    .sort((left, right) => left - right)[0] ?? portal.indexOf("\n}\n\nfunction", start);

  return portal.slice(start, next);
}

function commandBranch(action) {
  const marker = `if (action === "${action}"`;
  const start = commands.indexOf(marker);
  assert.notEqual(start, -1, `missing ${action} server command branch`);

  const candidates = [
    commands.indexOf("\n  if (action ===", start + marker.length),
    commands.indexOf("\n  return rpc(\"organization_command\"", start + marker.length),
  ].filter((index) => index !== -1);
  const end = candidates.length ? Math.min(...candidates) : commands.length;
  return commands.slice(start, end);
}

test("Team has a compact directory with dedicated invite, assignment and review destinations", () => {
  assert.match(portal, /type ManagerView = [^;]+"team-invite"[^;]+"team-assignment"[^;]+"team-pairings"/);
  assert.match(portal, /MANAGER_VIEWS = new Set<ManagerView>\(\[[^\]]*"team-invite"[^\]]*"team-assignment"[^\]]*"team-pairings"/);

  const directory = viewBlock("members");
  assert.match(directory, /data-team-directory/);
  assert.match(portal, /data-team-directory-card=\{destination\}/);
  for (const [kind, destination] of [
    ["invite", "team-invite"],
    ["assignment", "team-assignment"],
    ["pairings", "team-pairings"],
  ]) {
    assert.match(directory, new RegExp(`destination="${kind}"`));
    assert.match(directory, new RegExp(`onOpen=\\{\\(\\) => onOpenView\\("${destination}"\\)\\}`));
  }

  assert.doesNotMatch(directory, /<InvitationForm\b|<TeacherAssignments\b|<TeamGroups\b|<form\b/);
});

test("each Team task is a full page with a reliable return to the directory", () => {
  const invite = viewBlock("team-invite");
  const assignment = viewBlock("team-assignment");
  const pairings = viewBlock("team-pairings");

  assert.match(invite, /data-team-invite-page/);
  assert.match(invite, /<InvitationForm\b/);
  assert.match(invite, /onBack=\{\(\) => onOpenView\("members", true\)\}/);
  assert.doesNotMatch(invite, /<TeacherAssignments\b|<TeamGroups\b/);

  assert.match(assignment, /data-team-assignment-page/);
  assert.match(assignment, /<TeacherAssignments\b/);
  assert.match(assignment, /onBack=\{\(\) => onOpenView\("members", true\)\}/);
  assert.doesNotMatch(assignment, /<InvitationForm\b|<TeamGroups\b/);

  assert.match(pairings, /<TeamGroups\b/);
  assert.match(pairings, /onBack=\{\(\) => onOpenView\("members", true\)\}/);
  assert.doesNotMatch(pairings, /<InvitationForm\b|<TeacherAssignments\b/);
});

test("old invite deep links canonicalise to the dedicated invite view while Team stays selected", () => {
  const focusStart = portal.indexOf("function invitationFocusFromLocation");
  const focusEnd = portal.indexOf("function MobileManagerDashboard", focusStart);
  const legacyFocus = portal.slice(focusStart, focusEnd);
  assert.match(legacyFocus, /section === "members"[\s\S]*?params\.get\("invite"\) === "people"/);
  const canonicalStart = portal.indexOf("// Keep existing invite links working");
  const canonicalEnd = portal.indexOf("}, [invitationFocus, onOpenView, view]);", canonicalStart);
  const canonicalEffect = portal.slice(canonicalStart, canonicalEnd);
  assert.match(
    canonicalEffect,
    /view !== "members"[\s\S]*view !== "team-invite"[\s\S]*!invitationFocusFromLocation\(\)[\s\S]*onOpenView\("team-invite", true\)/,
    "the old embedded invite URL must be replaced by the dedicated destination",
  );

  const teamTabSelection = /view === "team-invite"[\s\S]{0,260}view === "team-assignment"[\s\S]{0,260}"members"/;
  assert.match(portal, teamTabSelection, "child Team pages should keep the Team tab selected");
});

test("only the manager workspace exposes Team mutation views and their server commands retain authority checks", () => {
  assert.match(
    portal,
    /\(role === "manager" \|\| role === "owner"\)[\s\S]{0,1000}<ManagerArea/,
    "students and teachers must never render the invite or teacher-assignment directory",
  );
  const teamViewSet = portal.match(/TEAM_MANAGEMENT_VIEWS = new Set<ManagerView>\(\[([^\]]+)\]\)/)?.[1] ?? "";
  for (const view of ["members", "team-invite", "team-assignment", "team-pairings"]) {
    assert.match(teamViewSet, new RegExp(`"${view}"`));
  }
  const guardStart = portal.indexOf('!TEAM_MANAGEMENT_VIEWS.has(managerView)');
  const guardEnd = portal.indexOf('}, [managerView, phase, portal]);', guardStart);
  const teamPermissionGuard = portal.slice(guardStart, guardEnd);
  assert.match(
    teamPermissionGuard,
    /canManageTeam = \(portal\.actor\.platformAdmin && Boolean\(portal\.activeOrganizationId\)\)[\s\S]*membership\?\.status === "active"[\s\S]*membership\.role === "manager"[\s\S]*membership\.role === "owner"[\s\S]*\["section", "student", "focus", "attempt", "request", "requestKind", "invite"\]/,
    "a copied Team-management URL must also resolve away for teachers and students",
  );

  const invite = viewBlock("team-invite");
  assert.match(invite, /actorRole=\{actorRole\}/);
  assert.match(invite, /platformAdmin=\{portal\.actor\.platformAdmin\}/);
  assert.match(
    portal,
    /actorRole === "owner" \|\| platformAdmin[\s\S]{0,220}\{ value: "manager", label: "Manager" \}/,
    "ordinary organisation managers can invite students/teachers but cannot grant manager access",
  );

  const inviteCommand = commandBranch("invite_member");
  const assignmentCommand = commandBranch("assign_teacher_batch");
  assert.match(inviteCommand, /p_actor: user\.id/);
  assert.match(inviteCommand, /p_platform_admin: platformAdmin/);
  assert.match(assignmentCommand, /rpc\("organization_assign_teacher_batch"/);
  assert.match(assignmentCommand, /p_actor: user\.id/);
  assert.match(assignmentCommand, /p_platform_admin: isAdminEmail\(user\.email\)/);
});
