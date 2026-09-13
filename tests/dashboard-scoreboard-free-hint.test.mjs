/*
  A returning Free learner with nothing sat yet saw "Sit any paper and your
  band appears here" and nothing else — true, but silent on the one fact that
  actually matters to a Free account: the band that turns up next lives in
  this browser tab only, because progress-sync is Tracking's and AI's (see
  tests/history-gate.test.mjs). This file pins the one line that says so, on
  the dashboard card itself and as a bullet in the Free tier's own copy.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const scoreboard = read("components", "dashboard", "Scoreboard.tsx");

test("Scoreboard reads its own tier rather than needing it passed in", () => {
  // Its only render site, app/page.tsx, belongs to another change in flight —
  // so this stays self-contained rather than growing a prop nobody can wire
  // up yet.
  assert.match(scoreboard, /import \{ tierShows, useTier \} from "@\/lib\/billing\/useTier";/);
  assert.match(scoreboard, /const account = useTier\(\);/);
});

test("the tab-only hint is shown only when the board is empty, signed in, and without progress-sync", () => {
  assert.match(
    scoreboard,
    /const showsFreeTabOnlyHint = account\.signedIn && !tierShows\(account, "progress-sync"\);/,
  );

  const at = scoreboard.indexOf(
    "{overall === null && missing === MODULES.length && showsFreeTabOnlyHint && (",
  );
  assert.ok(at >= 0, "the hint must be gated on the fully-empty board, not the partial-progress one");
  const block = scoreboard.slice(at, scoreboard.indexOf(")}", at) + 2);
  assert.match(block, /On Free, results stay in this tab only\. Tracking keeps them\./);
});

test("a signed-out visitor's empty board is unaffected — signedIn defaults false while the tier loads", () => {
  // No separate phase/accountsEnabled guard is needed here (unlike sibling
  // tierShows call sites in this app): `signedIn` is already false in the
  // INITIAL state in lib/billing/useTier.ts, so the hint stays hidden until
  // the account is confirmed both signed in and without progress-sync.
  const guardAt = scoreboard.indexOf("const account = useTier();");
  const usageAt = scoreboard.indexOf("showsFreeTabOnlyHint", guardAt + 1);
  assert.ok(guardAt < usageAt);
});

test("the same fact is one bullet in the Free tier's own copy, with no numbers, caps or prices", () => {
  const tiers = read("lib", "billing", "tiers.ts");
  const freeAt = tiers.indexOf('id: "free",');
  const trackingAt = tiers.indexOf('id: "tracking",');
  assert.ok(freeAt >= 0 && trackingAt > freeAt, "the Free tier definition must come before Tracking's");
  const freeBlock = tiers.slice(freeAt, trackingAt);

  assert.match(freeBlock, /"Results stay in this browser tab only — Tracking keeps them"/);

  const includes = freeBlock.slice(freeBlock.indexOf("includes: ["), freeBlock.indexOf("],"));
  assert.doesNotMatch(includes, /[0-9]/, "Free has no caps to quote — see MONTHLY_AI_CAPS.free, all zero");
  assert.doesNotMatch(includes, /[$]/, "Free is not sold, so its bullets name no price");
});
