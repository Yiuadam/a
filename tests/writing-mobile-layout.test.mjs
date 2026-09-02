import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

/*
  This file used to assert the opposite of what it asserts now, and the reversal
  is the point. Writing stacked its task, figure and answer down one scrolling
  column because the shared swipe track spent 68px of a 390px phone advertising
  itself; once that came down to a sliver the stack was costing a candidate the
  prompt every time they wrote a sentence. Writing now uses the same switcher
  reading does, and what these tests hold is that it is the *same* one — a
  second horizontal track with its own idea of a pane width is how the two
  papers drift apart again.
*/
test("writing chooses its panes with the same switcher reading uses", () => {
  const writing = read("app", "practice", "writing", "page.tsx");
  const reading = read("app", "practice", "reading", "page.tsx");
  const panels = read("components", "exam", "SwipePanels.tsx");

  for (const page of [writing, reading]) {
    assert.match(page, /import SwipePanels(,| from) /);
    assert.match(page, /<SwipePanels\s+(key=\{[^}]+\}\s+)?panels=/);
  }

  /* The switcher and the track both come from the shared component. */
  assert.match(panels, /role="tablist"/);
  assert.match(panels, /role="tab"/);
  assert.match(panels, /snap-x snap-mandatory/);
  assert.match(panels, /inline: "center"/);

  /* Narrow practice writing: the task, the figure and the answer as panes. */
  assert.match(writing, /\{ label: "Task", content: prompt \}/);
  assert.match(writing, /\{ label: "Source", content: visual \}/);
  assert.match(writing, /\{ label: "Response", content: response \}/);
  assert.match(writing, /<SwipePanels panels=\{practicePanels\} \/>/);

  /* Marked feedback is the same panes at every width, wide or narrow. */
  assert.match(writing, /grade \? \(\s*<SwipePanels panels=\{feedbackPanels\} \/>/);

  /* Above `lg` the independent split panes are still what writing gets. */
  assert.match(writing, /<SplitPanes className="h-full" initial=\{48\} left=\{source\} right=\{response\} \/>/);

  /* The stacked phone flow is gone rather than left behind unused. */
  assert.doesNotMatch(writing, /WritingMobilePanels|data-writing-mobile-panel/);
});

/*
  The one thing the reading papers never had to answer for: a pane holding a
  textarea. This file asserted the opposite of what it asserts now, and the
  reversal was the owner's call rather than a drift. Both essays were restricted
  to vertical panning so that a thumb resting on the text and drifting a few
  degrees off vertical could not snap the pane away mid-sentence; what that cost
  was the reason the panes exist at all, because a candidate re-reads the task
  constantly while composing and had to find a gap in the page before the swipe
  would take them there.

  So the swipe now works from inside the editor, on the practice paper and the
  mock alike. The caret, the selection and the essay's own vertical scrolling
  are untouched — the class only ever governed which directions the browser
  would pan from this element.
*/
test("the swipe track reaches into the essay on both writing papers", () => {
  /* The comments above these elements discuss the class they no longer set. */
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const writing = code(read("app", "practice", "writing", "page.tsx"));
  const mock = code(read("components", "exam", "MockWriting.tsx"));

  assert.match(writing, /id="writing-response"/);
  assert.match(mock, /id="mock-essay"/);
  assert.doesNotMatch(writing, /touch-pan-y/);
  assert.doesNotMatch(mock, /touch-pan-y/);
});

