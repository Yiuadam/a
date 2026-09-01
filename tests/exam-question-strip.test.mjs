/*
  The strip of question numbers along the bottom of an exam.

  Two things about it are easy to break without noticing, because both fail
  quietly and only on a real paper being scrolled by a real person.

  The first is the rule that decides which number is lit. It has to be the
  question at the reading line, it has to survive two cards crossing that line
  at once, and it has to stop believing the observer while a scroll the app
  itself started is still running — otherwise pressing 23 walks the highlight
  through every number on the way and stops wherever the animation ended.

  The second is that the line and the jump have to agree. `jump` centres the
  question it scrolls to, so if the band ever moved off the middle of the pane,
  pressing 23 would leave 22 lit the moment the learner scrolled a pixel. That
  is one constant in one file and one option in another, sitting far enough
  apart that nothing but a test connects them.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

const { READING_BAND, SETTLE_MS, furthestInBand, scrollBehaviour, shouldFollow } = await import(
  pathToFileURL(join(process.cwd(), "lib", "exam", "reading-position.ts")).href
);

const paper = new Map(["q1", "q2", "q3", "q4"].map((id, at) => [id, at]));

test("the lit number is the question furthest into the paper at the reading line", () => {
  assert.equal(furthestInBand(["q2"], paper), "q2");

  /*
    Both neighbours cross the band during the handover. Taking the later one is
    what makes the strip move with the scroll rather than a question behind it.
  */
  assert.equal(furthestInBand(["q2", "q3"], paper), "q3");
  assert.equal(furthestInBand(["q3", "q2"], paper), "q3");
});

test("nothing at the reading line leaves the strip where it was", () => {
  /*
    Happens in the gap between two cards and at both ends of the paper. Null
    means "no answer", and the caller holds the last one — blanking the strip
    at every gap would make it flicker all the way down a paper.
  */
  assert.equal(furthestInBand([], paper), null);
});

test("a question from a paper that is no longer open cannot light a number", () => {
  assert.equal(furthestInBand(["from-the-last-paper"], paper), null);
  assert.equal(furthestInBand(["from-the-last-paper", "q1"], paper), "q1");
});

test("the strip does not move before the learner has scrolled anything", () => {
  /*
    An observer reports the state of the page as soon as it is given something
    to watch. At that moment the learner is on question 1 and has done nothing,
    so acting on that first report would move the strip off 1 by itself.
  */
  assert.equal(shouldFollow({ opened: false, now: 5_000, quietUntil: 0 }), false);
  assert.equal(shouldFollow({ opened: true, now: 5_000, quietUntil: 0 }), true);
});

test("a jump holds the strip still until its own scroll has finished", () => {
  const pressedAt = 10_000;
  const quietUntil = pressedAt + SETTLE_MS;

  /* Every question the animation flies past reports itself as reached. */
  assert.equal(shouldFollow({ opened: true, now: pressedAt + 1, quietUntil }), false);
  assert.equal(shouldFollow({ opened: true, now: quietUntil - 1, quietUntil }), false);

  /* And then the learner's own scrolling has to take over again. */
  assert.equal(shouldFollow({ opened: true, now: quietUntil, quietUntil }), true);
  assert.equal(shouldFollow({ opened: true, now: quietUntil + 1, quietUntil }), true);
});

test("the hold is long enough for a smooth scroll and short enough to give back", () => {
  assert.ok(
    SETTLE_MS >= 300,
    `${SETTLE_MS}ms is shorter than a browser's smooth scroll, so the highlight would be dragged along by it`,
  );
  assert.ok(
    SETTLE_MS <= 1200,
    `${SETTLE_MS}ms ignores the learner's own scrolling for most of a second after every press`,
  );
});

test("the reading line is the middle of the pane, which is where a jump puts a question", () => {
  const [top, , bottom] = READING_BAND.split(/\s+/).map((edge) => Number.parseFloat(edge));
  assert.ok(READING_BAND.includes("%"), "the band has to scale with the screen, not be a pixel count");

  /* rootMargin shrinks the root inwards, so a negative top of -45% puts the
     band's upper edge 45% of the way down. */
  const bandTop = -top;
  const bandBottom = 100 + bottom;

  assert.ok(
    bandTop < 50 && bandBottom > 50,
    `the band ${bandTop}%-${bandBottom}% misses the middle, so a jump would centre a question outside it and the strip would light its neighbour`,
  );
  assert.ok(
    bandBottom - bandTop > 0 && bandBottom - bandTop <= 20,
    `a ${bandBottom - bandTop}% band is wide enough for three cards to cross it at once, which is how the highlight starts flickering`,
  );
  assert.ok(bandTop > 5, "a band that reaches the top edge is just 'the topmost question visible'");

  assert.match(read("lib", "exam", "navigation.ts"), /block: "center"/);
});

