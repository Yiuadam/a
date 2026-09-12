/*
  Who may sit what, and how often.

  This is the kind of table that looks obviously right and is obviously wrong
  six weeks later, when somebody adds a tier and copies the row above it. The
  numbers here are the owner's, stated over several messages and corrected
  twice; these tests are where they are written down in a form that fails
  rather than in a comment nobody re-reads.

  The one worth reading twice is the writing and speaking column. They used to
  be locked for a visitor and for a free account because they are *marked by
  the model*, and neither tier gets a model at all (lib/billing/tiers.ts — AI
  is its own tier now, separate from access). That argument still holds for a
  visitor with no account. It does not hold for a signed-in Free account any
  more: the owner's decision was that a writing or speaking session hands the
  essay or the transcript back afterward, unscored, rather than nothing at
  all — not premium, and not a blank box either. So Free opens the whole
  library, the same as every paid tier, and what a paid tier buys is AI and a
  saved history, never access to a paper.
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
    The load-bearing invariant, for anonymous specifically. Listening and
    reading are marked from an answer key in the bundle; writing and speaking
    are marked by the model when a model is available at all, and an
    anonymous caller never has one — so there is no unscored fallback to hand
    back, unlike a signed-in Free account, which does have somewhere to save
    what it hands back to nobody in particular.
  */
  assert.equal(ANONYMOUS_DAILY_AI_CALLS, 0, "anonymous has an AI allowance again — recheck this table");
  for (const skill of ["writing", "speaking"]) {
    assert.ok(
      isLocked("anonymous", skill),
      `${skill} is locked for a visitor with no account to remember a sitting under`,
    );
  }
});

test("every signed-in tier gets the whole library, unlimited", () => {
  /*
    The load-bearing invariant now. Free, Tracking, AI and the owner's own
    account all resolve to the same EVERYTHING row — content access stopped
    being what a tier buys the moment Free stopped being rationed, and what
    is left to sell is AI and a saved history, neither of which this table
    is about.
  */
  for (const tier of ["free", "tracking", "ai", "admin"]) {
    for (const skill of MODULES) {
      assert.equal(allowanceFor(tier, skill).perWeek, null, `${tier}/${skill} should be unlimited`);
      assert.equal(isLocked(tier, skill), false, `${tier} should not be locked out of ${skill}`);
    }
  }
});

test("a lock sends a visitor to sign in — signing in is the whole answer now", () => {
  assert.equal(lockReason("anonymous", "writing"), "sign-in");
  assert.equal(lockReason("anonymous", "speaking"), "sign-in");
  // No signed-in tier is ever locked out of a skill any more, so there is
  // nothing left for lockReason to explain once an account exists.
  for (const tier of ["free", "tracking", "ai", "admin"]) {
    for (const skill of MODULES) {
      assert.equal(lockReason(tier, skill), null, `${tier}/${skill} should not need a reason`);
    }
  }
});

/*
  lockReason's "subscribe" branch is not reachable through SESSION_LIMITS as
  it stands today — every locked row belongs to anonymous, so the ternary
  only ever sees tier === "anonymous" in practice, per the comment above the
  function itself. The branch is kept on purpose rather than deleted (a
  locked skill still has to name a reason if one is ever added back for a
  paid tier), so it is worth pinning down against the table directly instead
  of only through data that cannot exercise it. This substitutes a locked
  row for "free" only, and restores the table immediately after — the other
  signed-in tiers still point at the shared EVERYTHING object and are never
  touched.
*/
test("a locked skill for a signed-in tier would say subscribe, not sign-in", () => {
  const originalFree = SESSION_LIMITS.free;
  SESSION_LIMITS.free = { ...originalFree, writing: { perWeek: 0 } };
  try {
    assert.equal(lockReason("free", "writing"), "subscribe");
  } finally {
    SESSION_LIMITS.free = originalFree;
  }
});

test("sessionsLeft has nothing to count down once an account exists", () => {
  assert.equal(sessionsLeft("free", "reading", 0), null, "no limit means no number");
  assert.equal(sessionsLeft("free", "reading", 500), null, "no limit means no number");
  assert.equal(sessionsLeft("ai", "reading", 500), null, "no limit means no number");
  // Anonymous is the one tier this still counts down for.
  assert.equal(sessionsLeft("anonymous", "reading", 0), 1);
  assert.equal(sessionsLeft("anonymous", "reading", 1), 0);
  // Never negative, even if an allowance was lowered under a learner.
  assert.equal(sessionsLeft("anonymous", "reading", 9), 0);
});

test("the label says what a learner gets", () => {
  assert.equal(allowanceLabel("free", "reading"), "Unlimited");
  assert.equal(allowanceLabel("free", "writing"), "Unlimited");
  assert.equal(allowanceLabel("anonymous", "listening"), "1 session a week");
  assert.equal(allowanceLabel("anonymous", "writing"), "Sign in to use this");
  assert.equal(allowanceLabel("ai", "speaking"), "Unlimited");
});

/*
  Every non-zero, non-null perWeek in SESSION_LIMITS today is exactly 1, so
  the plural half of this label — the template rather than the "1 session a
  week" literal — never actually runs. It is written for any count, not just
  one, which is exactly the kind of thing this file exists to pin down
  before a new tier's row makes it real (see the file header). This
  substitutes a perWeek of 2 for "free" only, and restores the table right
  after.
*/
test("the label pluralises once a week is more than one session", () => {
  const originalFree = SESSION_LIMITS.free;
  SESSION_LIMITS.free = { ...originalFree, reading: { perWeek: 2 } };
  try {
    assert.equal(allowanceLabel("free", "reading"), "2 sessions a week");
  } finally {
    SESSION_LIMITS.free = originalFree;
  }
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
    the largest value, which is exactly the comparison a plain `>=` gets
    wrong. Every signed-in row is EVERYTHING now, so this mostly proves the
    ladder is flat where it should be — anonymous is still the one real step.
  */
  const rank = (v) => (v === null ? Infinity : v);
  const LADDER = ["anonymous", "free", "tracking", "ai", "admin"];
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