test("the mock writing paper switches panes on a phone and keeps its desktop column", () => {
  const mock = read("components", "exam", "MockWriting.tsx");

  assert.match(mock, /import SwipePanels, \{ type SwipePanel \}/);
  assert.match(mock, /const wide = useIsWide\(\);/);
  assert.match(mock, /\{ label: "Task", content: /);
  assert.match(mock, /\{ label: "Response", content: answer \}/);

  /*
    Keyed on the task, so Task 1 → Task 2 lands on the new prompt rather than on
    an empty answer box. Everything worth keeping is held outside the component
    — the essays in the stored session, the clock as an absolute deadline — so
    the only state a remount drops is which pane was showing.
  */
  assert.match(mock, /<SwipePanels key=\{task\.id\} panels=\{panels\} \/>/);

  /* Above `lg` there is room for prompt and answer at once, and it is unchanged. */
  assert.match(mock, /wide \? \(\s*<div className="min-h-0 flex-1 overflow-y-auto">/);
  assert.match(mock, /wide \? "h-72 resize-y" : "min-h-48 flex-1 resize-none"/);

  /* One textarea, or two elements would answer to the same id and label. */
  assert.equal(mock.match(/id="mock-essay"/g).length, 1);
});

test("writing opts into an edge-to-edge phone shell without changing other papers", () => {
  const writing = read("app", "practice", "writing", "page.tsx");
  const shell = read("components", "exam", "ExamShell.tsx");

  assert.match(writing, /comfortableGutter\s+edgeToEdgeOnPhone/);
  assert.match(writing, /className="px-0 pt-0 sm:px-4 sm:pt-4"/);
  assert.match(shell, /edgeToEdgeOnPhone = false/);
  assert.match(shell, /m-0 h-\[calc\(100dvh-4rem\)\] w-full/);
  assert.match(shell, /rounded-none border-0 shadow-none sm:rounded-2xl sm:border/);
  /*
    The block half of this is tighter than the inline half on a phone, and
    deliberately: a paper with no frame around it has the header pill above and
    the question strip below, both of which draw their own edge, so the inset
    only has to keep them apart rather than stand a border off the window.
  */
  assert.match(shell, /edgeToEdgeOnPhone \? "px-2 py-1 sm:px-4 sm:py-2"/);

  for (const viewport of [320, 390, 430]) {
    const paperWidth = viewport - 16;
    assert.ok(paperWidth >= 304, `${viewport}px leaves ${paperWidth}px for the writing paper`);
  }

  /*
    Both reading papers opt in as well now, for the reason the prop was written
    for: they nest one level deeper than writing does, so the frame was the
    layer costing the most and buying the least on a phone.

    Listening is the one paper that keeps the frame, and that is checked rather
    than assumed. It has no swipe panel — its forty questions are one scrolling
    column — so it never had the nesting the others did, and a module quietly
    losing its frame is exactly the kind of drift this file exists to catch.
  */
  assert.match(read("components", "exam", "MockReading.tsx"), /^\s*edgeToEdgeOnPhone$/m);
  assert.match(read("app", "practice", "reading", "page.tsx"), /^\s*edgeToEdgeOnPhone$/m);
  /*
    The mock writing paper joins them, because it now nests the same way: below
    `lg` its task and its answer sit in a swipe panel, so a phone was paying for
    a frame, a paper inset and a panel inset before the prompt was laid out.
  */
  assert.match(read("components", "exam", "MockWriting.tsx"), /^\s*edgeToEdgeOnPhone$/m);
  assert.doesNotMatch(read("components", "exam", "MockListening.tsx"), /edgeToEdgeOnPhone/);
});

test("writing figures fit the phone paper instead of creating a horizontal scroller", () => {
  const writing = read("app", "practice", "writing", "page.tsx");

  assert.match(writing, /max-w-full sm:overflow-x-auto/);
  assert.match(writing, /table-fixed border-collapse leading-normal sm:table-auto/);
  assert.match(writing, /fontSize: "clamp\(0\.75rem, 3\.5vw, 0\.875rem\)"/);
  assert.match(writing, /break-words border border-slate-300 bg-slate-100 px-0\.5/);
  assert.match(writing, /Agriculture: "Agric\."/);
  assert.match(writing, /Households: "Homes"/);
  assert.match(writing, /aria-label=\{heading\}/);
  assert.match(writing, /whitespace-pre-line break-words/);
});
