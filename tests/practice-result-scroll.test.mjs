/*
  Finishing a practice paper used to leave the reader exactly where they
  were scrolled to while answering — often the last question or the last
  paragraph, well past the band and the review that explain it. Each
  practice page resets whatever it actually scrolls back to the top the
  moment a result appears, so the mark and the review are the first thing
  on screen rather than something to go looking for.

  Nothing here can render a page, so — same shape as tests/pricing-currency.test.mjs
  for the same reason — these are checks against the source: the effect
  exists, is keyed on the right state, and targets the pane that actually
  scrolls on each page.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("SplitPanes and SwipePanels can reset both/every pane's own scroll on demand", () => {
  const splitPanes = read("components", "exam", "SplitPanes.tsx");
  assert.match(splitPanes, /resetScrollKey/);
  assert.match(splitPanes, /leftPane\.current\?\.scrollTo\(\{ top: 0 \}\)/);
  assert.match(splitPanes, /rightPane\.current\?\.scrollTo\(\{ top: 0 \}\)/);

  const swipePanels = read("components", "exam", "SwipePanels.tsx");
  assert.match(swipePanels, /resetScrollKey/);
  assert.match(swipePanels, /for \(const panel of panelRefs\.current\) panel\?\.scrollTo\(\{ top: 0 \}\)/);
});

test("listening resets its own paper pane and the window when submitted", () => {
  const listening = read("app", "practice", "listening", "page.tsx");
  assert.match(listening, /const paperRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(listening, /ref=\{paperRef\} className="min-h-0 flex-1 overflow-y-auto" data-listening-paper/);
  assert.match(listening, /if \(submitted\) \{\s*paperRef\.current\?\.scrollTo\(\{ top: 0 \}\);\s*window\.scrollTo\(\{ top: 0 \}\);/);
});

test("reading resets both SplitPanes/SwipePanes panes and its own scrolling pane, keyed to submitted", () => {
  const reading = read("app", "practice", "reading", "page.tsx");
  assert.match(reading, /<SplitPanes[\s\S]*?resetScrollKey=\{submitted\}/);
  assert.match(reading, /<SwipePanels[\s\S]*?resetScrollKey=\{submitted\}/);
  // /practice/reading is viewport-locked (body is overflow:hidden), so the
  // window itself never scrolls — the page's own outer div has to be the
  // scrolling pane, the same way listening's paperRef is.
  assert.match(reading, /const pageRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(reading, /if \(submitted\) pageRef\.current\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(reading, /ref=\{pageRef\}[\s\S]*?overflow-y-auto/);
});

test("writing remounts the mobile feedback panels fresh, and scrolls the document when graded", () => {
  const writing = read("app", "practice", "writing", "page.tsx");
  // A key change forces React to discard the practice view's scroll state
  // rather than update it in place — the practice and feedback panels are
  // the same component at the same position in the tree, so without a key
  // difference React would carry the old scrollTop straight into the new
  // content.
  assert.match(writing, /<WritingMobilePanels key="graded" panels=\{feedbackPanels\} \/>/);
  assert.match(writing, /<WritingMobilePanels\s*\n\s*key="practice"/);
  assert.match(writing, /if \(grade\) window\.scrollTo\(\{ top: 0 \}\);/);
});

test("speaking scrolls the document to the result stage, since /speaking is not one of the viewport-locked exam routes", () => {
  const session = read("components", "speaking", "SpeakingSession.tsx");
  assert.match(session, /if \(stage === "result"\) window\.scrollTo\(\{ top: 0 \}\);/);

  const appMain = read("components", "AppMain.tsx");
  assert.doesNotMatch(appMain, /pathname === "\/speaking"/);
});
