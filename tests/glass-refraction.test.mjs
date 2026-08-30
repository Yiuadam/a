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

test("the bevel is a uniform width in pixels once solved for a pane's aspect", () => {
  // The map is a square bitmap stretched onto its pane, so every horizontal
  // distance in it is multiplied by the pane's aspect ratio on the way to the
  // screen. Solving in height units means the bevel comes out the same number
  // of pixels wide along the top as along the side; in the map itself that
  // shows up as a horizontal band aspect-times narrower than the vertical one.
  const size = 128;
  const aspect = 8;
  const map = glassRefractionModule.createGlassRefractionMap(size, {
    aspect,
    cornerRadius: 0.9,
    bezelWidth: 0.8,
  });
  const mid = size / 2;
  const bends = (read) => {
    let count = 0;
    for (let i = 0; i < mid; i += 1) if (read(i) !== 0) count += 1;
    return count;
  };
  // how far the bend reaches inward from the left edge, and from the top
  const acrossX = bends((i) => pixel(map, size, i, mid)[0] - 128);
  const acrossY = bends((i) => pixel(map, size, mid, i)[1] - 128);

  assert.ok(acrossX > 0 && acrossY > 0, "both axes should carry a bevel");
  const ratio = acrossY / acrossX;
  assert.ok(
    ratio > aspect * 0.7 && ratio < aspect * 1.3,
    `bevel should be ~${aspect}x narrower across the map's width; got ${ratio.toFixed(2)}x`,
  );

  // and it is still flat in the middle
  assert.deepEqual(pixel(map, size, mid, mid), [128, 128, 128, 255]);
});

test("the dome bends along the surface normal, so the ends bend too", () => {
  // A purely vertical magnification leaves the rounded ends flat, which is
  // exactly what a dome does not do. Displacing along the surface normal makes
  // the top and bottom bend vertically, the ends bend inward along their own
  // curve, and the middle stay put.
  const size = 512;
  const map = glassRefractionModule.createGlassRefractionMap(size, {
    aspect: 3,
    cornerRadius: 0.98,
    bezelWidth: 0,
    magnify: 0.42,
    dome: 0.45,
    maxDisplacement: 0.85,
  });
  const mid = size / 2;
  const at = (x, y) => [pixel(map, size, x, y)[0] - 128, pixel(map, size, x, y)[1] - 128];

  const [topX, topY] = at(mid, 8);
  const [endX, endY] = at(6, mid);
  assert.deepEqual(at(mid, mid), [0, 0], "the middle of the glass stays put");
  assert.ok(Math.abs(topY) > 20 && Math.abs(topY) > Math.abs(topX) * 4, "the top edge bends vertically");
  assert.ok(Math.abs(endX) > 20 && Math.abs(endX) > Math.abs(endY) * 4, "the rounded end bends horizontally");
  // both pull inward, which is what keeps every sample on the pane
  assert.ok(topY > 0, "the top edge pulls down, into the glass");
  assert.ok(endX > 0, "the left end pulls right, into the glass");
});

test("the dome's rim climbs far faster than a straight ramp", () => {
  // The tangle at the edge comes from that late climb; a ramp has no steep
  // part and cannot produce it at any strength.
  const size = 512;
  const shape = { aspect: 3, cornerRadius: 0.98, bezelWidth: 0, maxDisplacement: 0.85 };
  const ramp = glassRefractionModule.createGlassRefractionMap(size, { ...shape, magnify: 1 });
  const dome = glassRefractionModule.createGlassRefractionMap(size, { ...shape, dome: 1 });
  const mid = size / 2;
  const g = (m, row) => pixel(m, size, mid, row)[1] - 128;

  // find the rim on the vertical centreline
  let rim = 0;
  while (rim < mid && g(ramp, rim) === 0) rim += 1;
  const depth = (f) => rim + Math.round(f * (mid - rim));

  // near the rim both are strong; a third of the way in the dome has already
  // given most of its bend back while the ramp is still coasting down
  assert.ok(g(dome, depth(0.02)) > g(ramp, depth(0.02)) * 0.8, "both bend hard at the rim");
  assert.ok(
    g(dome, depth(0.35)) < g(ramp, depth(0.35)) * 0.5,
    "the dome should be far gentler than a ramp away from the rim",
  );
});

