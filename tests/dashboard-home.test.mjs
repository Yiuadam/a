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

test("the homepage uses organisation, score-trend, then placement priority", () => {
  const source = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
  assert.match(source, /organization \? \([\s\S]*?<OrganisationHero/);
  /*
    This assertion used to match a bare `placement ? (`, which was the actual
    production bug: any truthy object — including an empty or malformed one —
    took this branch and rendered a "Placement band" line and badge from
    whatever was in it. A missing/zero band happens to display as exactly
    "1", the floor every band-clamping formula in this codebase shares (see
    lib/band.ts), which reads as a genuine low score rather than the absence
    of one. The guard now requires isValidPlacement — a real band on the 1-9
    scale and a parseable date — so a malformed or emptied-out placement
    record can never pass this check. See lib/placement.ts and
    tests/placement-adaptive.test.mjs for the guard itself.
  */
  assert.match(source, /\) : isValidPlacement\(placement\) \? \([\s\S]*?<ScoreTrendOverview/);
  assert.match(source, /import \{ isValidPlacement \} from "@\/lib\/placement";/);
  // The free Pro trial poster took over the placement-test card's own slot
  // (was <PlacementHero />) so every first-time visitor and fresh account —
  // exactly who neither organisation nor score-trend applies to — sees the
  // offer, signed in or not. See components/billing/FreeProPoster.tsx.
  assert.match(source, /<FreeProPoster \/>/);
  assert.doesNotMatch(source, /<PlacementHero/);
  assert.match(source, /TREND_MODULES\.map/);
  assert.match(source, /href=\{`\/history\?module=\$\{module\}`\}/);
  assert.match(source, /api\/organization\/shortcut/);
  assert.doesNotMatch(source, /apiUrl\("\/api\/organization"\)/);
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
