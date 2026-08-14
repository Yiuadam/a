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

test("the homepage hero and placement action cannot be squeezed at narrow widths", () => {
  assert.match(page, /className="dashboard-hero[^"]*\bshrink-0\b[^"]*\bflex-wrap\b/);
  assert.match(page, /className="dashboard-hero-actions[^"]*\bshrink-0\b/);
  assert.match(page, /className="dashboard-placement-button[^"]*\bshrink-0\b[^"]*\bwhitespace-nowrap\b/);
  assert.match(page, /href="\/plan" className="[^"]*\bshrink-0\b[^"]*\bwhitespace-nowrap\b/);
  assert.match(page, /href="\/placement" className="btn-secondary[^"]*\bshrink-0\b[^"]*\bwhitespace-nowrap\b/);

  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.doesNotMatch(css, /\.dashboard-hero\s*\{[^}]*flex-wrap:\s*nowrap/);
});
