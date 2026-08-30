import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../scripts/ts-resolve.mjs", import.meta.url);

const glassRefractionModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "glass-refraction.ts")).href,
);

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const filter = readFileSync(join(process.cwd(), "components", "GlassRefractionFilter.tsx"), "utf8");

function pixel(map, size, x, y) {
  const index = (y * size + x) * 4;
  return Array.from(map.slice(index, index + 4));
}

test("the glass displacement map keeps its centre optically flat", () => {
  const size = 64;
  const map = glassRefractionModule.createGlassRefractionMap(size);
  assert.deepEqual(pixel(map, size, 32, 32), [128, 128, 128, 255]);
});

test("the glass displacement map bends each edge outward and remains symmetric", () => {
  const size = 64;
  const map = glassRefractionModule.createGlassRefractionMap(size);
  const left = pixel(map, size, 2, 32);
  const right = pixel(map, size, 61, 32);
  const top = pixel(map, size, 32, 2);
  const bottom = pixel(map, size, 32, 61);

  assert.ok(left[0] < 128, "left edge should bend left");
  assert.ok(right[0] > 128, "right edge should bend right");
  assert.ok(top[1] < 128, "top edge should bend up");
  assert.ok(bottom[1] > 128, "bottom edge should bend down");
  assert.equal(128 - left[0], right[0] - 128);
  assert.equal(128 - top[1], bottom[1] - 128);
});

test("live panels use the SVG displacement filter only after browser capability detection", () => {
  assert.match(filter, /Safari parses[\s\S]*?false positive/);
  assert.match(filter, /Chromium\|Google Chrome\|Microsoft Edge\|Opera/);
  assert.match(filter, /primitiveUnits="objectBoundingBox"/);
  assert.match(filter, /scale="0\.09"/);
  assert.match(filter, /CSS\.supports\([\s\S]*?backdrop-filter[\s\S]*?url\(#\$\{FILTER_ID\}\)/);
  assert.match(filter, /supportsDetailedLiveRefraction/);
  assert.match(filter, /supportsDetailedGlass/);
  assert.match(filter, /GLASS_PERFORMANCE_QUERY/);
  assert.match(filter, /connection\?\.saveData/);
  assert.match(filter, /document\.documentElement\.dataset\.liveGlassRefraction/);
  assert.match(filter, /<feDisplacementMap[\s\S]*?in2="glass-normal-map"/);
  assert.match(css, /html\[data-live-glass-refraction\] \.liquid-glass,[\s\S]*?blur\(8px\)[\s\S]*?url\("#bandup-live-glass-refraction"\)/);
  // The sheet itself (.nav-paper) no longer carries its own refraction —
  // only the .nav-menu-group cards it holds do, via the generic rule above.
  // A second, much bigger lens wrapping the whole viewport double-refracted
  // whatever showed through a card and scattered visible squiggles across
  // page content in the gaps between cards.
  assert.doesNotMatch(css, /html\[data-live-glass-refraction\] \.nav-paper \{/);
});
