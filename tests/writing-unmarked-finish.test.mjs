/*
  Writing's own version of the "unmarked" screen speaking already had.

  Before this, a plan with no AI marking got the task, the timer and the word
  count — and no way to actually finish. The submit button was replaced with
  a plain label ("Kept if you reload"), so the only way out of the paper was
  to leave it, which threw the essay away. Free now gets a real Finish
  button, and finishing shows the essay back — the same shape
  components/speaking/SpeakingSession.tsx already settled on for its own
  no-AI case, not a new pattern invented for writing.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const source = read("app", "practice", "writing", "page.tsx");

test("finishing without marking is a real state, distinct from a graded one", () => {
  assert.match(source, /const \[finished, setFinished\] = useState\(false\);/);
  assert.match(source, /function finishWithoutMarking\(\)/);
  // Discards the draft the same way a graded submit does — this really is
  // the end of the sitting, not a checkpoint to resume.
  const fn = source.slice(source.indexOf("function finishWithoutMarking"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /discardWritingDraft\(task\.id\);/);
  assert.match(body, /setFinished\(true\);/);
  // And it never calls the model — there is nothing to mark this on.
  assert.doesNotMatch(body, /postJSON|grade\/writing/);
});

test("resetting a task clears the finished flag along with grade and error", () => {
  const fn = source.slice(source.indexOf("const resetTask = ()"));
  const body = fn.slice(0, fn.indexOf("};"));
  assert.match(body, /setFinished\(false\);/);
});

test("the bottom bar offers Finish only before marking and before finishing", () => {
  const bar = source.slice(source.indexOf("bottomLeft={"), source.indexOf("}\n    >"));
  // Order matters: graded/finished share the "More practice / Try again" pair
  // ahead of the marked (Submit) and unmarked (Finish) single-button cases.
  assert.match(bar, /grade \|\| finished \? \(/);
  assert.match(bar, /onClick=\{finishWithoutMarking\}/);
  assert.match(bar, />\s*Finish\s*</);
});

test("the clock stops once the essay is finished, marked or not", () => {
  assert.match(source, /running=\{started && !grade && !finished\}/);
});

test("finishing shows the essay back, with the same upgrade panel speaking uses", () => {
  const view = source.slice(source.indexOf(") : finished ? ("), source.indexOf(") : (\n        /*"));
  assert.match(view, /Essay complete/);
  assert.match(view, /\{essay\}/);
  assert.match(view, /<UpgradePanel feature="have this marked" signedIn=\{account\.signedIn\} tier="ai" \/>/);
  // Nothing is recorded to history from here — no band exists to plot, and a
  // saved history is Tracking's job, not Free's. See tests/history-gate.test.mjs.
  assert.doesNotMatch(view, /addResult/);
});

test("nothing here is enforcement — the server still refuses an unpaid essay", () => {
  // marked only ever gates which button is drawn; requireFeature on
  // app/api/grade/writing/route.ts is what actually stops the call.
  assert.match(
    source,
    /account\.phase !== "ready" \|\| !account\.accountsEnabled \|\| tierShows\(account, "grade-writing"\)/,
  );
});

/*
  The finished screen used to be a one-way door: the essay lived only in this
  component's state, "Try again" cleared it with no confirmation, and there
  was no way to keep a copy of work a Free account cannot have marked or
  saved. These tests are the two ways out of that: a button that copies the
  essay, and a confirmation before the box that holds it is emptied.
*/

test("the finished screen offers to copy the essay, but only where the Clipboard API exists", () => {
  const view = source.slice(source.indexOf(") : finished ? ("), source.indexOf(") : (\n        /*"));
  // Guarded rather than always rendered — an insecure origin or an older or
  // in-app browser has no navigator.clipboard, and a button that fails
  // silently on every tap is worse than no button.
  assert.match(view, /typeof navigator !== "undefined" && navigator\.clipboard/);
  assert.match(view, /onClick=\{\(\) => void copyEssay\(\)\}/);
  assert.match(view, /essayCopied \? "Copied" : "Copy essay"/);
});

test("copyEssay writes the essay to the clipboard and says so briefly, without throwing on a refusal", () => {
  const fn = source.slice(source.indexOf("async function copyEssay"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /await navigator\.clipboard\.writeText\(essay\);/);
  assert.match(body, /setEssayCopied\(true\);/);
  // "Briefly" — the confirmation reverts rather than sticking forever.
  assert.match(body, /window\.setTimeout\(\(\) => setEssayCopied\(false\), 2000\);/);
  // A denied permission is the browser's decision, not a bug to report — the
  // essay is still on screen to select by hand, so nothing here alarms.
  assert.match(body, /\} catch \{/);
});

test("Try again on the finished (unmarked) screen confirms before clearing the essay", () => {
  const bar = source.slice(source.indexOf("bottomLeft={"), source.indexOf("}\n    >"));
  assert.match(
    bar,
    /if \(finished && !window\.confirm\("Start again\? Your essay will be cleared\."\)\) return;/,
  );
  const confirmAt = bar.indexOf("window.confirm(");
  const resetAt = bar.indexOf("resetTask();");
  assert.ok(confirmAt >= 0 && resetAt > confirmAt, "the confirm must guard the reset, not follow it");
});

test("a graded Try again does not ask for confirmation — that essay is already in history", () => {
  // The same button serves both endings (grade || finished ?), and the guard
  // above is deliberately scoped to `finished` alone: a graded essay is
  // already in the history entry submit() records (see addResult there), so
  // there is nothing left for a confirm to protect.
  const bar = source.slice(source.indexOf("bottomLeft={"), source.indexOf("}\n    >"));
  const onClickAt = bar.indexOf("onClick={() => {");
  const tryAgainAt = bar.indexOf("Try again");
  const onClickBody = bar.slice(onClickAt, tryAgainAt);
  assert.match(onClickBody, /if \(finished &&/, "the confirm must be conditioned on `finished`, not on `grade`");
});
