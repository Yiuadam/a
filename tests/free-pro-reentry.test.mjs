/*
  A "No thanks" on the free AI trial poster used to be permanent, even for a
  reader who had never actually held the trial. Dismissing writes a
  localStorage flag (lib/billing/free-pro-dismissal.ts) that the shared offer
  store (lib/billing/free-pro-offer.ts) checks before it ever asks the server
  again, and components/billing/GiveUpFreeProSection.tsx — the only other
  place the trial can be started — drew nothing unless the account already
  held the grant at some point. Someone who declined outright had no way back
  to an offer the server was still making.

  This mirrors tests/give-up-free-ai.test.mjs and tests/free-ai-trial.test.mjs
  in checking source text: comments stripped first, since an earlier test in
  this repository once passed against a comment quoting the code it meant to
  check.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

/** The file's code, without comments — same helper as the two files this mirrors. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const section = read("components", "billing", "GiveUpFreeProSection.tsx");

test("the section asks /api/billing/promo for \"offered\" off the same response it already reads \"grantHeld\" from", () => {
  const body = code(section);
  // One fetch, not two: the existing GET already answers both fields (see
  // app/api/account/... no — app/api/billing/promo/route.ts's handleGET).
  assert.equal((body.match(/authedFetch\(apiUrl\("\/api\/billing\/promo"\)\)/g) ?? []).length, 1);
  assert.match(body, /offered\?:\s*boolean/);
  assert.match(body, /body\?\.offered === true/);
});

test("the re-entry row bypasses the shared store's dismissal check rather than going through it", () => {
  const body = code(section);
  // dismissedAlready() read directly here — the shared store in
  // lib/billing/free-pro-offer.ts checks the same flag *before* it asks the
  // server, which is exactly the short-circuit this row exists to route
  // around.
  assert.match(body, /import \{ dismissedAlready, forgetDecision \} from "@\/lib\/billing\/free-pro-dismissal";/);
  assert.match(body, /setReentry\(body\?\.offered === true && dismissedAlready\(\)\)/);
});

test("accepting from the row hands off to the shared offer store, not a second copy of its request", () => {
  const body = code(section);
  assert.match(body, /import \{ acceptFreePro \} from "@\/lib\/billing\/free-pro-offer";/);
  const handler = body.slice(body.indexOf("const startFreshTrial"), body.indexOf("const giveUp"));
  assert.match(handler, /setReentry\(false\)/);
  assert.match(handler, /void acceptFreePro\(\)/);
  // No bespoke busy/error state for this row — that is what mounting the
  // poster in the same SignedIn view is for (components/AccountPanel.tsx).
  assert.doesNotMatch(handler, /setBusy/);
});

test("the row only draws for a reader who said no without ever holding the trial", () => {
  const body = code(section);
  const guard = body.slice(body.indexOf("if (!held && notice === null) {"), body.indexOf("const problem ="));
  assert.match(guard, /if \(!reentry\) return null;/);
  assert.match(guard, /Free AI trial available/);
  assert.match(guard, /start it/);
  assert.match(guard, /onClick=\{startFreshTrial\}/);
});

test("the row's copy manufactures no pressure, same rule as the rest of the trial's copy", () => {
  const words = code(section).replace(/\s+/g, " ");
  for (const pattern of [
    /are you sure/i,
    /\byou will lose\b/i,
    /\bmiss out\b/i,
    /\blast chance\b/i,
    /\bhurry\b/i,
    /\blimited time\b/i,
  ]) {
    assert.doesNotMatch(words, pattern, `the re-entry row uses pressure: ${pattern}`);
  }
});

test("the stale \"home page\" no longer describes where the poster lives", () => {
  // The poster moved to /account (see components/AccountPanel.tsx's
  // SignedIn, where FreeProPoster and this section are mounted together);
  // this file used to point back at a page the poster had already left.
  assert.doesNotMatch(section, /the offer on the home page/);
  assert.match(section, /the offer on this page/);
  // The sentence it lives in must still promise a way back, not merely lose
  // its wrong half.
  assert.match(code(section), /start the trial again/i);
});
