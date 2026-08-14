import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { lookupSelectionAnchor } = await import(
  pathToFileURL(join(process.cwd(), "lib", "lookup-selection-anchor.ts")).href,
);

const lookup = readFileSync(join(process.cwd(), "components", "Lookup.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

test("selection lookup trigger stays above the selected word without edge avoidance", () => {
  assert.deepEqual(
    lookupSelectionAnchor({ left: 9, top: 248, width: 34 }),
    { x: 26, y: 248 },
  );
  assert.deepEqual(
    lookupSelectionAnchor({ left: -6, top: 71, width: 16 }),
    { x: 2, y: 71 },
    "near-edge words must keep their real geometric anchor instead of jumping right",
  );

  assert.match(lookup, /const anchor = lookupSelectionAnchor\(rect\)/);
  assert.match(lookup, /\.\.\.anchor,[\s\S]*text: clean/);
  assert.doesNotMatch(
    lookup,
    /Math\.min\(window\.innerWidth - 110, Math\.max\(110, rect\.left \+ rect\.width \/ 2\)\)/,
  );
});

test("selection lookup trigger is a static annotation, not an attracted glass control", () => {
  const triggerStart = lookup.indexOf("className=\"lookup-selection-pill");
  const trigger = lookup.slice(Math.max(0, triggerStart - 900), triggerStart + 360);

  assert.notEqual(triggerStart, -1, "the selection trigger needs its static positioning class");
  assert.doesNotMatch(trigger, /data-pointer-attract|refractive-glass-layer|premade-glass/);
  assert.match(css, /\.lookup-selection-pill\s*\{\s*translate: -50% calc\(-100% - 0\.5rem\);\s*\}/);
  const pillRule = css.match(/\.lookup-selection-pill\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(pillRule, /scale|transition|--pointer-/);
});
