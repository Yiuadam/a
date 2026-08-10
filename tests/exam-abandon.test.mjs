/*
  Leaving the exam page ends the sitting — and a reload does not.

  The bug this pins was reported from the live site: start the mock exam, tap
  the menu, read a grammar page, come back, and the sitting is still there with
  the clock still running. Every rule that makes a mock worth sitting is gone
  at that point — the reading hour is an hour plus however long you were away,
  and a listening recording that plays once can be worked around by leaving
  between questions.

  Two halves, and the second is the one that is easy to break while fixing the
  first. A reload, a locked phone and a reclaimed background tab must still
  resume, because losing a three-hour sitting to one of those is the worst
  thing this feature could do to a person. The distinction is not a guess: a
  navigation inside the app unmounts the exam screen, and a reload discards the
  whole JavaScript context without React unmounting anything.

  The pathname guard inside the cleanup is the third load-bearing piece and the
  least obvious. React's StrictMode mounts, unmounts and remounts every
  component in development to prove effects survive it; without the guard that
  teardown reads as a navigation and starting a mock ends it in the same frame.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync("app/exam/page.tsx", "utf8");
const store = readFileSync("lib/exam/mock.ts", "utf8");

/* Comments explain the trap; they must not be what satisfies the test. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the exam page abandons the sitting when it unmounts", () => {
  const body = code(page);
  assert.match(body, /abandonSession/, "app/exam/page.tsx never calls abandonSession");
  assert.match(
    body,
    /useEffect\(\s*\(\)\s*=>\s*\{\s*return\s*\(\)\s*=>/,
    "the abandon must run from an effect cleanup — that is what distinguishes a navigation from a reload",
  );
});

test("the cleanup checks the address bar, so StrictMode's remount is not a departure", () => {
  const body = code(page);
  assert.match(
    body,
    /window\.location\.pathname[\s\S]{0,80}\/exam/,
    "without the pathname check, starting a mock in development ends it immediately",
  );
});

test("a sitting that has reached its results is not thrown away", () => {
  const body = code(store);
  assert.match(
    body,
    /export function abandonSession[\s\S]*?stage === "results"[\s\S]*?return/,
    "abandonSession must leave the results screen alone — there is nothing left to protect",
  );
});

test("abandoning only forgets — it never writes a result or spends a session", () => {
  const body = code(store);
  const start = body.indexOf("export function abandonSession");
  const fn = body.slice(start, body.indexOf("\n}", start));

  /*
    Whitelisted by name rather than by absence. "Must not mention recording"
    was the first version of this and it failed on the word inside
    `stage === "results"` — an absence test that reads the wrong thing passes
    or fails for reasons that have nothing to do with the rule.
  */
  const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "abandonSession"]);
  const calls = [...fn.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((name) => !KEYWORDS.has(name));
  assert.deepEqual(
    [...new Set(calls)].sort(),
    ["clearSession", "sessionSnapshot"],
    "leaving must cost the learner nothing but the answers they had typed",
  );
});
