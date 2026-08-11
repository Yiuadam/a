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

test("the public homepage always explains BandUp's purpose", () => {
  assert.match(
    page,
    /An IELTS learning and practice app with a placement test and personal study plan\./,
  );

  const purposePosition = page.indexOf("An IELTS learning and practice app");
  const optionalSummaryPosition = page.indexOf('className="dashboard-summary');
  assert.ok(purposePosition !== -1 && purposePosition < optionalSummaryPosition);
});
