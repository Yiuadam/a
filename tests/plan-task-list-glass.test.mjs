import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const end = css.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${selector} rule`);
  return css.slice(start, end + 2);
}

function maxTransformedOutset(size, inset, drift, stretch) {
  let max = 0;
  for (const pointer of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]) {
    const scale = 1 + Math.abs(pointer) * stretch;
    const origin = size * ((pointer + 1) / 2);
    const start = inset + pointer * drift + origin * (1 - scale);
    const end = start + (size - 2 * inset) * scale;
    max = Math.max(max, -start, end - size);
  }
  return max;
}

test("study-plan overscan is larger than the biggest pointer-stretched glass rim", () => {
  const plan = read("app", "plan", "page.tsx");
  const css = read("app", "globals.css");
  const pointer = read("components", "PointerAttraction.tsx");
  const list = plan.match(/<ul\s+className="([^"]*\bplan-task-list\b[^"]*)"/);

  assert.ok(list, "plan tasks need a named scroll-list boundary");
  assert.match(list[1], /\bspace-y-1\.5\b/);

  const scrollport = rule(css, ".plan-task-list");
  const glass = rule(css, ".refractive-glass-layer");

  /*
    A translated/scaled refractive child needs room to move before it reaches
    the scrollport's clipping edge. The shared pointer lens moves at most
    3.2px, and the layer itself overscans by 1px, so this half-rem (8px at the
    root size) inset remains safely larger without changing the task column's
    layout width.
  */
  assert.match(scrollport, /--plan-task-lens-overscan:\s*0\.5rem\s*;/);
  assert.match(scrollport, /box-sizing:\s*border-box\s*;/);
  assert.match(
    scrollport,
    /max-height:\s*calc\(9\.5rem\s*\+\s*var\(--plan-task-lens-overscan\)\s*\+\s*var\(--plan-task-lens-overscan\)\)\s*;/,
  );
  assert.match(scrollport, /margin:\s*calc\(0px\s*-\s*var\(--plan-task-lens-overscan\)\)\s*;/);
  assert.match(scrollport, /padding:\s*var\(--plan-task-lens-overscan\)\s*;/);
  assert.match(
    scrollport,
    /padding-right:\s*calc\(var\(--plan-task-lens-overscan\)\s*\+\s*0\.25rem\)\s*;/,
  );
  assert.match(scrollport, /overflow-y:\s*auto\s*;/);
  assert.match(scrollport, /overflow-x:\s*hidden\s*;/);
  assert.match(scrollport, /scroll-padding-block:\s*var\(--plan-task-lens-overscan\)\s*;/);
  assert.doesNotMatch(scrollport, /overflow\s*:\s*visible\s*;/);
  assert.match(glass, /inset:\s*-1px\s*;/);
  assert.match(pointer, /const drift = icon \? 3\.2 : 2\.2;/);
  assert.match(pointer, /const stretch = icon \? 0\.012 : 0\.006;/);

  /*
    The broadest eligible ordinary control is 560px. Check the stronger icon
    response too, so a future use of it in the plan list cannot turn the
    scrollport's gutter back into a visibly sliced rim. `0.5rem` is 8px at
    the app's normal 16px root size; the layer's -1px base overscan is part of
    the calculation rather than an untested assumption.
  */
  const lensGutterPx = 8;
  const layerInsetPx = -1;
  const genericOutset = Math.max(
    maxTransformedOutset(560, layerInsetPx, 2.2, 0.006),
    maxTransformedOutset(190, layerInsetPx, 2.2, 0.006),
  );
  const iconOutset = Math.max(
    maxTransformedOutset(560, layerInsetPx, 3.2, 0.012),
    maxTransformedOutset(190, layerInsetPx, 3.2, 0.012),
  );

  assert.ok(genericOutset < lensGutterPx, `generic lens needs ${genericOutset}px`);
  assert.ok(iconOutset < lensGutterPx, `icon lens needs ${iconOutset}px`);
});
