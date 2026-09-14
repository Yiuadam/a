/*
  Finishing a practice paper used to leave the reader exactly where they were
  scrolled to while answering — often the last question or the last
  paragraph, well past the band and the review that explain it. Listening
  already had this fixed (see the "submitting resets the paper's own scroll"
  test in tests/exam-shell-top-summary.test.mjs); this file covers the same
  fix landing on Reading, on the two shared exam panes reading depends on,
  and on Speaking's own result stage — plus Review's new bandBadge slot,
  which listening now uses instead of laying its own BandBadge out by hand.

  Writing is deliberately absent from this file. The practice and feedback
  panels used to be the same reused component instance at two different
  moments, which is what a stale scroll position needs to survive between
  them — but writing's mobile layout has since been rebuilt around a single
  SwipePanels track used unconditionally (see tests/writing-mobile-layout.test.mjs,
  which now asserts WritingMobilePanels is gone for good). Grade appearing
  swaps the whole subtree from a <div>/<SplitPanes> to a bare <SwipePanels> —
  a different element type in the same slot — so React discards the old DOM
  and mounts the feedback panels fresh rather than reusing a scrolled one.
  There is nothing left to reset. /practice/writing is also one of the
  viewport-locked routes now (see body[data-viewport-locked] in
  app/globals.css), so a plain window.scrollTo would not have had anything
  to scroll even if the old bug still existed.

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
  assert.match(splitPanes, /resetScrollKey\?: unknown;/);
  assert.match(splitPanes, /leftPane\.current\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(splitPanes, /rightPane\.current\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(splitPanes, /\}, \[resetScrollKey\]\);/);
  assert.match(splitPanes, /<div\s*\n\s*ref=\{leftPane\}/);
  assert.match(splitPanes, /<div ref=\{rightPane\}/);

  const swipePanels = read("components", "exam", "SwipePanels.tsx");
  assert.match(swipePanels, /resetScrollKey\?: unknown;/);
  assert.match(swipePanels, /for \(const panel of panelRefs\.current\) panel\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(swipePanels, /\}, \[resetScrollKey\]\);/);
});

test("reading resets its own scrolling pane and both SplitPanes/SwipePanels panes, keyed to submitted", () => {
  const reading = read("app", "practice", "reading", "page.tsx");

  // /practice/reading is viewport-locked (body is overflow:hidden), so the
  // window itself never scrolls — the page's own outer div has to be the
  // scrolling pane, the same way listening's paperScrollRef is.
  assert.match(reading, /const pageRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(reading, /if \(submitted\) pageRef\.current\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(reading, /ref=\{pageRef\}[\s\S]{0,80}overflow-y-auto/);

  assert.match(reading, /<SplitPanes[\s\S]*?resetScrollKey=\{submitted\}/);
  assert.match(reading, /<SwipePanels[\s\S]*?resetScrollKey=\{submitted\}/);
});

test("speaking scrolls the document to the result stage, since /speaking is not one of the viewport-locked exam routes", () => {
  const session = read("components", "speaking", "SpeakingSession.tsx");
  assert.match(session, /if \(stage === "result"\) window\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(session, /\}, \[stage\]\);/);

  const appMain = read("components", "AppMain.tsx");
  assert.doesNotMatch(appMain, /pathname === "\/speaking"/);
});

test("listening's band now travels through Review's own bandBadge slot", () => {
  const listening = read("app", "practice", "listening", "page.tsx");
  assert.match(
    listening,
    /<Review\s*\n\s*bandBadge=\{\s*\n\s*<BandBadge band=\{band\} caption=\{`\$\{raw\}\/\$\{questionCount\(test\.questions\)\} correct`\} \/>\s*\n\s*\}/,
  );
  // The old hand-rolled grid is gone — Review draws it now.
  assert.doesNotMatch(listening, /grid gap-4 lg:grid-cols-\[auto_1fr\]/);
});

test("Review lays a bandBadge beside the advice card when given one, and closes each mistake by default", () => {
  const review = read("components", "Review.tsx");
  assert.match(review, /bandBadge\?: ReactNode;/);
  assert.match(review, /bandBadge \? \(\s*<div className="grid gap-4 lg:grid-cols-\[auto_1fr\]">/);
  // No bandBadge: the advice card alone, same as every page that hasn't
  // adopted the prop yet (reading, placement, the mock reports).
  assert.match(review, /\) : \(\s*adviceCard\s*\)\}/);

  // <details> with no `open` attribute starts closed — no state array keyed
  // by item id needed for that.
  assert.match(review, /<details className="group rounded-xl border border-slate-200 bg-surface open:pb-4">/);
  assert.doesNotMatch(review, /<details[^>]*\sopen(\s|>)/);
});
