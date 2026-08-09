/*
  Who may sit what, and how often.

  This is the kind of table that looks obviously right and is obviously wrong
  six weeks later, when somebody adds a tier and copies the row above it. The
  numbers here are the owner's, stated over several messages and corrected
  twice; these tests are where they are written down in a form that fails
  rather than in a comment nobody re-reads.

  The one worth reading twice is the writing and speaking column. They are
  locked for a visitor and for a free account not because they are premium but
  because they are *marked by the model*, and neither of those tiers gets a
  model at all (lib/billing/tiers.ts — AI starts at Plus). A writing session
  with no marking is forty minutes and a blank box.

  Standard is the deliberate exception, and it is the one line here that has to
  be argued rather than asserted: it unlocks writing and speaking with no
  marking behind them, because Standard is a plan somebody chose from a card
  that says "marked from the answer key, not by AI" in as many words. A free
  account has agreed to nothing, so it gets the version that cannot
  disappoint.
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
const { tierHasAi } = await load("lib", "billing", "tiers.ts");

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

test("a free account gets two reading and two listening papers, and no marking", () => {
  assert.equal(allowanceFor("free", "listening").perWeek, 2);
  assert.equal(allowanceFor("free", "reading").perWeek, 2);
  assert.equal(allowanceFor("free", "writing").perWeek, 0);
  assert.equal(allowanceFor("free", "speaking").perWeek, 0);
});

test("no tier is offered a marked skill without the marking behind it", () => {
  /*
    The load-bearing invariant, now that AI starts at Plus. Free has no model,
    so free may not sit writing or speaking — the same argument that locks them
    for a visitor.

    Standard is the exception and is asserted as one rather than skipped: it
    has no model either, and it opens both anyway, because its card says so.
  */
  for (const tier of ["anonymous", "free"]) {
    assert.equal(tierHasAi(tier === "anonymous" ? "free" : tier), false);
    for (const skill of ["writing", "speaking"]) {
      assert.ok(isLocked(tier, skill), `${tier} may sit ${skill} with nothing to mark it`);
    }
  }
  assert.equal(tierHasAi("standard"), false);
  assert.equal(isLocked("standard", "writing"), false, "Standard sells the timer, not the marking");
});

test("every paid tier and the owner have no session limit at all", () => {
  for (const tier of ["standard", "plus", "pro", "admin"]) {
    for (const skill of MODULES) {
      assert.equal(allowanceFor(tier, skill).perWeek, null, `${tier}/${skill}`);
    }
  }
});

test("a lock sends a visitor to sign in and a free account to the plans", () => {
  assert.equal(lockReason("anonymous", "writing"), "sign-in");
  assert.equal(lockReason("anonymous", "speaking"), "sign-in");
  // An account is not the missing piece for a free account, so it is not what
  // they are asked for.
  assert.equal(lockReason("free", "writing"), "subscribe");
  assert.equal(lockReason("free", "speaking"), "subscribe");
  assert.equal(lockReason("free", "reading"), null);
  assert.equal(lockReason("standard", "writing"), null);
  assert.equal(lockReason("pro", "speaking"), null);
});

test("sessionsLeft counts down and stops at zero", () => {
  assert.equal(sessionsLeft("free", "reading", 0), 2);
  assert.equal(sessionsLeft("free", "reading", 1), 1);
  assert.equal(sessionsLeft("free", "reading", 2), 0);
  // Never negative, even if an allowance was lowered under a learner.
  assert.equal(sessionsLeft("free", "reading", 9), 0);
  assert.equal(sessionsLeft("standard", "reading", 500), null, "no limit means no number");
  assert.equal(sessionsLeft("pro", "reading", 500), null, "no limit means no number");
});

test("the label says what a learner gets, including the speaking caveat", () => {
  assert.equal(allowanceLabel("free", "reading"), "2 sessions a week");
  assert.equal(allowanceLabel("free", "writing"), "On Standard and up");
  assert.equal(allowanceLabel("anonymous", "listening"), "1 session a week");
  assert.equal(allowanceLabel("anonymous", "writing"), "Sign in to use this");
  assert.equal(allowanceLabel("standard", "speaking"), "Unlimited");
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
  const LADDER = ["anonymous", "free", "standard", "plus", "pro", "admin"];
  for (const skill of MODULES) {
    for (let i = 1; i < LADDER.length; i += 1) {
      const above = LADDER[i];
      const below = LADDER[i - 1];
      assert.ok(
        rank(allowanceFor(above, skill).perWeek) >= rank(allowanceFor(below, skill).perWeek),
        `${above} gets less ${skill} than ${below}`,
      );
    }
  }
});
