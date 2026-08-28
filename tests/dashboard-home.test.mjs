import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../scripts/ts-resolve.mjs", import.meta.url);

const {
  homeOrganizationShortcutFromPortal,
  homeOrganizationShortcutFromResponse,
} = await import(
  pathToFileURL(join(process.cwd(), "lib", "dashboard-home.ts")).href
);

const membership = (id, status = "active", organizationStatus = "active") => ({
  status,
  role: "teacher",
  organization: {
    id,
    name: id === "second" ? "Harbour English Academy" : "First School",
    status: organizationStatus,
    memberCount: 5,
    studentCount: 3,
  },
});

test("the homepage shortcut selects the portal's current active organisation", () => {
  assert.deepEqual(homeOrganizationShortcutFromPortal({
    activeOrganizationId: "second",
    memberships: [membership("first"), membership("second")],
  }), {
    id: "second",
    name: "Harbour English Academy",
    role: "teacher",
    memberCount: 5,
    studentCount: 3,
  });
});

test("inactive memberships and organisations never become homepage links", () => {
  assert.equal(homeOrganizationShortcutFromPortal({
    activeOrganizationId: "first",
    memberships: [membership("first", "pending"), membership("second", "active", "suspended")],
  }), null);
});

test("malformed portal data fails closed", () => {
  assert.equal(homeOrganizationShortcutFromPortal(null), null);
  assert.equal(homeOrganizationShortcutFromPortal({ memberships: "not a list" }), null);
  assert.equal(homeOrganizationShortcutFromPortal({
    activeOrganizationId: "first",
    memberships: [{ status: "active", role: "teacher", organization: { id: "first" } }],
  }), null);
});

test("the small homepage response is validated before it becomes a link", () => {
  assert.deepEqual(homeOrganizationShortcutFromResponse({
    organization: {
      id: "first",
      name: " First School ",
      role: "student",
      memberCount: 4,
      studentCount: 3,
    },
  }), {
    id: "first",
    name: "First School",
    role: "student",
    memberCount: 4,
    studentCount: 3,
  });
  assert.equal(homeOrganizationShortcutFromResponse({ organization: { id: "first" } }), null);
});

test("the homepage puts recorded history ahead of the welcome or organisation shortcut", () => {
  const source = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
  /*
    A truthy-but-malformed placement must not make the dashboard claim a
    band, but either a valid placement or one recorded practice sitting is
    enough to replace the first-visit poster with useful history.
  */
  assert.match(source, /const placement = isValidPlacement\(profile\.placement\) \? profile\.placement : null;/);
  assert.match(source, /const hasRecordedHistory = placement !== null \|\| profile\.results\.length > 0;/);
  assert.match(source, /hasRecordedHistory \? \([\s\S]*?<ScoreTrendOverview[\s\S]*?\) : organization \? \([\s\S]*?<OrganisationHero/);
  assert.match(source, /import \{ isValidPlacement \} from "@\/lib\/placement";/);
  // Only a first-time visitor with no result or placement reaches the offer.
  assert.match(source, /<FreeProPoster \/>/);
  assert.doesNotMatch(source, /<PlacementHero/);
  assert.match(source, /TREND_MODULES\.map/);
  assert.match(source, /href=\{`\/history\?module=\$\{module\}`\}/);
  assert.match(source, /View detailed history/);
  assert.match(source, /Take placement test/);
  assert.match(source, /placement\s*\?\s*`Placement band \$\{placement\.band\} · four skill trends`/);
  assert.match(source, /\$\{sittingCount\} recorded practice sitting/);
  assert.match(source, /api\/organization\/shortcut/);
  assert.doesNotMatch(source, /apiUrl\("\/api\/organization"\)/);
});

test("the homepage keeps history as four trends instead of duplicating it as a sitting list", () => {
  const source = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
  assert.match(source, /<ScoreTrendOverview placement=\{placement\} results=\{profile\.results\} \/>/);
  assert.doesNotMatch(source, /Your recent practice/);
  assert.doesNotMatch(source, /dashboard-recent/);
  assert.doesNotMatch(source, /newestFirst/);
});

test("opening a homepage destination saves its visit so its New label stays retired", () => {
  const source = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
  assert.match(source, /import \{ markVisited \} from "@\/lib\/store";/);
  assert.match(source, /onClick=\{\(\) => markVisited\(m\.key\)\}/);
  assert.match(source, /drillSectionNeedsNewBadge\(profile, scores, s\.key\)/);
  assert.match(source, /onClick=\{\(\) => markVisited\(s\.key\)\}/);
});

test("every dashboard destination records a direct or menu visit too", () => {
  const destinations = [
    ["app", "grammar", "page.tsx", "grammar"],
    ["app", "vocabulary", "page.tsx", "vocabulary"],
    ["app", "practice", "listening", "page.tsx", "listening"],
    ["app", "practice", "reading", "page.tsx", "reading"],
    ["app", "practice", "writing", "page.tsx", "writing"],
    ["app", "speaking", "page.tsx", "speaking"],
  ];
  for (const entry of destinations) {
    const destination = entry.at(-1);
    const path = entry.slice(0, -1);
    const source = readFileSync(join(process.cwd(), ...path), "utf8");
    assert.match(source, /import DashboardVisit from "@\/components\/DashboardVisit";/);
    assert.match(source, new RegExp(`<DashboardVisit destination="${destination}"`));
  }
});

test("the homepage shortcut endpoint avoids loading the complete organisation portal", () => {
  const route = readFileSync(
    join(process.cwd(), "app", "api", "organization", "shortcut", "route.ts"),
    "utf8",
  );
  const cloudflare = readFileSync(join(process.cwd(), "lib", "cloudflare", "organizations.ts"), "utf8");
  assert.match(route, /organizationHomeShortcut\(user\)/);
  assert.match(route, /Cache-Control\": \"private, no-store, max-age=0/);
  assert.match(route, /withCors\(handleGET\)/);
  assert.match(cloudflare, /cloudflareOrganizationHomeShortcut[\s\S]*m\.status = 'active'[\s\S]*o\.status = 'active'[\s\S]*LIMIT 1/);
});
