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
  assert.match(writing, /<SwipePanels panels=\{feedbackPanels\} \/>/);
  // key="graded" forces a fresh instance rather than an update to the
  // practice view's, so the feedback view never opens scrolled to wherever
  // the essay was last scrolled while writing it.
  assert.match(writing, /<WritingMobilePanels key="graded" panels=\{feedbackPanels\} \/>/);
  assert.match(writing, /<WritingMobilePanels\s*\n\s*key="practice"[\s\S]*panels=\{practicePanels\}/);

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
  assert.match(shell, /edgeToEdgeOnPhone \? "px-2 py-2 sm:px-4"/);

  for (const viewport of [320, 390, 430]) {
    const paperWidth = viewport - 16;
    assert.ok(paperWidth >= 304, `${viewport}px leaves ${paperWidth}px for the writing paper`);
  }
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
