import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

test("the public homepage shows the exact OAuth app name", () => {
  assert.match(page, />\s*BandUp\s*<\/h1>/);
  assert.match(layout, /applicationName:\s*"BandUp"/);
  assert.match(layout, /title:\s*"BandUp"/);
});

// The placement-test hero this used to check ("An IELTS learning and
// practice app with a placement test and personal study plan.") is gone —
// the free Pro trial poster took over its slot in the dashboard, always,
// so there is no longer a homepage state where that sentence would even
// render. tests/dashboard-home.test.mjs and tests/free-pro-trial.test.mjs
// cover what is in that slot now.
