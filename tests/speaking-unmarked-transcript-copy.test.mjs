/*
  The speaking half of the same "losing work" problem writing-unmarked-finish
  fixes for its own paper: once an interview ends unmarked — no AI plan, or
  marking that failed — the transcript sits in this component's state and
  "Take another interview" throws it away with nothing kept. This is the one
  way out: a button that copies the transcript to the clipboard, scoped to
  the "unmarked" stage the same audit found it missing from.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const source = readFileSync(join(root, "components", "speaking", "SpeakingSession.tsx"), "utf8");

/*
  The "unmarked" stage's own return block, sliced between its `if` and the
  next stage's — the same technique tests/writing-unmarked-finish.test.mjs
  uses for its "finished" branch, so a future edit that moves this button
  outside the branch it belongs to fails a test rather than a review.
*/
const view = source.slice(
  source.indexOf('\n  if (stage === "unmarked")'),
  source.indexOf('\n  if (stage === "grading")'),
);

test("the unmarked screen still shows the transcript and the upgrade panel it always has", () => {
  assert.ok(view.length > 0, "the unmarked branch must be found between the two stage checks");
  assert.match(view, /Interview complete/);
  assert.match(view, /Your transcript/);
  assert.match(view, /<UpgradePanel feature="have this marked" signedIn=\{account\.signedIn\} tier="ai" \/>/);
});

test("Copy transcript exists only where the Clipboard API does", () => {
  // Guarded rather than always rendered — an insecure origin or an older or
  // in-app browser has no navigator.clipboard, and a button that fails
  // silently on every tap is worse than no button (the same rule
  // app/practice/writing/page.tsx's Copy essay button follows).
  assert.match(view, /typeof navigator !== "undefined" && navigator\.clipboard/);
  assert.match(view, /transcriptCopied \? "Copied" : "Copy transcript"/);
});

test("copying joins the transcript in speaker order and says so briefly, without throwing on a refusal", () => {
  assert.match(
    view,
    /t\.role === "examiner" \? "Examiner" : "You"/,
    "the copied text should read the same as the transcript already on screen",
  );
  assert.match(view, /await navigator\.clipboard\.writeText\(text\);/);
  assert.match(view, /setTranscriptCopied\(true\);/);
  // "Briefly" — the confirmation reverts rather than sticking forever.
  assert.match(view, /window\.setTimeout\(\(\) => setTranscriptCopied\(false\), 2000\);/);
  // A denied permission is the browser's decision, not a bug to report — the
  // transcript is still on screen to select by hand, so nothing here alarms.
  assert.match(view, /\} catch \{/);
});

test("transcriptCopied is declared once, alongside its neighbours, because a hook cannot live inside the branch that reads it", () => {
  const declaredAt = source.indexOf("const [transcriptCopied, setTranscriptCopied] = useState(false);");
  const unmarkedAt = source.indexOf('if (stage === "unmarked")');
  assert.ok(declaredAt >= 0, "transcriptCopied must be declared with useState");
  assert.ok(declaredAt < unmarkedAt, "the hook must be declared before any conditional return, not inside one");
});

test("nothing else in the unmarked branch changed — the same retry, restart and back-to-plan actions remain", () => {
  assert.match(view, /onClick=\{\(\) => void gradeInterview\(transcript\)\}/);
  assert.match(view, /Retry marking/);
  assert.match(view, /onClick=\{\(\) => setStage\("intro"\)\}/);
  assert.match(view, /Take another interview/);
  assert.match(view, /Back to my plan/);
});
