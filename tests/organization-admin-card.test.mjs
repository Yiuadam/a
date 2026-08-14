import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const portal = readFileSync(
  join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
  "utf8",
);

test("BandUp administration surfaces have one platform-admin-only render gate", () => {
  assert.equal(
    (portal.match(/<PlatformAdminArea\b/g) ?? []).length,
    1,
    "the administration page must have a single, auditable render path",
  );
  assert.equal(
    (portal.match(/<PlatformAdminCard\b/g) ?? []).length,
    1,
    "the administration entry card must have a single, auditable render path",
  );
  assert.match(
    portal,
    /\{portal\.actor\.platformAdmin && \([\s\S]*?platformAdministrationView \? \([\s\S]*?<PlatformAdminArea[\s\S]*?visibleManagerView === "overview" \? \([\s\S]*?<PlatformAdminCard[\s\S]*?: null[\s\S]*?\)\}/,
  );
});

test("the administration overview card opens its dedicated query-backed page", () => {
  assert.match(portal, /type ManagerView = [^;]*\| "administration";/);
  assert.match(portal, /const platformAdministrationView = portal\.actor\.platformAdmin && managerView === "administration"/);

  const cardStart = portal.indexOf("function PlatformAdminCard");
  const areaStart = portal.indexOf("function PlatformAdminArea", cardStart);
  assert.ok(cardStart >= 0 && areaStart > cardStart, "platform administration card must exist");

  const card = portal.slice(cardStart, areaStart);
  assert.match(card, /<button[\s\S]*?type="button"[\s\S]*?data-platform-admin-card/);
  assert.match(card, /aria-label="Open BandUp administration"/);
  assert.match(card, /onClick=\{onOpen\}/);
  assert.match(card, />BandUp administration<\/strong>/);
  assert.match(
    portal,
    /<PlatformAdminCard portal=\{portal\} onOpen=\{\(\) => openManagerView\("administration"\)\} \/>/,
  );
});

test("the dedicated administration page has a labelled heading and Back control", () => {
  const areaStart = portal.indexOf("function PlatformAdminArea");
  const nextComponent = portal.indexOf("function ApplicationList", areaStart);
  assert.ok(areaStart >= 0 && nextComponent > areaStart, "platform administration page must exist");

  const area = portal.slice(areaStart, nextComponent);
  assert.match(area, /<section[^>]*aria-labelledby="bandup-administration-title"[^>]*data-platform-administration-page/);
  assert.match(area, /<h2 id="bandup-administration-title"[^>]*>BandUp administration<\/h2>/);
  assert.match(area, /<MobileDashboardBack onBack=\{onBack\} ariaLabel="Back to organisation overview" \/>/);
  assert.match(area, /title="Organisation applications"/);
  assert.match(area, /title="All organisations"/);
});

test("a non-admin administration URL is normalised to the organisation overview", () => {
  assert.match(
    portal,
    /if \(phase !== "ready" \|\| !portal \|\| managerView !== "administration" \|\| portal\.actor\.platformAdmin\) return;[\s\S]*?for \(const parameter of \["section", "student", "focus", "attempt", "request", "requestKind", "invite"\]\) \{[\s\S]*?url\.searchParams\.delete\(parameter\);[\s\S]*?window\.history\.replaceState/,
  );
  assert.match(
    portal,
    /const visibleManagerView = \(managerView === "administration" && !portal\.actor\.platformAdmin\)[\s\S]*?\? "overview"[\s\S]*?: managerView/,
  );
});