test("a straight ramp spreads the centre so the middle is not inert", () => {
  // A bevel alone only bends what passes under the rim. With one, a line
  // crossing behind a pane comes out nudged where it enters and untouched
  // everywhere else, which reads as a blurred hole rather than as glass. A
  // real lens also spreads what is behind its centre — that is what makes the
  // line thicker in the middle and compressed at the edge.
  const size = 128;
  const shape = { aspect: 4, cornerRadius: 0.9, bezelWidth: 0.8 };
  const flat = glassRefractionModule.createGlassRefractionMap(size, shape);
  const lens = glassRefractionModule.createGlassRefractionMap(size, { ...shape, magnify: 0.18 });
  const mid = size / 2;
  const quarter = Math.floor(size / 4);

  // dead centre stays put — magnification is measured relative to it
  assert.deepEqual(pixel(lens, size, mid, mid), [128, 128, 128, 255]);

  // Away from the centre the lens adds a pull back toward it, on top of
  // whatever the bevel is already doing. Differencing the two maps isolates
  // exactly that term.
  const added = (row) => pixel(lens, size, mid, row)[1] - pixel(flat, size, mid, row)[1];
  const y = (row) => ((row + 0.5) / size) * 2 - 1;

  assert.ok(Math.abs(added(quarter)) > 4, "the flat centre should magnify, not sit inert");
  // it pulls inward: above the centre line pulls down, below it pulls up
  assert.ok(y(quarter) < 0 && added(quarter) > 0);
  assert.ok(y(size - 1 - quarter) > 0 && added(size - 1 - quarter) < 0);
  // symmetric about the centre, to within the map's 8-bit rounding
  assert.ok(Math.abs(added(quarter) + added(size - 1 - quarter)) <= 1);
  // and proportional to distance from it, so the spread is even rather than
  // bunched at one depth
  const near = Math.floor(size * 0.375);
  const expected = y(quarter) / y(near);
  assert.ok(
    Math.abs(added(quarter) / added(near) - expected) < 0.4,
    `pull should scale with distance from the centre; expected ~${expected.toFixed(2)}x`,
  );
});

test("the bend never asks for a sample from beyond the pane's edge", () => {
  // A pane can only refract what is behind it. The bevel bends outward, so a
  // sample taken further out than the rim lands outside the element, where the
  // filter has nothing to read — it comes back empty, and the material recedes
  // from its own edge in a transparent band. On screen that band separates the
  // glass from its rim highlight and reads as a hard outer ring around the
  // card. Told what its channels are worth, the map holds the bend to the
  // distance actually available to it.
  const size = 256;
  const maxDisplacement = 0.85;
  const shape = { aspect: 3, cornerRadius: 0.98, bezelWidth: 0.8, magnify: 0.18 };
  const capped = glassRefractionModule.createGlassRefractionMap(size, {
    ...shape,
    maxDisplacement,
  });
  const uncapped = glassRefractionModule.createGlassRefractionMap(size, shape);
  const mid = size / 2;
  const outward = (map, row) => -(pixel(map, size, mid, row)[1] - 128) / 127;

  // find the first row inside the shape, scanning down the vertical centreline
  let rim = 0;
  while (rim < mid && pixel(uncapped, size, mid, rim)[1] === 128) rim += 1;

  // uncapped, the rim samples hard outward — past the element, into nothing
  assert.ok(outward(uncapped, rim) > 0.5, "the uncapped bend runs off the edge");
  // capped, it does not sample outward at the rim at all
  assert.ok(outward(capped, rim) <= 0, "the bend must not run off the edge");

  // and nowhere does the outward reach exceed the distance back to the rim
  for (let row = rim; row < mid; row += 1) {
    const distance = (row - rim) / (mid - rim); // in half-heights of the shape
    const reach = outward(capped, row) * maxDisplacement;
    assert.ok(
      reach <= distance + 0.02,
      `row ${row} reaches ${reach.toFixed(3)} past a rim only ${distance.toFixed(3)} away`,
    );
  }

  // the strongest bend still lands somewhere inside, not at zero everywhere
  let peak = 0;
  for (let row = rim; row < mid; row += 1) peak = Math.max(peak, outward(capped, row));
  assert.ok(peak > 0.25, "capping must not flatten the bend away");
});

