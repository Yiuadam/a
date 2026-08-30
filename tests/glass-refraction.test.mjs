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

  // A real convex panel turns down hard at the rim and is flat again within
  // a few pixels of it. The bevel deliberately hugs the edge: this square
  // map is stretched onto panes of any aspect ratio, so a bevel measured as
  // a fraction of each axis is far wider horizontally than vertically on a
  // wide card, and a generous value stops reading as an edge at all.
  assert.ok(displacement(1) > 120, "the rim should bend at nearly full strength");
  assert.ok(displacement(4) < displacement(1) / 2, "the bend should fall off steeply behind the rim");
  assert.equal(displacement(8), 0, "the pane should be optically flat well before its middle");
});

test("live panels use the SVG displacement filter only after browser capability detection", () => {
  assert.match(filter, /Safari parses[\s\S]*?false positive/);
  assert.match(filter, /Chromium\|Google Chrome\|Microsoft Edge\|Opera/);
  assert.match(filter, /primitiveUnits="objectBoundingBox"/);
  // This scale resolves against the pane's diagonal, not its shortest side.
  // A 360x56 nav card has a ~258px diagonal, so 0.24 asked for up to 62px of
  // displacement on an element 56px tall and dragged content from outside the
  // card into the middle of it. The bound is the shortest pane sharing this
  // filter, so the value stays small.
  assert.match(filter, /scale="0\.06"/);
  // The filter region is the pane itself. Anything larger lets displaced
  // pixels paint outside its rounded rectangle — visible as a faint second
  // copy of each card hanging past its bottom-right corner.
  assert.match(filter, /x="0%"[\s\S]*?y="0%"[\s\S]*?width="100%"[\s\S]*?height="100%"/);
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
  // backdrop-filter can be declared separately rather than combined. It is
  // lighter than the sheet's own 14px: a pane of glass is clearer than the
  // frosted surface it rests on, and saturation and brightness rather than
  // more blur are what keep the backdrop reading as a scene behind glass.
  assert.match(css, /\.nav-menu-group::before \{[^}]*backdrop-filter: blur\(10px\)/);
  assert.match(css, /html\[data-glass-lens-split\] \.nav-menu-group::before \{\s*filter: url\("#bandup-live-glass-refraction"\);\s*\}/);
  // Content sits in its own stacking layer above ::before so only the
  // material warps, never the icons or labels.
  assert.match(css, /\.nav-menu-group > \* \{\s*position: relative;\s*z-index: 1;\s*\}/);
});

test("the nav card's rim varies around its own perimeter", () => {
  // A single flat inset highlight lights every edge identically, which is the
  // one thing real glass never does. The rim is a gradient border — bright
  // where a light above and to the left catches the top edge, almost gone
  // along the sides, bright again where the bottom edge turns back toward the
  // viewer — painted across the box and masked down to the border ring, which
  // is the only way to vary a border's colour around its own perimeter.
  assert.match(css, /\.nav-menu-group::after \{[\s\S]*?linear-gradient\(\s*148deg/);
  assert.match(css, /\.nav-menu-group::after \{[\s\S]*?mask-composite: exclude/);
  // Both syntaxes: Safari needs the -webkit- form, and this rim is the main
  // thing carrying the glass read there.
  assert.match(css, /\.nav-menu-group::after \{[\s\S]*?-webkit-mask-composite: xor/);
  assert.match(css, /html\[data-theme="dark"\] \.nav-menu-group::after \{[\s\S]*?linear-gradient\(\s*148deg/);
  // The old flat hairline must not come back alongside it.
  assert.doesNotMatch(css, /\.nav-menu-group \{[^}]*inset 0 1px 0 color-mix\(in srgb, white 55%/);

  // Light through a curved edge concentrates into a caustic: a short,
  // intense arc with almost nothing either side. The bright stop is held
  // rather than eased through, so the rim does not read as a painted sheen.
  assert.match(css, /\.nav-menu-group::after \{[\s\S]*?white 100%, transparent\) 0%,\s*color-mix\(in srgb, white 97%, transparent\) 5%/);
});

test("the nav card's rim has a wall behind it, not just an edge", () => {
  // Real glass has thickness, so its rim reads as two edges with a lit wall
  // between them. ::after draws the outer edge; the wall lives on the
  // material itself so the lens warps it with the surface it belongs to.
  // Brightest along the top and dimmest at the sides — an evenly lit wall
  // reads as a doubled border rather than as depth.
  const before = css.match(/\n\.nav-menu-group::before \{[\s\S]*?\n\}/)[0];
  assert.match(before, /box-shadow:\s*\n\s*inset 0 1\.5px 2px -1px color-mix\(in srgb, white 58%/);
  assert.match(before, /inset 1\.5px 0 2px -1px color-mix\(in srgb, white 20%/);

  const dark = css.match(/html\[data-theme="dark"\] \.nav-menu-group::before \{[\s\S]*?\n\}/)[0];
  assert.match(dark, /box-shadow:\s*\n\s*inset 0 1\.5px 2px -1px color-mix\(in srgb, white 26%/);
  assert.ok(
    !/white (5[0-9]|[6-9][0-9])%/.test(dark.split("box-shadow:")[1]),
    "a dark-theme wall at light-theme strength reads as a second drawn border",
  );
});
