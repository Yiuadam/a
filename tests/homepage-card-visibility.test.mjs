import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const appMain = readFileSync(join(process.cwd(), "components", "AppMain.tsx"), "utf8");
const page = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");

test("the homepage never clips the Grammar and Vocabulary card row", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const rule = css.match(/\.dashboard-screen > \.grid \{([^}]+)\}/)?.[1] ?? "";
  assert.match(rule, /overflow:\s*visible/);
  assert.doesNotMatch(rule, /overflow:\s*hidden/);
});

test("the full-bleed homepage remains a document instead of locking the viewport", () => {
  const lockedRoutes = appMain.match(/const viewportLocked =([\s\S]*?);/)?.[1] ?? "";
  assert.doesNotMatch(lockedRoutes, /pathname === "\/"/);
  assert.match(appMain, /const fullBleed = pathname === "\/" \|\| viewportLocked/);

  const dashboardClass = page.match(/className="(dashboard-screen[^"]*)"/)?.[1] ?? "";
  assert.match(dashboardClass, /\boverflow-x-clip\b/);
  assert.doesNotMatch(dashboardClass, /\bh-full\b|\boverflow-y-auto\b|\boverflow-hidden\b/);
});

test("the score-trend hero's own actions cannot be squeezed at narrow widths", () => {
  // The placement-test hero these three checked (dashboard-hero,
  // dashboard-hero-actions, dashboard-placement-button) no longer exists —
  // the free Pro trial poster took over its slot in the dashboard, always,
  // per the free-pro-trial suite. What remains here is the returning
  // learner's score-trend row, which carries the same narrow-width
  // constraint on its own two buttons.
  assert.doesNotMatch(page, /dashboard-hero-actions|dashboard-placement-button/);
  assert.match(page, /href="\/plan" className="[^"]*\bshrink-0\b[^"]*\bwhitespace-nowrap\b/);
  assert.match(page, /href="\/placement" className="btn-secondary[^"]*\bshrink-0\b[^"]*\bwhitespace-nowrap\b/);
});
