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

test("the glass bevel follows a lens profile, not an even ramp", () => {
  const size = 64;
  const map = glassRefractionModule.createGlassRefractionMap(size);
  const displacement = (x) => Math.abs(pixel(map, size, x, 32)[0] - 128);

  // A real convex panel turns down hard at the rim and is flat well before
  // the middle. The outer band saturates, so a line of text crossing it
  // visibly bends; by a third of the way in there is nothing left to bend.
  assert.ok(displacement(3) > 120, "the rim should bend at nearly full strength");
  assert.ok(displacement(8) < displacement(3) / 2, "the bend should fall off steeply behind the rim");
  assert.equal(displacement(14), 0, "the pane should be optically flat well before its middle");
});

test("live panels use the SVG displacement filter only after browser capability detection", () => {
  assert.match(filter, /Safari parses[\s\S]*?false positive/);
  assert.match(filter, /Chromium\|Google Chrome\|Microsoft Edge\|Opera/);
  assert.match(filter, /primitiveUnits="objectBoundingBox"/);
  assert.match(filter, /scale="0\.24"/);
  assert.match(filter, /CSS\.supports\([\s\S]*?backdrop-filter[\s\S]*?url\(#\$\{FILTER_ID\}\)/);
  assert.match(filter, /supportsDetailedLiveRefraction/);
  assert.match(filter, /supportsDetailedGlass/);
  assert.match(filter, /GLASS_PERFORMANCE_QUERY/);
  assert.match(filter, /connection\?\.saveData/);
  assert.match(filter, /document\.documentElement\.dataset\.liveGlassRefraction/);
  assert.match(filter, /<feDisplacementMap[\s\S]*?in2="glass-normal-map"/);
  // .nav-menu-group is explicitly excluded from the generic combined-syntax
  // rule — it has its own dedicated lens (see the split-property test below)
  // and matching it here too would stack a second, Chromium-only blur+lens
  // directly on the outer element on top of that.
  assert.match(
    css,
    /html\[data-live-glass-refraction\] \.liquid-glass:not\(\.nav-menu-group\),[\s\S]*?blur\(8px\)[\s\S]*?url\("#bandup-live-glass-refraction"\)/,
  );
  // The sheet itself (.nav-paper) no longer carries its own refraction —
  // only the .nav-menu-group cards it holds do. A second, much bigger lens
  // wrapping the whole viewport double-refracted whatever showed through a
  // card and scattered visible squiggles across page content in the gaps
  // between cards.
  assert.doesNotMatch(css, /html\[data-live-glass-refraction\] \.nav-paper \{/);
});

test("the nav card's own live lens runs through separate filter/backdrop-filter properties, not just Chromium", () => {
  // The combined `backdrop-filter: blur() url()` syntax is what Safari
  // silently drops the SVG stage from. Declaring `filter` and
  // `backdrop-filter` as two separate properties on the same element sidesteps
  // that: `filter` distorts the element's own already-rendered output
  // (including whatever its own backdrop-filter produced) instead of being
  // parsed as part of the backdrop-filter value, and Safari runs that
  // combination fine.
  assert.match(filter, /supportsSplitPropertyLens/);
  assert.match(filter, /CSS\.supports\("filter", `url\(#\$\{FILTER_ID\}\)`\)/);
  // No fine-pointer or reported-hardware requirement — unlike
  // supportsDetailedLiveRefraction, this path exists specifically to run
  // for every real user regardless of device, not just ones that pass a
  // guessed capability threshold. Only explicit OS-level accessibility
  // preferences (reduced motion, reduced transparency) and a metered
  // connection (data saver) opt someone out.
  const splitFnStart = filter.indexOf("function supportsSplitPropertyLens");
  const splitFnEnd = filter.indexOf("\n}", splitFnStart);
  const splitFnBody = filter.slice(splitFnStart, splitFnEnd);
  assert.doesNotMatch(splitFnBody, /finePointer|memoryGb|cores|supportsDetailedGlass/);
  assert.match(splitFnBody, /REDUCED_MOTION_QUERY/);
  assert.match(splitFnBody, /REDUCED_TRANSPARENCY_QUERY/);
  assert.match(splitFnBody, /saveData/);
  assert.match(filter, /document\.documentElement\.dataset\.glassLensSplit/);

  // .nav-menu-group's material lives on ::before so filter and
  // backdrop-filter can be declared separately rather than combined.
  assert.match(css, /\.nav-menu-group::before \{[^}]*backdrop-filter: blur\(14px\)/);
  assert.match(css, /html\[data-glass-lens-split\] \.nav-menu-group::before \{\s*filter: url\("#bandup-live-glass-refraction"\);\s*\}/);
  // Content sits in its own stacking layer above ::before so only the
  // material warps, never the icons or labels.
  assert.match(css, /\.nav-menu-group > \* \{\s*position: relative;\s*z-index: 1;\s*\}/);
});
