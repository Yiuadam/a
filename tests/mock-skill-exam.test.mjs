/*
  A standalone single-skill exam: one module, sat under real exam conditions,
  with no earlier sitting behind it.

  The behavioural rules that decide what this session *is* — which module it
  covers, when it ends, what `recordRetake` does with one — are pinned beside
  the retake's own rules in mock-retake.test.mjs, because both are the same
  `MockRetakeIntent` shape and the same functions read it. What belongs here
  instead is the architectural guarantee that only a source read can pin: the
  screen a standalone sitting reaches must never reduce to the screen a retake
  reaches, however similar the two look, because MockRetakeResults writes a
  band over an existing report and a standalone sitting has none to write
  over. Get that screen wrong and the failure is silent — nothing throws, a
  band appears, and it has quietly become a retake of a report the learner
  never sat.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const results = readFileSync("components/exam/MockSkillResults.tsx", "utf8");
const page = readFileSync("app/exam/page.tsx", "utf8");

/* Comments explain the rule; they must not be what satisfies the assertion. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("a standalone single-skill exam never creates or updates a MockExamReport", () => {
  assert.doesNotMatch(
    code(results),
    /addMockReport/,
    "MockSkillResults must never write a MockExamReport — a standalone sitting has none to update",
  );
});

test("a standalone single-skill exam never records a retake", () => {
  const body = code(results);
  assert.doesNotMatch(
    body,
    /\brecordRetake\b/,
    "MockSkillResults must never call recordRetake — it has no report to attach a retake to",
  );
  assert.doesNotMatch(body, /\baddMockRetake\b/, "MockSkillResults must never write a MockRetake");
});

test("a standalone single-skill exam never reads the standing report to compute a delta", () => {
  assert.doesNotMatch(
    code(results),
    /standingFor/,
    "a standalone sitting has no earlier report to compare against, so this screen must not import the machinery that compares one",
  );
});

test("a standalone single-skill exam records an ordinary result", () => {
  assert.match(
    code(results),
    /\baddResult\(/,
    "MockSkillResults must record the band the same way any other completed module does — that is what lets history, the study plan and the dashboard read it",
  );
});

test("the exam page routes a session by what its retake intent contains, not merely whether it has one", () => {
  const body = code(page);
  assert.match(
    body,
    /session\.retake\.of/,
    "the results routing must branch on `of` specifically — branching on `retake` alone cannot tell a retake from a standalone sitting",
  );
  assert.match(body, /<MockResults\b/, "a session with no retake intent must still reach the full-sitting report");
  assert.match(body, /<MockRetakeResults\b/, "`of` present must still reach the retake screen");
  assert.match(body, /<MockSkillResults\b/, "`of` absent must reach the standalone screen");
});

test("the exam page imports the screen a standalone sitting needs", () => {
  assert.match(
    code(page),
    /import MockSkillResults from ["']@\/components\/exam\/MockSkillResults["']/,
  );
});
