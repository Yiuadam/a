/*
  Two overlays with a backdrop and a close button, and until now no keyboard
  way out: the word-lookup panel (components/Lookup.tsx) and the exam
  display-settings popover (components/exam/ExamSettings.tsx). A mouse or a
  finger could dismiss either; a keyboard user tabbed in had no equivalent
  to the Escape a native dialog would give them.

  Source-level, in keeping with the rest of this suite — both components
  hold their open/closed state in hooks that only run in a browser, so what
  is provable without a DOM is the shape of the effect: it listens only
  while open, calls the same close path the backdrop and the button already
  use, and is torn down again.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const lookup = readFileSync("components/Lookup.tsx", "utf8");
const examSettings = readFileSync("components/exam/ExamSettings.tsx", "utf8");

/* Comments explain the rule; they must not be what satisfies the assertion. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the lookup panel closes on Escape via the same close() the backdrop and ✕ button call", () => {
  const body = code(lookup);
  assert.match(body, /event\.key === "Escape"/, "Lookup.tsx must check for the Escape key");
  assert.match(
    body,
    /if\s*\(event\.key === "Escape"\)\s*close\(\);/,
    "Escape must call the existing close() function, not a new path",
  );
  assert.match(body, /panel\.status === "closed"/, "the Escape listener must be gated by whether the panel is open");
});

test("the lookup panel's Escape listener is added and removed with the panel's open state", () => {
  const body = code(lookup);
  const start = body.indexOf('if (panel.status === "closed") return;');
  assert.notEqual(start, -1);
  const effect = body.slice(start, body.indexOf("}, [panel.status, close]);") + "}, [panel.status, close]);".length);
  assert.match(effect, /document\.addEventListener\(\s*"keydown"/);
  assert.match(effect, /return\s*\(\)\s*=>\s*document\.removeEventListener\(\s*"keydown"/);
});

test("the exam settings popover closes on Escape via the same setOpen(false) the backdrop button calls", () => {
  const body = code(examSettings);
  assert.match(body, /event\.key === "Escape"/, "ExamSettings.tsx must check for the Escape key");
  assert.match(
    body,
    /if\s*\(event\.key === "Escape"\)\s*setOpen\(false\);/,
    "Escape must call the existing setOpen(false), not a new path",
  );
});

test("the exam settings popover's Escape listener is added and removed with open", () => {
  const body = code(examSettings);
  // Locate the specific effect by its own dependency array, since the file
  // has an earlier effect that also depends on [open, display.scheme].
  const effectEnd = body.indexOf("}, [open]);");
  assert.notEqual(effectEnd, -1, "could not find an effect keyed only to [open]");
  const effectStart = body.lastIndexOf("useEffect(", effectEnd);
  const effect = body.slice(effectStart, effectEnd + "}, [open]);".length);
  assert.match(effect, /if\s*\(!open\)\s*return;/, "the Escape listener must be gated by whether the popover is open");
  assert.match(effect, /document\.addEventListener\(\s*"keydown"/);
  assert.match(effect, /return\s*\(\)\s*=>\s*document\.removeEventListener\(\s*"keydown"/);
});
