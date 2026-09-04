import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile("components/TestChooser.tsx", "utf8");

test("reading and listening paper libraries scroll inside the locked viewport", () => {
  assert.match(source, /data-paper-chooser/);
  assert.match(source, /h-full[^\"]*overflow-y-auto/);
});

/*
  And every page opens at the top of that scroller.

  The body is held still on almost every route (`data-viewport-locked`), so the
  thing that scrolls is a container inside the page rather than the page — and
  no browser resets those. React reuses the DOM node when two routes draw the
  same component, which Reading and Listening both do here, so a library left
  half way down opened the next one half way down, with the heading above the
  top of the screen. On iOS that is the worse half of the bug: tapping the
  clock scrolls the window, the window has nothing to scroll, and the one
  gesture everybody reaches for does nothing at all.
*/
const shell = await readFile("components/AppMain.tsx", "utf8");

test("every route change puts the page back to the top", () => {
  const effects = shell.slice(shell.indexOf("useEffect"));
  assert.match(effects, /window\.scrollTo\(0, 0\)/);

  // The inner containers too, not only the window - that is the whole point.
  assert.match(effects, /querySelectorAll<HTMLElement>\("\*"\)/);
  assert.match(effects, /element\.scrollTop = 0/);
  assert.match(effects, /main\.scrollTop = 0/);

  // Keyed on the route, so it runs on every navigation rather than once.
  const reset = shell.slice(shell.indexOf("window.scrollTo(0, 0)"));
  assert.match(reset.slice(0, reset.indexOf("}, [") + 40), /\}, \[pathname\]\);/);
});
