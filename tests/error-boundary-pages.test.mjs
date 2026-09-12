/*
  Before these files existed, any uncaught render error fell through to
  Next's own bare "Application error" screen — no header, no menu, nothing
  to press. app/error.tsx and app/global-error.tsx are the two boundaries
  that replace that with something a learner can act on.

  These are source-level checks rather than rendered ones: both files are
  React Server-incompatible client components whose whole job is to run
  when something else has already gone wrong, so what matters most is
  provable from the text — the client directive, the recovery call, and the
  two ways out — without standing up a DOM.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const errorPage = readFileSync("app/error.tsx", "utf8");
const globalErrorPage = readFileSync("app/global-error.tsx", "utf8");

/* Comments explain the rule; they must not be what satisfies the assertion. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("both boundaries are Client Components, as error boundaries must be", () => {
  assert.match(code(errorPage).trimStart(), /^"use client";/, "app/error.tsx must open with 'use client'");
  assert.match(
    code(globalErrorPage).trimStart(),
    /^"use client";/,
    "app/global-error.tsx must open with 'use client'",
  );
});

test("neither boundary exports metadata — that export is not supported in a Client Component", () => {
  assert.doesNotMatch(code(errorPage), /export const metadata/);
  assert.doesNotMatch(code(globalErrorPage), /export const metadata/);
});

test("both boundaries accept error, reset and retry, matching what Next's error boundary passes", () => {
  for (const [name, body] of [
    ["app/error.tsx", code(errorPage)],
    ["app/global-error.tsx", code(globalErrorPage)],
  ]) {
    assert.match(body, /error:\s*Error\s*&\s*\{\s*digest\?:\s*string\s*\}/, `${name} must type error as Error & { digest?: string }`);
    assert.match(body, /reset:\s*\(\)\s*=>\s*void/, `${name} must accept a reset prop`);
    assert.match(body, /retry:\s*\(\)\s*=>\s*void/, `${name} must accept a retry prop`);
  }
});

test("the Try again button calls retry(), the prop Next 16.3 documents as the one that re-fetches", () => {
  assert.match(code(errorPage), /onClick=\{\(\)\s*=>\s*retry\(\)\}/, "app/error.tsx's button must call retry()");
  assert.match(
    code(globalErrorPage),
    /onClick=\{\(\)\s*=>\s*retry\(\)\}/,
    "app/global-error.tsx's button must call retry()",
  );
});

test("the error is logged to the console and nothing else is logged alongside it", () => {
  for (const body of [code(errorPage), code(globalErrorPage)]) {
    assert.match(body, /console\.error\(\s*error\s*\)/, "must call console.error(error)");
    // Guards against a later edit quietly widening this into
    // console.error(error, someUserObject) — the log must carry the error
    // and nothing a learner typed.
    assert.doesNotMatch(body, /console\.error\([^)]*,[^)]*\)/, "must not log anything beyond the error itself");
  }
});

test("both boundaries link back to the app rather than being a dead end", () => {
  for (const body of [code(errorPage), code(globalErrorPage)]) {
    assert.match(body, /href="\/"/, "must link home");
    assert.match(body, /href="\/practice"/, "must link to Practice");
  }
});

test("only global-error.tsx defines its own document — it is the one replacing the root layout", () => {
  assert.doesNotMatch(code(errorPage), /<html/, "app/error.tsx renders inside the root layout and must not redeclare <html>");
  assert.match(code(globalErrorPage), /<html[\s>]/, "app/global-error.tsx must render its own <html>");
  assert.match(code(globalErrorPage), /<body[\s>]/, "app/global-error.tsx must render its own <body>");
});

test("global-error.tsx imports the app's stylesheet, since it does not inherit the layout that normally does", () => {
  assert.match(code(globalErrorPage), /import\s+["']\.\/globals\.css["']/);
});