test("an aspect of 1 leaves the map exactly as it was", () => {
  // The generic sitewide filter still uses the square map, so the default must
  // not drift when the option is added.
  const size = 64;
  const withDefaults = glassRefractionModule.createGlassRefractionMap(size);
  const explicit = glassRefractionModule.createGlassRefractionMap(size, { aspect: 1 });
  assert.deepEqual(Array.from(withDefaults), Array.from(explicit));
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
  // The cards use their own filter, not the sitewide one. A displacement map
  // is only correct for the aspect ratio it was solved for, and a nav card is
  // roughly 7:1 where the generic glass surfaces are nearly square — sharing
  // one map put the bend across the middle of the card instead of on its edge,
  // which is why the backdrop never visibly deformed.
  assert.match(css, /html\[data-glass-lens-split\] \.nav-menu-group::before \{[\s\S]*?filter: url\("#bandup-nav-glass-lens"\);/);
  assert.match(filter, /NAV_FILTER_ID = "bandup-nav-glass-lens"/);
  // Measured from a real card rather than assumed, and rebuilt when that
  // measurement can have changed.
  assert.match(filter, /function measureNavPane/);
  assert.match(filter, /getBoundingClientRect/);
  assert.match(filter, /borderTopLeftRadius/);
  assert.match(filter, /MutationObserver/);
  assert.match(filter, /addEventListener\("resize"/);
  // One smooth field, no separate bevel band. A bevel only acts within its
  // own width of the rim, so it gives the perimeter a behaviour the middle
  // does not share — the outer part stops obeying the same refraction as the
  // inside and the join between them shows. What is left is a cylindrical
  // magnifier whose displacement grows steadily from nothing at the centre
  // line to its strongest at the edge, so a line crossing behind the card is
  // bent by the same rule wherever it crosses.
  assert.match(filter, /NAV_BEZEL_WIDTH = 0;/);
  assert.match(filter, /NAV_MAGNIFY = 0\.55;/);
  // Plus a dome for the rim: a hemisphere's refraction follows its surface
  // slope, gentle across the face and then climbing almost vertically in the
  // last stretch, which folds the backdrop into a tangled band at the edge.
  assert.match(filter, /NAV_DOME = 1;/);
  // And how far in from the rim it starts rolling over — its thickness. A
  // small value keeps the roll in the last few percent, a thin sheet with a
  // sharp border; this puts it across a wide band, so the pane reads as a deep
  // slab whose edge curves down to its underside.
  assert.match(filter, /NAV_THICKNESS = 0\.6;/);
  // The scale is derived from the measured box, not a constant: it is bounded
  // by the card's half-height while objectBoundingBox resolves it against the
  // diagonal, which on a wide card is set almost entirely by its width.
  assert.match(filter, /NAV_DISPLACEMENT_HEADROOM = 0\.85/);
  assert.match(filter, /scale: \(NAV_DISPLACEMENT_HEADROOM \* halfHeight\) \/ diagonal/);
  assert.match(filter, /scale=\{navScale\}/);
  // A square map stretched across a wide card gives each column several screen
  // pixels; at the rounded ends the normal swings through most of its range
  // within a few of them and the steps show as a staircase.
  assert.match(filter, /NAV_MAP_SIZE = 512/);
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
  // Lit like a rolled edge rather than a flat inner face: bright along the top
  // where the curve turns up into the light, dark underneath and at the sides
  // where it turns away toward the pane's underside. That asymmetry is most of
  // what reads as depth; an evenly lit wall reads as a doubled border.
  //
  // This is radial gradients now, not box-shadow. Four inset box-shadows each
  // reduce their own effective corner radius by a different amount (their own
  // offset and negative spread), so on a shape this rounded the four never
  // shared one rounded outline — where two crossed, near the transition from a
  // straight edge to a rounded end, the mismatch showed as a visible jagged
  // seam. A radial-gradient has no per-corner geometry at all: it is a smooth
  // function of distance from a point, so summing several can never produce a
  // seam.
  const before = css.match(/\n\.nav-menu-group::before \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(before, /box-shadow:/);
  assert.match(before, /--nav-wall-light: color-mix\(in srgb, white 70%/);
  assert.match(before, /--nav-wall-shade: color-mix\(in srgb, rgb\(40, 30, 22\) 26%/);
  assert.match(before, /--nav-wall-shade-soft: color-mix\(in srgb, rgb\(40, 30, 22\) 14%/);
  assert.match(before, /radial-gradient\(130% 100% at 50% -30%, var\(--nav-wall-light\)/);
  assert.match(before, /radial-gradient\(150% 140% at 50% 130%, var\(--nav-wall-shade\)/);
  // Each ellipse fades to transparent well inside its own radius, so the wall
  // eases from transparent at the card's own edge into the glow rather than
  // stopping at a hard boundary partway across it.
  assert.match(before, /var\(--nav-wall-light\), transparent 62%/);
  assert.match(before, /var\(--nav-wall-shade\), transparent 58%/);
  // The tint sits behind the wall in the same declaration, not a separate one
  // dark theme has to reconstruct.
  assert.match(before, /--nav-tint: color-mix\(/);
  assert.match(before, /var\(--nav-tint\);\s*\n\}/);

  const dark = css.match(/html\[data-theme="dark"\] \.nav-menu-group::before \{[\s\S]*?\n\}/)[0];
  // Only the custom properties are overridden — no background/box-shadow
  // redeclaration, so the layer structure above cannot drift from this.
  assert.doesNotMatch(dark, /\n {2}background:/);
  assert.doesNotMatch(dark, /box-shadow:/);
  assert.match(dark, /--nav-wall-light: color-mix\(in srgb, white 34%/);
  assert.match(dark, /--nav-wall-shade: color-mix\(in srgb, black 40%/);
  assert.ok(
    !/white (5[0-9]|[6-9][0-9])%/.test(dark),
    "a dark-theme wall at light-theme strength reads as a second drawn border",
  );
});
