import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

test("lookup windows settle their glass rim without stretching text or using the pointer", () => {
  const lookup = read("components/Lookup.tsx");
  const css = read("app/globals.css");

  assert.match(lookup, /liquid-glass-window[\s\S]*?panelIsClosing/);
  assert.match(lookup, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(css, /\.liquid-glass-window::after[\s\S]*?liquid-glass-window-settle/);
  assert.match(css, /\.liquid-glass-window > \* \{[\s\S]*?z-index: 1/);
  assert.match(css, /@keyframes liquid-glass-window-close/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.liquid-glass-window/);
  assert.doesNotMatch(css, /liquid-glass-window[\s\S]{0,500}pointermove/);
});
