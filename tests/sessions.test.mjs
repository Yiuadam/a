/*
  Who may sit what, and how often.

  This is the kind of table that looks obviously right and is obviously wrong
  six weeks later, when somebody adds a tier and copies the row above it. The
  numbers here are the owner's, stated over several messages and corrected
  twice; these tests are where they are written down in a form that fails
  rather than in a comment nobody re-reads.

  The one worth reading twice is the anonymous row. Writing and Speaking are
  locked there not because they are premium but because they are *marked by
  the model*, and anonymous callers get no model at all. A writing session with
  no marking is forty minutes and a blank box. If a later change gives
  anonymous an AI allowance, these two tests are the ones that should make
  somebody stop and think.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
  alias-resolve rather than ts-resolve: lib/usage/limits.ts now imports
  @/lib/billing/tiers, and Node knows nothing about tsconfig paths. See the
  note at the top of tests/alias-resolve.mjs.
*/
register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);

const { allowanceFor, allowanceLabel, isLocked, lockReason, sessionsLeft, SESSION_LIMITS } =
  await load("lib", "entitlements", "sessions.ts");
const { ANONYMOUS_DAILY_AI_CALLS } = await load("lib", "usage", "limits.ts");

const MODULES = ["listening", "reading", "writing", "speaking"];

test("anonymous gets one listening and one reading paper, and nothing else", () => {
  assert.equal(allowanceFor("anonymous", "listening").perWeek, 1);
  assert.equal(allowanceFor("anonymous", "reading").perWeek, 1);
  assert.equal(allowanceFor("anonymous", "writing").perWeek, 0);
  assert.equal(allowanceFor("anonymous", "speaking").perWeek, 0);
});

test("the two skills anonymous may sit are the two that need no model", () => {
  /*
    The load-bearing invariant. Listening and reading are marked from an answer
    key in the bundle; writing and speaking are marked by the model. Anonymous
    has no model, so anonymous may only sit the first two — and if the
    allowance ever stops being zero, this stops being a safe assumption.
  */
  assert.equal(ANONYMOUS_DAILY_AI_CALLS, 0, "anonymous has an AI allowance again — recheck this table");
  for (const skill of ["writing", "speaking"]) {
    assert.ok(
      isLocked("anonymous", skill),
      `${skill} is marked by the model and anonymous has no model, so it must be locked`,
    );
  }
});

test("a free account gets two of each reading and listening, one of each writing and speaking", () => {
  assert.equal(allowanceFor("free", "listening").perWeek, 2);
  assert.equal(allowanceFor("free", "reading").perWeek, 2);
  assert.equal(allowanceFor("free", "writing").perWeek, 1);
  assert.equal(allowanceFor("free", "speaking").perWeek, 1);
});

test("a free speaking session allows exactly one question", () => {
  assert.equal(allowanceFor("free", "speaking").maxQuestions, 1);
  // And nothing else caps questions — only speaking runs to several.
  for (const skill of ["listening", "reading", "writing"]) {
    assert.equal(allowanceFor("free", skill).maxQuestions, null, skill);
  }
});

test("a free account is not locked out of anything", () => {
  for (const skill of MODULES) assert.equal(isLocked("free", skill), false, skill);
});

test("Standard and the owner have no session limit at all", () => {
  for (const tier of ["pro", "admin"]) {
    for (const skill of MODULES) {
      assert.equal(allowanceFor(tier, skill).perWeek, null, `${tier}/${skill}`);
      assert.equal(allowanceFor(tier, skill).maxQuestions, null, `${tier}/${skill}`);
    }
  }
});

test("a lock sends a visitor to sign in and a free account to the plans", () => {
  assert.equal(lockReason("anonymous", "writing"), "sign-in");
  assert.equal(lockReason("anonymous", "speaking"), "sign-in");
  assert.equal(lockReason("free", "writing"), null, "nothing is locked for a free account");
  assert.equal(lockReason("pro", "speaking"), null);
});

test("sessionsLeft counts down and stops at zero", () => {
  assert.equal(sessionsLeft("free", "reading", 0), 2);
  assert.equal(sessionsLeft("free", "reading", 1), 1);
  assert.equal(sessionsLeft("free", "reading", 2), 0);
  // Never negative, even if an allowance was lowered under a learner.
  assert.equal(sessionsLeft("free", "reading", 9), 0);
  assert.equal(sessionsLeft("pro", "reading", 500), null, "no limit means no number");
});

test("the label says what a learner gets, including the speaking caveat", () => {
  assert.equal(allowanceLabel("free", "reading"), "2 sessions a week");
  assert.equal(allowanceLabel("free", "writing"), "1 session a week");
  assert.equal(allowanceLabel("free", "speaking"), "1 session a week, 1 question");
  assert.equal(allowanceLabel("anonymous", "listening"), "1 session a week");
  assert.equal(allowanceLabel("anonymous", "writing"), "Sign in to use this");
  assert.equal(allowanceLabel("pro", "speaking"), "Unlimited");
});

test("every tier has a row for every skill", () => {
  for (const [tier, row] of Object.entries(SESSION_LIMITS)) {
    for (const skill of MODULES) {
      assert.ok(row[skill], `${tier} is missing ${skill}`);
    }
  }
});

test("a paid tier is never worse off than a free one", () => {
  /*
    The copy-the-row-above mistake, caught. `null` is unlimited and therefore
    the largest value, which is exactly the comparison a plain `>=` gets wrong.
  */
  const rank = (v) => (v === null ? Infinity : v);
  for (const skill of MODULES) {
    assert.ok(
      rank(allowanceFor("free", skill).perWeek) >= rank(allowanceFor("anonymous", skill).perWeek),
      `free gets less ${skill} than anonymous`,
    );
    assert.ok(
      rank(allowanceFor("pro", skill).perWeek) >= rank(allowanceFor("free", skill).perWeek),
      `Standard gets less ${skill} than free`,
    );
  }
});
