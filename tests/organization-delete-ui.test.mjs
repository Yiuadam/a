import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const portal = readFileSync(
  join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
  "utf8",
);

test("organisation deletion UI is limited to active management and platform administration surfaces", () => {
  assert.match(
    portal,
    /!platformAdministrationView && \(role === "manager" \|\| role === "owner"\) && \(membership\?\.status === "active" \|\| Boolean\(adminWorkspace\)\)[\s\S]*?<ManagerArea/,
  );

  const managerStart = portal.indexOf("function ManagerArea");
  const deletionStart = portal.indexOf("function OrganizationDeletionControl", managerStart);
  assert.ok(managerStart >= 0 && deletionStart > managerStart);
  const managerArea = portal.slice(managerStart, deletionStart);
  assert.match(managerArea, /actorRole: "manager" \| "owner"/);
  assert.match(
    managerArea,
    /const canDeleteOrganization = portal\.actor\.platformAdmin \|\| actorRole === "manager" \|\| actorRole === "owner"/,
  );
  assert.match(
    managerArea,
    /view === "settings"[\s\S]*?organizationId && selectedOrganization && canDeleteOrganization[\s\S]*?<OrganizationDeletionControl/,
  );

  const platformStart = portal.indexOf("function PlatformAdminArea");
  const applicationStart = portal.indexOf("function ApplicationList", platformStart);
  const platformArea = portal.slice(platformStart, applicationStart);
  assert.match(platformArea, /title="All organisations"/);
  assert.match(platformArea, /<OrganizationDeletionControl[\s\S]*?organizationId=\{organization\.id\}/);
});

test("organisation deletion requires the exact organisation name and has an animated pending state", () => {
  const deletionStart = portal.indexOf("function OrganizationDeletionControl");
  const platformCardStart = portal.indexOf("function PlatformAdminCard", deletionStart);
  assert.ok(deletionStart >= 0 && platformCardStart > deletionStart);
  const deletion = portal.slice(deletionStart, platformCardStart);

  assert.match(deletion, /data-organization-deletion-control/);
  assert.match(deletion, /const nameMatches = confirmationName === organizationName/);
  assert.match(deletion, /Type <strong>\{organizationName\}<\/strong> exactly to confirm/);
  assert.match(deletion, /if \(!nameMatches \|\| busy \|\| submitting\) return/);
  assert.match(deletion, /disabled=\{busy \|\| submitting \|\| !nameMatches\}/);
  assert.match(deletion, /disabled=\{busy \|\| submitting\}[\s\S]*?onClick=\{cancel\}/);
  assert.equal((deletion.match(/"delete_organization"/g) ?? []).length, 1);
  assert.match(
    deletion,
    /act\([\s\S]*?"delete_organization",[\s\S]*?organizationDeletionPayload\(organizationId, confirmationName\)/,
  );
  assert.match(deletion, /<LoadingIndicator label="Deleting…" announce=\{false\} \/>/);
  assert.match(deletion, /onClick=\{cancel\}/);
  assert.match(deletion, /This cannot be undone/);
  assert.match(deletion, /Learners keep their own practice history/);
  assert.match(
    deletion,
    /if \(compact && !confirming\)[\s\S]*?aria-label=\{`Delete \$\{organizationName\} organisation`\}[\s\S]*?>[\s\S]*?Delete organisation/,
  );
});

test("organisation deletion keeps its title and icon action on one row with full-width warning copy", () => {
  const deletionStart = portal.indexOf("function OrganizationDeletionControl");
  const platformCardStart = portal.indexOf("function PlatformAdminCard", deletionStart);
  assert.ok(deletionStart >= 0 && platformCardStart > deletionStart);
  const deletion = portal.slice(deletionStart, platformCardStart);

  assert.match(
    deletion,
    /data-organization-deletion-summary[\s\S]*?className="flex min-w-0 items-center justify-between gap-3"[\s\S]*?whitespace-nowrap[\s\S]*?Delete organisation[\s\S]*?className="grid size-11[\s\S]*?aria-label=\{`Delete \$\{organizationName\} organisation`\}[\s\S]*?aria-controls=\{`\$\{confirmationId\}-confirmation`\}[\s\S]*?<span aria-hidden="true">×<\/span>/,
  );
  assert.match(
    deletion,
    /<\/div>\s*<p id=\{copyId\} className="mt-1\.5 w-full[^\"]*">\s*Permanently removes this workspace/,
  );
  assert.match(deletion, /id=\{`\$\{confirmationId\}-confirmation`\}[\s\S]*?role="group" aria-describedby=\{copyId\}/);
});

test("deleting the selected organisation clears stale deep-link state before the authoritative reload", () => {
  const deleteBranchStart = portal.indexOf('action === "delete_organization"');
  const deleteBranchEnd = portal.indexOf("retryKeys.current.delete", deleteBranchStart);
  const deleteBranch = portal.slice(deleteBranchStart, deleteBranchEnd);
  assert.match(
    deleteBranch,
    /action === "delete_organization"[\s\S]*?payload\.organizationId === portalRef\.current\?\.activeOrganizationId/,
  );
  for (const parameter of ["organization", "section", "student", "focus", "attempt", "request", "requestKind", "invite"]) {
    assert.match(deleteBranch, new RegExp(`"${parameter}"`));
  }
  assert.match(
    deleteBranch,
    /action === "delete_organization"[\s\S]*?window\.history\.replaceState[\s\S]*?await load\(deletedSelectedOrganization \? null : undefined\)/,
  );
  assert.match(portal, /const selected = selectedOverride !== undefined[\s\S]*?\? selectedOverride/);
});
