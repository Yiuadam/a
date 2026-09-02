import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("writing uses a full-width vertical paper on narrow screens", () => {
  const writing = read("app", "practice", "writing", "page.tsx");

  assert.match(writing, /function WritingMobilePanels/);
  assert.match(writing, /data-writing-mobile-panels/);
  assert.match(writing, /overflow-x-hidden overflow-y-auto/);
  assert.match(writing, /data-writing-mobile-panel=\{panel\.label\.toLowerCase\(\)\}/);
  assert.match(writing, /className="w-full min-w-0 py-4/);
  assert.match(writing, /wide \? <SwipePanels panels=\{feedbackPanels\} \/> : <WritingMobilePanels panels=\{feedbackPanels\} \/>/);
  assert.match(writing, /<WritingMobilePanels[\s\S]*panels=\{practicePanels\}/);

  const phoneLayout = writing.slice(
    writing.indexOf("function WritingMobilePanels"),
    writing.indexOf("function WritingSession"),
  );
  assert.doesNotMatch(phoneLayout, /snap-x|overflow-x-auto|scrollIntoView/);
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