test("smooth scrolling is dropped for anyone who has asked for less movement", () => {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  const pretend = (reduced) => {
    globalThis.window = { matchMedia: (query) => ({ matches: reduced && query.includes("reduce") }) };
  };

  try {
    pretend(true);
    assert.equal(scrollBehaviour(), "auto");
    pretend(false);
    assert.equal(scrollBehaviour(), "smooth");
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }

  /* Both scrolls this feature causes go through it: the paper's, and the
     strip's own sideways one. */
  assert.match(read("lib", "exam", "navigation.ts"), /behavior: scrollBehaviour\(\)/);
  assert.match(read("components", "exam", "QuestionPalette.tsx"), /behavior: scrollBehaviour\(\)/);
});

test("the reading position is read from the observer, not from scroll arithmetic", () => {
  const source = read("lib", "exam", "reading-position.ts");

  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /rootMargin: READING_BAND, threshold: 0/);
  assert.doesNotMatch(
    source,
    /addEventListener\(\s*"scroll"|scrollTop|onScroll/,
    "measuring scroll offsets runs on the main thread during momentum scrolling, which is where this gets janky",
  );

  /* The cards are found by the anchor they already carry for `jump`. If that
     ever moves, the strip stops following anything at all. */
  assert.match(source, /\[data-question-id="\$\{CSS\.escape\(id\)\}"\]/);
  assert.match(read("components", "TestQuestions.tsx"), /data-question-id=\{q\.id\}/);
});

test("a mock's passage switch does not leave the strip watching cards that are gone", () => {
  const source = read("lib", "exam", "reading-position.ts");

  /*
    A sitting mounts one passage at a time, so thirteen cards are replaced by
    thirteen others while the forty numbers stay exactly as they were. Nothing
    in the palette changes, so only watching the DOM catches it.
  */
  assert.match(source, /new MutationObserver/);
  assert.match(source, /childList: true, subtree: true/);
  assert.match(source, /el\.isConnected/);
  assert.match(source, /observer\.unobserve\(el\)/);
});

test("the strip brings the lit number into its own view without scrolling the page", () => {
  const palette = read("components", "exam", "QuestionPalette.tsx");

  /*
    Forty numbers do not fit across a phone. A strip that lit 23 while showing
    1 to 12 would be lighting nothing the learner can see.
  */
  assert.match(palette, /list\.scrollTo\(\{/);
  assert.match(palette, /\}, \[currentId\]\);/);

  /*
    scrollIntoView would also walk up the tree and scroll whatever ancestors it
    decided needed moving, which on a bar pinned to the bottom of the frame
    means scrolling the paper out from under the learner.
  */
  assert.doesNotMatch(palette, /\.scrollIntoView\(/);

  /* Leaving a number that is already readable exactly where it is. */
  assert.match(palette, /if \(box\.left >= track\.left && box\.right <= track\.right\) return;/);
});

test("explicit navigation still works, and still says which number is current", () => {
  const palette = read("components", "exam", "QuestionPalette.tsx");
  const nav = read("lib", "exam", "navigation.ts");

  assert.match(palette, /onClick=\{\(\) => onJump\(item\.id\)\}/);
  assert.match(palette, /aria-label="Previous question"/);
  assert.match(palette, /aria-label="Next question"/);
  assert.match(palette, /aria-current=\{isCurrent \? "true" : undefined\}/);
  assert.match(palette, /aria-label=\{\s*`Question \$\{item\.number\}`/);

  /* prev and next go through the same jump, so they get the same hold. */
  assert.match(nav, /holdWhileScrolling\(\);/);
  assert.match(nav, /if \(next\) jump\(next\.id\);/);
});

test("the next-hard button is gone from the bar and from every page that built one", () => {
  for (const file of [
    ["components", "exam", "QuestionPalette.tsx"],
    ["components", "exam", "ExamShell.tsx"],
    ["components", "exam", "MockReading.tsx"],
    ["components", "exam", "MockListening.tsx"],
    ["app", "practice", "reading", "page.tsx"],
    ["app", "practice", "listening", "page.tsx"],
    ["lib", "exam", "navigation.ts"],
  ]) {
    const source = read(...file);
    assert.doesNotMatch(source, /Next hard|nextFlagged|NextFlagged/i, file.join("/"));
  }
});

test("marking a question hard still gets you back to it", () => {
  const palette = read("components", "exam", "QuestionPalette.tsx");

  /*
    Removing the button that walked between hard questions only stays harmless
    while the marks themselves remain findable: the number turns blue, the
    strip now scrolls to keep the numbers in view, and one tap on a blue number
    goes there. Take any of those away and marking a question means nothing.
  */
  assert.match(palette, /Mark Q\$\{current\?\.number \?\? ""\} hard/);
  assert.match(palette, /marked hard/);
  assert.match(palette, /aria-pressed=\{current\?\.flagged \?\? false\}/);
  assert.match(palette, /item\.flagged\s*\?\s*"border-\[color:var\(--exam-hard\)\]/);
  assert.match(palette, /\(item\.flagged \? ", marked hard" : ""\)/);
  assert.match(read("lib", "exam", "navigation.ts"), /const toggleReview = useCallback/);
});
