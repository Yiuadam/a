/*
  The abandon-on-unmount rule pinned by exam-abandon.test.mjs only fires once
  a navigation has already unmounted the exam screen. It cannot warn first,
  and it cannot do anything at all about a reload or a closed tab. This pins
  the two guards that were added because of that gap: a `beforeunload` prompt
  for a reload or close, and a capture-phase click listener that asks before
  letting an in-app link — the logo, the menu, the bell, the account button —
  unmount the page at all.

  Source-level, like exam-abandon.test.mjs beside it: what has to be provable
  here is the shape of the effect (registers on mount, tears down on unmount,
  stops once results are in) rather than a simulated click, which a plain
  node:test file has no DOM to deliver.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync("app/exam/page.tsx", "utf8");

/* Comments explain the rule; they must not be what satisfies the assertion. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/* The effect that owns both guards, isolated from the rest of the page. */
function leaveGuardEffect() {
  const body = code(page);
  const marker = "const sittingInProgress = session ? session.stage !== \"results\" : false;";
  const start = body.indexOf(marker);
  assert.notEqual(start, -1, "could not find the sittingInProgress guard this effect depends on");
  // The effect's own closing `}, [sittingInProgress]);` bounds it from below.
  const end = body.indexOf("}, [sittingInProgress]);", start);
  assert.notEqual(end, -1, "could not find the leave-guard effect's dependency array");
  return body.slice(start, end);
}

test("a sitting is 'in progress' until its stage reaches results, and not before a session exists", () => {
  const body = code(page);
  assert.match(
    body,
    /const sittingInProgress = session \? session\.stage !== "results" : false;/,
    "must derive whether a sitting is in progress from the session's own stage",
  );
});

test("the guard effect bails out immediately once nothing is in progress", () => {
  const effect = leaveGuardEffect();
  assert.match(
    effect,
    /useEffect\(\s*\(\)\s*=>\s*\{\s*if\s*\(!sittingInProgress\)\s*return;/,
    "the effect must bail out — and add neither listener — while sittingInProgress is false",
  );
});

test("a reload or a closed tab is met with the browser's own confirmation", () => {
  const effect = leaveGuardEffect();
  assert.match(effect, /addEventListener\(\s*"beforeunload"/, "must register a beforeunload handler");
  assert.match(effect, /event\.preventDefault\(\)/, "the beforeunload handler must call preventDefault");
  assert.match(effect, /event\.returnValue\s*=/, "the beforeunload handler must set returnValue to trigger the prompt");
});

test("an in-app link to a different path is confirmed before it is allowed to navigate", () => {
  const effect = leaveGuardEffect();
  assert.match(effect, /document\.addEventListener\(\s*"click"[\s\S]{0,40}true\s*\)/, "the click listener must be registered on the capture phase");
  assert.match(
    effect,
    /window\.confirm\(\s*"Leave the exam\? This sitting will be lost\."\s*\)/,
    "must ask with the exact leaving-the-exam confirmation",
  );
});

test("declining the confirmation cancels the navigation rather than merely asking", () => {
  const effect = leaveGuardEffect();
  const confirmAt = effect.indexOf("window.confirm(");
  assert.notEqual(confirmAt, -1);
  const guardBody = effect.slice(confirmAt, confirmAt + 200);
  assert.match(guardBody, /event\.preventDefault\(\)/, "declining must call preventDefault");
  assert.match(guardBody, /event\.stopPropagation\(\)/, "declining must call stopPropagation, or Next's own <Link> handler still runs");
});

test("both listeners are removed on unmount and when the stage reaches results", () => {
  const effect = leaveGuardEffect();
  assert.match(effect, /return\s*\(\)\s*=>\s*\{/, "the effect must return a cleanup function");
  const cleanupStart = effect.indexOf("return () => {");
  const cleanup = effect.slice(cleanupStart);
  assert.match(cleanup, /removeEventListener\(\s*"beforeunload"/, "cleanup must remove the beforeunload handler");
  assert.match(cleanup, /removeEventListener\(\s*"click"[\s\S]{0,40}true\s*\)/, "cleanup must remove the capture-phase click handler");
});

test("the effect is keyed to sittingInProgress, so it re-evaluates the moment results arrive", () => {
  const body = code(page);
  assert.match(body, /\}, \[sittingInProgress\]\);/, "the leave-guard effect must depend on [sittingInProgress]");
});
