/*
  The band and raw score, moved from the bottom of a marked paper to the top.

  Reported directly, with a screenshot: after finishing a listening test, the
  only place the band showed was a small bar pinned to the bottom of the exam
  frame — easy to miss next to the per-question detail, and the page's own
  BandBadge card (further down, inside the scrolling paper) is wherever the
  candidate happened to have scrolled to when they hit submit, which for
  anyone finishing on the last question is nowhere near visible.

  The header does not have that problem: it does not scroll with the paper,
  so whatever it shows is on screen regardless of where the candidate is in
  the review below. `topSummary` puts the score there, under the paper title,
  and only once a page actually has one to show.

  That alone still left the paper itself wherever it was scrolled to, so a
  second, more literal report followed: the result page should scroll to the
  top on every submission. Listening's own scrolling div now does exactly
  that. A third report, on a screenshot with the header circled, asked for
  padding — the new third line had been given none of its own, so it sat
  flush against the paper title above it.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const shell = read("components", "exam", "ExamShell.tsx");
const listening = read("app", "practice", "listening", "page.tsx");

test("ExamShell takes an optional topSummary and renders it under the paper title, with room to breathe", () => {
  assert.match(shell, /topSummary\?: ReactNode;/);
  assert.match(shell, /topRight,\s*\n\s*topSummary,/);

  const header = shell.slice(shell.indexOf("<header"), shell.indexOf("</header>"));
  assert.match(
    header,
    /\{topSummary && \(\s*<div className="mt-1 whitespace-nowrap font-semibold text-\[color:var\(--exam-accent\)\]">\s*\{topSummary\}/,
  );

  /* Under the paper title, not above it or beside the timer — it belongs to
     the same block that already says which paper this is. And with its own
     top margin: the section label and paper title above it were already
     leading-tight, which read fine as two lines but crammed a third against
     the second with no gap at all — reported directly, from a screenshot with
     the header circled. */
  const sectionBlockStart = header.indexOf('className="exam-section-block');
  const paperTitleAt = header.indexOf("exam-paper-title", sectionBlockStart);
  const topSummaryAt = header.indexOf("topSummary && (", sectionBlockStart);
  assert.ok(paperTitleAt > -1 && topSummaryAt > paperTitleAt, "topSummary should render after the paper title");
});

test("the bottom bar disappears entirely once neither side has anything to show", () => {
  /*
    Before: the palette-empty branch always rendered the bar, so a page that
    stopped passing bottomLeft/bottomRight got an empty strip of chrome for no
    reason. Now the bar is opt-in on the content itself — Writing (which
    always has both) and Reading (which still passes bottomLeft) are
    unaffected; Listening, once it moved its score to the header, gets no bar
    at all rather than an empty one.
  */
  assert.match(shell, /\) : bottomLeft \|\| bottomRight \? \(/);
  assert.match(shell, /<div className="min-w-0">\{bottomLeft\}<\/div>\s*<div className="shrink-0">\{bottomRight\}<\/div>\s*<\/div>\s*\) : null\}/);
});

test("listening passes its score as topSummary and no longer duplicates it at the bottom", () => {
  assert.match(
    listening,
    /topSummary=\{submitted && band !== null \? `Band \$\{band\} · \$\{raw\}\/\$\{flat\.length\}` : undefined\}/,
  );
  assert.doesNotMatch(listening, /bottomLeft=/);
});

test("submitting resets the paper's own scroll, not just what the header shows", () => {
  /*
    The header fix alone still leaves the *paper* wherever the candidate was
    reading it — question 9, question 10 — because the scrolling element is
    the paper's own div, not the window. Reported again, directly: "the
    result page should be scrolled to the top every time i submit". A ref on
    that div and an effect keyed on `submitted` is the only way to reach it;
    nothing about becoming submitted otherwise touches scroll position.
  */
  assert.match(listening, /const paperScrollRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(listening, /<div ref=\{paperScrollRef\} className="min-h-0 flex-1 overflow-y-auto" data-listening-paper>/);

  const effect = listening.slice(listening.indexOf("if (!submitted) return;\n    paperScrollRef.current"));
  assert.match(effect, /paperScrollRef\.current\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(effect, /\}, \[submitted\]\);/);

  /* Instant, not scrollBehaviour()'s smooth — the content above the target
     is itself still changing shape (palette gone, band card and every
     explanation newly mounted) when this fires, so animating toward a
     position that keeps moving would look worse than not animating at all. */
  assert.doesNotMatch(effect.slice(0, 200), /behavior: "smooth"|scrollBehaviour\(\)/);
});
