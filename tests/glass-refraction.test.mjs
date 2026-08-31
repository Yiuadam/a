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
  /* Blue is 0 wherever the surface is flat, not the neutral 128 the other
     two channels use. R and G store a signed direction, so they need a
     midpoint to sit at; blue stores how hard the surface is bending, which
     is unsigned and genuinely zero across the flat middle. The spectral rim
     in GlassRefractionFilter reads it as its mask, which is what keeps that
     fringe on the turn of the glass and off the icons. */
  assert.deepEqual(pixel(map, size, 32, 32), [128, 128, 0, 255]);
});

test("blue carries the bend magnitude, so a fringe can be masked to the rim", () => {
  // This is what keeps the spectral rim off the icons. The knob's bevel
  // reaches half its radius and a whole-face lens sits on top of it, so
  // there is no radius to clip a fringe against — the mask has to come from
  // the geometry. Blue is that: unsigned bend magnitude, zero where the
  // surface is flat and highest where it turns over.
  const size = 64;
  const map = glassRefractionModule.createGlassRefractionMap(size);
  const blue = (x, y) => pixel(map, size, x, y)[2];

  assert.equal(blue(32, 32), 0, "the flat middle should carry no bend at all");
  assert.ok(blue(1, 32) > 0, "the rim should carry bend");
  assert.ok(
    blue(1, 32) > blue(8, 32),
    "bend should fall off going inward from the rim",
  );
  // And it has to agree with the two channels the displacement itself reads,
  // or the fringe would sit somewhere the glass is not bending.
  const rimShift = Math.abs(pixel(map, size, 1, 32)[0] - 128);
  const innerShift = Math.abs(pixel(map, size, 8, 32)[0] - 128);
  assert.ok(rimShift > innerShift, "the same ordering should hold in red");
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
  assert.deepEqual(pixel(map, size, mid, mid), [128, 128, 0, 255]);
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

test("the normal direction blends smoothly across the diagonal seam instead of jumping", () => {
  // Away from the rounded corners, every point on a flat side is closer to
  // either the vertical or the horizontal edge. Switching abruptly between a
  // purely horizontal and a purely vertical normal right at that boundary is
  // a real discontinuity in direction — it showed up as a straight seam
  // cutting the pane into visible triangles, however small the bend's own
  // magnitude was on either side of it. The normal should rotate smoothly
  // through the transition instead.
  const size = 256;
  const map = glassRefractionModule.createGlassRefractionMap(size, {
    aspect: 1,
    cornerRadius: 0.1,
    bezelWidth: 0,
    magnify: 0,
    dome: 0.6,
    thickness: 0.3,
    maxDisplacement: 0.85,
  });
  // A square pane is symmetric under swapping x and y, so the diagonal
  // qx = qy runs exactly along the line from the centre to each corner.
  // This offset is inside straightExtent (0.88 here) but close enough to the
  // rim to sit inside the dome's own thickness band (0.3), so it is testing
  // the flat-side branch with a real, measurable bend — not the rounded
  // corner's own (already smooth) formula, and not a point so far from the
  // rim that dome contributes nothing for either branch to blend.
  const mid = size / 2;
  const offset = 100;
  const onDiagonal = pixel(map, size, mid + offset, mid - offset).map((c) => c - 128);
  assert.ok(
    Math.abs(onDiagonal[0]) > 2 && Math.abs(onDiagonal[1]) > 2,
    "both channels should carry some of the bend exactly on the diagonal, not just one",
  );

  // Either side of the diagonal, the dominant channel should hand off
  // gradually — still blended a couple of pixels off-centre — rather than
  // one channel already having snapped back to exactly neutral.
  const justInside = pixel(map, size, mid + offset - 2, mid - offset).map((c) => c - 128);
  const justOutside = pixel(map, size, mid + offset + 2, mid - offset).map((c) => c - 128);
  assert.ok(
    Math.abs(justInside[0]) > 2 && Math.abs(justInside[1]) > 2,
    "still blended just to one side of the diagonal",
  );
  assert.ok(
    Math.abs(justOutside[0]) > 2 && Math.abs(justOutside[1]) > 2,
    "still blended just to the other side of the diagonal",
  );
});

test("the dome's rim climbs far faster than a straight ramp, right at the true edge", () => {
  // The tangle at the edge comes from that late climb; a ramp has no steep
  // part and cannot produce it at any strength.
  //
  // This used to be normalised against a slope cap, which is exactly what put
  // the fold in the wrong place: the cap was reached partway through the
  // band, so the busiest, most rapidly changing part of the profile sat
  // there, inset from the rim, while the band's outer sliver — the part
  // actually at the card's edge — ran flat at the cap and looked like an
  // ordinary, unremarkable compression. That is backwards from a real dome,
  // whose most violent bending is at its own physical edge. The slope is now
  // left unnormalised and only saturates through the final channel clamp, so
  // the steepest, busiest change is pinned to the true rim (t = 1) however
  // wide the band is, and it settles into the same kind of smooth, gentle
  // curve as the ramp well before reaching the band's inner edge.
  const size = 512;
  const shape = { aspect: 3, cornerRadius: 0.98, bezelWidth: 0, maxDisplacement: 0.85 };
  const ramp = glassRefractionModule.createGlassRefractionMap(size, { ...shape, magnify: 1 });
  const dome = glassRefractionModule.createGlassRefractionMap(size, { ...shape, dome: 0.25, thickness: 0.75 });
  const mid = size / 2;
  const g = (m, row) => pixel(m, size, mid, row)[1] - 128;

  // find the rim on the vertical centreline
  let rim = 0;
  while (rim < mid && g(ramp, rim) === 0) rim += 1;
  const depth = (f) => rim + Math.round(f * (mid - rim));

  // right at the rim both are strong...
  assert.ok(g(dome, depth(0.02)) > g(ramp, depth(0.02)) * 0.8, "both bend hard at the rim");
  // ...but the dome falls away steeply behind it, well before the band's own
  // inner edge — the busy part stays a thin sliver hugging the true rim
  // rather than a wide plateau reaching deep into the face.
  assert.ok(
    g(dome, depth(0.2)) < g(ramp, depth(0.2)) * 0.5,
    "the dome should already be far gentler than a ramp a fifth of the way in",
  );
  assert.ok(
    g(dome, depth(0.5)) < g(dome, depth(0.2)),
    "the dome should keep falling further from the rim, not plateau",
  );
});

test("the dome's climb has no plateau anywhere inside its band", () => {
  // The precise shape of the earlier bug: because domeSlope was normalised
  // against a fixed cap, it ran perfectly flat across the whole outer stretch
  // of the band where the raw slope exceeded that cap — a wide, unmoving
  // plateau sitting right where the rim's own strongest bend should have
  // been. A profile with no such flat run, anywhere between the rim and the
  // band's inner edge, cannot have that plateau: it is monotonically
  // decreasing at every step, all the way in.
  const size = 512;
  const map = glassRefractionModule.createGlassRefractionMap(size, {
    aspect: 3,
    cornerRadius: 0.98,
    bezelWidth: 0,
    dome: 0.25,
    thickness: 0.75,
    maxDisplacement: 0.85,
  });
  const mid = size / 2;
  const g = (row) => Math.abs(pixel(map, size, mid, row)[1] - 128);

  let rim = 0;
  while (rim < mid && g(rim) === 0) rim += 1;

  let sawDrop = false;
  for (let row = rim; row < mid - 1; row += 1) {
    const here = g(row);
    const next = g(row + 1);
    assert.ok(next <= here, `row ${row + 1} (${next}) should not exceed row ${row} (${here})`);
    if (next < here) sawDrop = true;
  }
  assert.ok(sawDrop, "the profile should actually decrease somewhere, not sit flat the whole way");
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
  assert.deepEqual(pixel(lens, size, mid, mid), [128, 128, 0, 255]);

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

test("the card reads as a thick slab: a wide roll-over band around a flat middle", () => {
  // The thick slab's defining property, and the thing that separates it from
  // a thin sheet with a bevel stuck round it: how far in from the rim the
  // glass starts turning over. A narrow band keeps the roll-over in the last
  // few percent — a sheet with a sharp border, however hard it bends there.
  //
  // Pinned as a measurement rather than as the constant alone, because the
  // constant on its own does not say what it buys. Both halves matter: the
  // band has to be wide, and the middle has to stay flat — a bevel is a
  // function of distance from the rim, so widening it must never start
  // pulling the centre the way the old centre-referenced dome did.
  const size = 256;
  const aspect = 1.4;
  const shape = { aspect, cornerRadius: 0.12 };
  const maxDisplacement = 0.97 / Math.sqrt(2 * (aspect * aspect + 1));
  const row = size / 2;

  const measure = (bezelWidth) => {
    const map = glassRefractionModule.createGlassRefractionMap(size, {
      ...shape,
      bezelWidth,
      maxDisplacement,
    });
    let band = 0;
    let peak = 0;
    let peakAt = 0;
    for (let dx = 0; dx < size / 2; dx += 1) {
      const bend = Math.abs(pixel(map, size, size - 1 - dx, row)[0] - 128) / 127;
      if (bend > 0.02) band = dx;
      if (bend > peak) {
        peak = bend;
        peakAt = dx;
      }
    }
    return { band: band / (size / 2), peak, peakAt: peakAt / (size / 2) };
  };

  const slab = measure(0.85);
  const sheet = measure(0.35);

  // The band reaches well past half way in from the rim, and bends much
  // harder, rather than hugging the edge.
  assert.ok(slab.band > 0.5, `slab band should span over half the face, got ${slab.band}`);
  assert.ok(slab.band > sheet.band * 2, "the slab's band should be far wider than a thin sheet's");
  assert.ok(slab.peak > sheet.peak, "the slab should bend harder than a thin sheet");

  // The steepest bend still sits out near the rim, where a real slab's edge
  // rolls down to its underside — not relocated into the face.
  assert.ok(slab.peakAt < 0.35, `the sharpest bend should stay near the rim, got ${slab.peakAt}`);

  // And the middle is genuinely inert, which is the guarantee the bevel gives
  // and the dome could not.
  assert.deepEqual(pixel(
    glassRefractionModule.createGlassRefractionMap(size, {
      ...shape,
      bezelWidth: 0.85,
      maxDisplacement,
    }),
    size,
    size / 2,
    size / 2,
  ), [128, 128, 0, 255]);
});

test("the theme knob keeps a flat face and bends only at its rim", () => {
  // The knob wants the opposite of the cards' slab. A card is a wide,
  // shallow pane, so a band reaching 61% of its half-width still reads as an
  // edge rolling under. The knob measures as a circle, and on a circle that
  // same 0.85 reaches 84% of the way in from the rim — the whole disc bends,
  // which domes whatever sits behind it instead of leaving it flat behind
  // glass.
  //
  // Real glass with a flat face and a rounded edge shows its middle
  // undisturbed and compresses only at the rim. That is what is pinned here,
  // as the measurement rather than the constant: two bezel widths now live
  // in one system and the whole point is that they behave differently.
  const size = 256;
  const shape = { aspect: 1, cornerRadius: 0.98 };
  const maxDisplacement = 0.97 / Math.sqrt(2 * (1 * 1 + 1));
  const row = size / 2;

  const band = (bezelWidth) => {
    const map = glassRefractionModule.createGlassRefractionMap(size, {
      ...shape,
      bezelWidth,
      maxDisplacement,
    });
    let reach = 0;
    let peak = 0;
    for (let dx = 0; dx < size / 2; dx += 1) {
      const bend = Math.abs(pixel(map, size, size - 1 - dx, row)[0] - 128) / 127;
      if (bend > 0.02) reach = dx;
      peak = Math.max(peak, bend);
    }
    return { map, reach: reach / (size / 2), peak };
  };

  const knob = band(0.5);
  const slab = band(0.85);

  // An outer ring, not the whole disc: the middle still has to read as plain
  // open glass. This started at 0.14, which kept the centre flat but peaked
  // at under a fifth of the available displacement — a bend that measured
  // but could not be seen. The bend is held to what is available before a
  // sample falls off the pane, so a wider band is the only way to buy more
  // of it. 0.6 gets the peak to 0.60 — over two and a half times the old
  // one — and still leaves the inner two fifths of the disc untouched, so
  // the icon at the centre comes through flat.
  assert.ok(knob.reach <= 0.55, `knob bend should stay a ring, reached ${knob.reach}`);
  assert.ok(knob.peak > 0.45, `knob bend should be worth seeing, peaked ${knob.peak}`);
  // And the slab width really would have bent nearly the whole disc — this
  // is the bug being prevented, not a hypothetical.
  assert.ok(slab.reach > 0.8, `0.85 on a circle should reach deep, got ${slab.reach}`);

  // The face is provably inert, not merely tuned small: dead centre, and
  // well inside the flat region, both sit exactly on the neutral value.
  assert.deepEqual(pixel(knob.map, size, size / 2, row), [128, 128, 0, 255]);
  assert.deepEqual(pixel(knob.map, size, Math.floor(size * 0.7), row), [128, 128, 0, 255]);

  // The knob asks for its own bezel by name, and it is keyed into the bucket
  // so it can never share a filter with a square card that happens to
  // measure the same shape.
  assert.match(filter, /const KNOB_BEZEL_WIDTH = 0\.5;/);
    // Now every option bar's knob, not just the theme control's — see
  // tests/segmented-controls.test.mjs.
  assert.match(filter, /KNOB_SELECTOR = "\.theme-toggle-selector, \.segmented-knob"/);
  assert.match(filter, /const knob = pane\.matches\(KNOB_SELECTOR\);/);
  assert.match(filter, /const bezelWidth = knob \? KNOB_BEZEL_WIDTH : GENERIC_BEZEL_WIDTH;/);
  // Bezel width is part of the bucket identity, so the knob can never share
  // a filter with a square card that happens to measure the same shape.
  assert.match(filter, /function bucketKey\([\s\S]{0,160}bezelWidth: number,/);
  assert.match(filter, /bezelWidth: bucket\.bezelWidth,/);
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
  // filter, so the value stays small — raised from 0.06 only in step with the
  // map's own higher displacement headroom (see NAV_DISPLACEMENT_HEADROOM),
  // still held well under the old 0.24 that caused that bug.
  assert.match(filter, /scale="0\.08"/);
  // Shares the same bevel width and displacement headroom as the bucketed
  // system below, rather than the library's own quieter defaults, so this
  // Chromium-only combined path reads as the same strength of glass.
  assert.match(filter, /createMapUrl\(\{\s*\n\s*bezelWidth: NAV_BEZEL_WIDTH,\s*\n\s*maxDisplacement: NAV_DISPLACEMENT_HEADROOM,\s*\n\s*\}\)/);
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
  // The generic combined-syntax rule keeps its frosted material and no
  // longer ends in a displacement stage.
  //
  // The filter was working exactly as written; the problem is that its map
  // is built with no aspect and no corner radius, so it falls back to a
  // square with a 0.3 corner and is then stretched with
  // preserveAspectRatio="none" over every pane that references it — a
  // 494x61 header, a 225x67 dashboard tile, a full-height .nav-paper sheet.
  // The contour where that map's bevel turns over therefore lands in the
  // middle of a pane's face rather than on its outline, as a soft
  // rounded-rectangle shape unrelated to anything on screen.
  //
  // A lens whose map does not know the shape it is applied to cannot start
  // its bend at that shape's edge, by construction — no strength or width
  // moves the contour onto the outline. Refraction anchored to a real
  // measured shape still runs on the knobs, whose maps are solved per shape.
  const sitewideRule = css.match(
    /html\[data-live-glass-refraction\] \.liquid-glass:not\(\.nav-menu-group\),[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(sitewideRule, "expected the sitewide combined-syntax glass rule");
  assert.match(sitewideRule, /backdrop-filter:\s*\n\s*blur\(8px\)/);
  // Scoped to the declaration rather than the whole rule: the comment above
  // it names the filter id it used to end with, and a looser pattern would
  // match that instead of the CSS.
  assert.doesNotMatch(sitewideRule, /backdrop-filter:[\s\S]*?url\(/);
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
  // The nav card takes no SVG lens, and neither does any other card — see
  // the matching assertion in the generic-card test below for why.
  //
  // Its own history is the argument for keeping this asserted rather than
  // just deleted, because the shape kept coming back through different
  // mechanisms. First a dedicated map that had never actually rendered, on
  // account of a `display: none` bug in the shared
  // `.liquid-glass::before` reset that nothing overrode. Then, with that
  // fixed, a centre-referenced dome/magnify pull that traced a rounded
  // rectangle into the interior however narrowly its band was confined.
  // Then a pure bevel, which removed that mechanism and left a third: this
  // card measures a corner ratio of 0.258 and is served a bucketed map
  // drawn for 0.3, so the bevel's arc and the card's arc do not coincide
  // and the seam shows at the corner. Compared side by side with the
  // filter off, the version without it was preferred.
  assert.doesNotMatch(css, /html\[data-glass-lens-split\] \.nav-menu-group::before \{\s*\n\s*filter: var\(--glass-lens-filter, none\);/);
  assert.doesNotMatch(filter, /NAV_FILTER_ID|measureNavPane/);
  // Both the wall and the rim redeclare `display: block` — the property the
  // reset above sets to `none`, which `content: ""` alone never undoes.
  assert.match(css, /\.nav-menu-group::before \{\s*\n\s*content: "";\s*\n[\s\S]*?display: block;/);
  assert.match(css, /\.nav-menu-group::after \{\s*\n\s*content: "";\s*\n[\s\S]*?display: block;/);
  // The bucketed measuring system is still there, and .nav-menu-group is no
  // longer one of the shapes it measures. Nothing on this card references a
  // generated filter any more, so measuring it would build a 384px map and a
  // filter tree for a rule that no longer exists.
  assert.match(filter, /function measureGenericPanes/);
  assert.doesNotMatch(filter, /GENERIC_SELECTOR[\s\S]{0,400}nav-menu-group/);
  assert.match(filter, /getBoundingClientRect/);
  assert.match(filter, /borderTopLeftRadius/);
  assert.match(filter, /MutationObserver/);
  assert.match(filter, /addEventListener\("resize"/);
  // A bevel confined to its own band at the rim, and nothing else — no dome,
  // no magnify. Both of those bend along the surface normal measured from
  // the centre outward, so however tightly `thickness` confines their
  // strength to a thin band near the rim, they still trace the panel's own
  // rounded-rectangle contour some distance into the interior — the "circle"
  // that kept reappearing even after the direction discontinuity across it
  // was smoothed and the band cut down to a sliver, because the shape was
  // the mechanism, not the discontinuity or the band width. A bevel's own
  // profile is purely a function of distance from the rim, evaluated only
  // inside its own band width, so nothing about it reaches back toward the
  // centre — a uniform ring of bend around a provably flat, inert middle.
  // 0.85 is the thick slab's own thickness, carried over to the band width:
  // both are fractions of the pane's half-height, so the roll-over starts as
  // far in as it did then — a wide compressed band all the way round rather
  // than a thin sheet — but measured from the rim, which is what keeps the
  // dome's circle from coming back with it.
  assert.match(filter, /NAV_BEZEL_WIDTH = 0\.85;/);
  assert.doesNotMatch(filter, /NAV_MAGNIFY|NAV_DOME|NAV_THICKNESS/);
  // The scale is derived from the measured box, not a constant: bounded by
  // the pane's half-height while objectBoundingBox resolves it against the
  // diagonal — now shared with every other card via measureGenericPanes'
  // own reduction of that same formula (see the comment there).
  assert.match(filter, /NAV_DISPLACEMENT_HEADROOM = 0\.97/);
  assert.match(filter, /GENERIC_DISPLACEMENT_HEADROOM = NAV_DISPLACEMENT_HEADROOM/);
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
  // The custom properties themselves live on .nav-menu-group, not ::before —
  // both ::before (the warped material) and .nav-menu-group-sheen (the
  // unwarped highlight, see the test below) read them by inheritance, so
  // moved to their shared ancestor rather than declared on either alone.
  const group = css.match(/\n\.nav-menu-group \{[\s\S]*?\n\}/)[0];
  assert.match(group, /--nav-wall-light: color-mix\(in srgb, white 55%/);
  assert.match(group, /--nav-wall-shade: color-mix\(in srgb, rgb\(40, 30, 22\) 20%/);
  assert.match(group, /--nav-wall-shade-soft: color-mix\(in srgb, rgb\(40, 30, 22\) 10%/);
  assert.match(group, /--nav-tint: color-mix\(/);

  const before = css.match(/\n\.nav-menu-group::before \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(before, /box-shadow:/);
  assert.match(before, /radial-gradient\(150% 140% at 50% 130%, var\(--nav-wall-shade\)/);
  // Each ellipse fades to transparent well inside its own radius, so the wall
  // eases from transparent at the card's own edge into the glow rather than
  // stopping at a hard boundary partway across it.
  assert.match(before, /var\(--nav-wall-shade\), transparent 58%/);
  // The tint sits behind the wall in the same declaration, not a separate one
  // dark theme has to reconstruct.
  assert.match(before, /var\(--nav-tint\);\s*\n\}/);

  // The top highlight is gone from both places it has ever lived: ::before's
  // own background, and the unwarped sibling child it was moved onto when
  // the SVG lens was still shearing it into a trapezoid.
  //
  // It was a 55%-white ellipse hung off the top edge, and what it produced
  // was a pale foggy patch across the upper third of every menu card — the
  // thing that makes glass read as milky instead of as something you are
  // looking through. Asserted absent rather than merely deleted, because the
  // rule was reintroduced once already as a fix for a lens artefact, and the
  // lens it was working around is itself no longer applied to any card.
  assert.doesNotMatch(before, /radial-gradient\(\s*\n\s*50% 36% at 50% -8%/);
  assert.doesNotMatch(css, /\n\.nav-menu-group-sheen \{/);

  const dark = css.match(/html\[data-theme="dark"\] \.nav-menu-group \{[\s\S]*?\n\}/)[0];
  // Only the custom properties are overridden — no background/box-shadow
  // redeclaration, so the layer structure above cannot drift from this.
  assert.doesNotMatch(dark, /\n {2}background:/);
  assert.match(dark, /--nav-wall-light: color-mix\(in srgb, white 26%/);
  assert.match(dark, /--nav-wall-shade: color-mix\(in srgb, black 30%/);
  assert.ok(
    !/white (5[0-9]|[6-9][0-9])%/.test(dark),
    "a dark-theme wall at light-theme strength reads as a second drawn border",
  );
});

test("every plain content card gets the same rim/wall lens as the nav cards, without disturbing its own background", () => {
  // .liquid-glass is deliberately excluded: several of its surfaces already
  // carry their own hand-tuned rim (the notification popover) or their own
  // separate live-refraction engine (.premade-glass), and stacking a second,
  // independent lens on either would conflict with work already done rather
  // than extend it. .card has no competing system anywhere in this file.
  //
  // .premade-glass cards (which are also .card, e.g. the dashboard's skill
  // and trend cards) DO get the wall and rim below — it is static shading
  // around their own live layer, not a second lens on top of it. Only the
  // SVG displacement filter further down excludes them, since warping
  // premade-glass's own already-displaced pixels a second time is what
  // produced visible smudging.
  const genericSelector =
    "\\.card:not\\(\\.organization-team-pairings-page\\):not\\(\\.organization-team-pairing-group\\)";
  const beforeMatch = css.match(
    new RegExp(`\\n${genericSelector}::before \\{[\\s\\S]*?\\n\\}`),
  );
  assert.ok(beforeMatch, "expected a .card::before rule for the generic lens");
  const before = beforeMatch[0];

  // Samples whatever background the element's own (untouched) rule already
  // produced, rather than redeclaring background/box-shadow itself — the
  // dozen or so contexts that set those directly on .card (dark theme, exam
  // mode, pricing, dashboard) stay exactly as they were.
  assert.doesNotMatch(before, /\n {2}background-color:/);
  // Zero radius. This asked for 1px for months on the belief that the blur
  // was what made WebKit commit the layer and so sample a backdrop at all.
  // It is not — the explicit translateZ(0) in the same rule is — so the
  // blur bought nothing and cost the one thing the lens exists to produce:
  // a line crossing the rim has to come out bent but still a line, and
  // blurring the sample first makes it arrive as a smear that happens to be
  // displaced. Proved on the theme knob, which carried the same borrowed
  // value: measured against a deliberately loud border, mushy at 1px and a
  // sharp kink at 0.
  assert.match(before, /transform: translateZ\(0\);/);
  assert.match(before, /backdrop-filter: blur\(0px\)/);
  assert.doesNotMatch(before, /backdrop-filter: blur\((?!0px)/);
  assert.match(before, /radial-gradient\(/);

  // Cards take no SVG lens at all any more, so there is no rule left for
  // .premade-glass to be excluded from.
  //
  // It was removed on look, compared side by side against the same page with
  // the filter switched off: on a card it drew a bright rounded-rectangle
  // contour standing inside the card's own outline, with the corner arc
  // visibly broken where the two disagreed. That is inherent to bucketing
  // rather than a tuning error — a pane's shape is snapped to the nearest of
  // a coarse fixed grid before its map is solved, and real cards land
  // between grid points: the account card measures a corner ratio of 0.209
  // and is served a map drawn for 0.12. A bevel solved for one arc and
  // stretched over another has to show the seam somewhere, and a large flat
  // card has nothing to hide it behind.
  //
  // The knobs keep theirs and are asserted in segmented-controls and
  // theme-toggle-press: they measure as circles, which is the one shape the
  // grid holds exactly, so there is no mismatch to see.
  const lensSelector = `${genericSelector}:not\\(\\.premade-glass\\)`;
  assert.doesNotMatch(
    css,
    new RegExp(
      `html\\[data-glass-lens-split\\] ${lensSelector}::before \\{[\\s\\S]*?filter: var\\(--glass-lens-filter, none\\);`,
    ),
  );

  const afterMatch = css.match(new RegExp(`\\n${genericSelector}::after \\{[\\s\\S]*?\\n\\}`));
  assert.ok(afterMatch, "expected a .card::after rule for the caustic rim");
  assert.match(afterMatch[0], /mask-composite: exclude/);
  assert.match(afterMatch[0], /-webkit-mask-composite: xor/);

  // The real-content z-index bump does exclude .premade-glass: its own
  // .refractive-glass-layer child already carries a hand-set position and
  // z-index that a same-specificity-or-higher rule here would override.
  assert.match(
    css,
    new RegExp(`\\n${genericSelector}:not\\(\\.premade-glass\\) > \\* \\{`),
  );

  // Only the reset (display: none) targets the bare .card::before/::after —
  // the two contexts that deliberately flatten .card to no glass at all
  // (background: transparent, backdrop-filter: none) opted out of glass
  // entirely, and a wall and a rim would quietly reintroduce it.
  const bareBefore = css.match(/\n\.card::before,?\s*\n?[^{]*\{[\s\S]*?\n\}/);
  assert.ok(bareBefore, "expected the bare .card::before reset rule");
  assert.match(bareBefore[0], /display: none;/);

  // The old Chromium-only combined-syntax rule no longer matches .card: every
  // card now carries its own split filter/backdrop-filter lens on ::before,
  // so matching it there too would double-lens it in Chromium.
  const oldRuleMatch = css.match(
    /html\[data-live-glass-refraction\] \.liquid-glass:not\(\.nav-menu-group\),\s*\nhtml\[data-live-glass-refraction\] \.premade-glass \{/,
  );
  assert.ok(oldRuleMatch, "expected the old combined-syntax rule with .card excluded");
});

test("generic cards are reduced to a small fixed grid of shapes instead of one filter per element", () => {
  assert.match(filter, /GENERIC_SELECTOR =/);
  assert.match(filter, /function measureGenericPanes/);
  assert.match(filter, /function nearest/);
  assert.match(filter, /GENERIC_ASPECT_BUCKETS/);
  assert.match(filter, /GENERIC_CORNER_BUCKETS/);
  assert.match(filter, /GENERIC_MAX_BUCKETS/);
  // Same lens physics as the nav cards — reused, not reinvented.
  assert.match(filter, /GENERIC_BEZEL_WIDTH = NAV_BEZEL_WIDTH/);
  assert.match(filter, /GENERIC_DISPLACEMENT_HEADROOM = NAV_DISPLACEMENT_HEADROOM/);
  // Scale depends only on the bucket's own aspect ratio: height cancels out
  // of both the displacement budget and the diagonal it is measured against.
  assert.match(filter, /Math\.sqrt\(2 \* \(aspect \* aspect \+ 1\)\)/);
  assert.match(filter, /--glass-lens-filter/);
  assert.match(filter, /GENERIC_FILTER_PREFIX/);
  assert.match(filter, /genericFilters\.map/);
});

test("the nav glass answers its own backdrop instead of carrying a fixed fill", () => {
  // The trait that most separates the reference material from a translucent
  // panel. A fixed fill has to be a compromise — light enough not to smother
  // a dark backdrop, dark enough to keep content legible over a bright one —
  // and it fails at both ends. Glass that answers its backdrop does neither.
  //
  // Derived rather than guessed: the filter already holds the sampled,
  // already-bent backdrop, so luminanceToAlpha turns it into a per-pixel
  // luminance mask. Black flooded through that mask veils the bright parts;
  // white flooded through its inverse — the same ramp turned over, slope -t
  // and intercept t — lifts the dark ones.
  assert.match(filter, /const NAV_ADAPTIVE_TINT = 0\.12;/);
  assert.match(filter, /const GENERIC_ADAPTIVE_TINT = 0;/);
  assert.match(filter, /const NAV_TINT_SELECTOR = "\.nav-menu-group";/);
  assert.match(filter, /type="luminanceToAlpha"/);
  assert.match(filter, /<feFuncA type="linear" slope=\{entry\.tint\} intercept="0" \/>/);
  assert.match(filter, /<feFuncA type="linear" slope=\{-entry\.tint\} intercept=\{entry\.tint\} \/>/);
  assert.match(filter, /floodColor="#000000"/);
  assert.match(filter, /floodColor="#ffffff"/);

  // Both veils are laid over the lens output, so the tint reads the bent
  // backdrop rather than the unbent page.
  assert.match(filter, /in="veil" in2="lens-out" operator="over"/);
  assert.match(filter, /in="lift" in2="veiled" operator="over"/);
  // Both branches of the dispersion split have to name their output, or the
  // tint stage would chain off nothing for cards.
  assert.match(filter, /mode="screen" result="lens-out"/);
  assert.match(filter, /yChannelSelector="G"\s*\n\s*result="lens-out"/);

  // Tint is part of the bucket identity, so a plain card can never inherit
  // the nav's tinted filter by measuring the same shape.
  assert.match(filter, /function bucketKey\([\s\S]{0,220}tint: number,/);
  assert.match(filter, /pane\.matches\(NAV_TINT_SELECTOR\) \? NAV_ADAPTIVE_TINT : GENERIC_ADAPTIVE_TINT/);
  // Deliberately not sitewide: `.card` is ~90 usages and mostly sits on the
  // page's own wash, where there is little for this to answer.
  assert.match(filter, /entry\.tint > 0 \?/);
});

test("the highlight is solved from the pane's shape, not drawn across it", () => {
  // A painted highlight cannot know what it is lighting: one gradient reads
  // plausibly on a circle and wrongly on a wide card, because a highlight is
  // not an angle across the face — it is wherever the surface turns toward
  // the light, which depends entirely on the shape's curvature.
  //
  // That curvature is already in the normal map, so the highlight is a dot
  // product against a light direction, which is what feColorMatrix's alpha
  // row computes. Light from the upper left is (0.5 - R) + (0.5 - G).
  assert.match(filter, /const KNOB_SPECULAR = 3;/);
  assert.match(filter, /const GENERIC_SPECULAR = 0;/);
  assert.match(filter, /in="generic-normal-map"[\s\S]{0,200}\$\{-entry\.specular\} \$\{-entry\.specular\} 0 0 \$\{entry\.specular\}/);
  assert.match(filter, /result="specular-mask"/);
  assert.match(filter, /in="specular-light"\s*\n\s*in2="specular-mask"\s*\n\s*operator="in"/);

  // The coefficient compensates for the map storing normal TIMES bend
  // magnitude rather than a unit normal — the rim deviates only about 30/255
  // at its peak — but it is deliberately small.
  //
  // 12 made a bright white crescent, and against the reference that is
  // plainly wrong: there the rim is very nearly invisible, and the glass is
  // read from the backdrop bending through it and a whisper of colour at the
  // very edge, never from a lit ring drawn around it. A white arc on a dark
  // bar reads as a halo stuck to the knob rather than as light on a curve.
  //
  // It went 12, then 3, then off, then back to 3. Turning it off was a
  // performance decision — the stage is four filter primitives re-run on
  // every frame a lens moves — and it cost more than it saved: with it gone
  // the bent edge inside the knob read as lumpy rather than smooth, which
  // is what the highlight had been quietly carrying. Off is cheaper and
  // worse, so it stays on at the lowest strength that does the job.
  assert.ok(filter.includes("const KNOB_SPECULAR = 3;"));

  // It lays over whichever stage actually ran, so tint and specular compose
  // rather than one silently replacing the other.
  assert.match(filter, /in2=\{entry\.tint > 0 \? "tinted-out" : "lens-out"\}/);
  // Part of the bucket identity, so a card cannot inherit it by shape.
  assert.match(filter, /function bucketKey\([\s\S]{0,280}specular: number,/);
  assert.match(filter, /const specular = knob \? KNOB_SPECULAR : GENERIC_SPECULAR;/);
});

test("the knob lenses its whole face, so nothing inside stays where it was", () => {
  // A bevel alone bends only its own band, which is right for a flat pane
  // but leaves a line crossing the middle running dead straight — the same
  // line visible twice, bent where it meets the rim and untouched between.
  // The reference has no such remnant: everything behind the glass is
  // displaced, because the whole face works rather than only its edge.
  //
  // This is the `magnify` term the map has always carried and never used: a
  // straight ramp along the inward normal, nothing at the centre, growing to
  // its full value at the rim. It pulls inward, so every sample stays on the
  // pane.
  assert.match(filter, /const KNOB_MAGNIFY = 0\.2;/);
  assert.match(filter, /const GENERIC_MAGNIFY = 0;/);
  assert.match(filter, /const magnify = knob \? KNOB_MAGNIFY : GENERIC_MAGNIFY;/);
  assert.match(filter, /magnify: bucket\.magnify,/);
  assert.match(filter, /function bucketKey\([\s\S]{0,340}magnify: number,/);

  // Only the knob. magnify is measured from the centre outward, and on a
  // rounded rectangle that traces the panel's own contour into the face —
  // the pale shape that got dome and magnify dropped from the cards. On a
  // circle that contour is concentric with the rim, so there is no shape to
  // see: it is the knob.
  const size = 192;
  const circle = glassRefractionModule.createGlassRefractionMap(size, {
    aspect: 1,
    cornerRadius: 0.98,
    bezelWidth: 0.5,
    magnify: 0.2,
    maxDisplacement: 0.97 / Math.sqrt(2 * 2),
  });
  const at = (x, y) => pixel(circle, size, x, y).slice(0, 2).map((c) => c - 128);
  // Dead centre still does not move — which is why an icon sitting there
  // comes through undistorted.
  assert.deepEqual(at(size / 2, size / 2), [0, 0]);
  // But a point well inside the old flat middle now does, which is the whole
  // point: the bevel alone left this at zero.
  const midway = at(size / 2, Math.round(size * 0.3));
  assert.ok(Math.abs(midway[1]) > 2, `the face should lens, got ${midway}`);
});

test("the knob's bevel eases its handover, while cards keep their depth", () => {
  // The quarter-circle profile falls to zero linearly as the glass thickens
  // inward, so where the band ends its slope drops from something to nothing
  // in one step. That is a corner in the surface, and on the knob it shows: a
  // straight line passing under the rim came through bent as far as the band
  // reached and then abruptly straight, kinked partway along rather than
  // curving once.
  //
  // Measured as the largest jump in slope along a line running inward, as a
  // ratio against the typical jump so it does not depend on absolute scale.
  const size = 512;
  const aspect = 1;
  const shape = {
    aspect,
    cornerRadius: 0.98,
    bezelWidth: 0.5,
    magnify: 0.2,
    maxDisplacement: 0.97 / Math.sqrt(2 * (aspect * aspect + 1)),
  };
  const creaseOf = (innerEase) => {
    const map = glassRefractionModule.createGlassRefractionMap(size, { ...shape, innerEase });
    const walk = [];
    // Started inside the pane's own edge: that boundary is a genuine step,
    // since the map is neutral outside the shape and magnify is already at
    // full strength just within it.
    for (let y = Math.round(size * 0.03); y < size * 0.35; y += 1) {
      walk.push((pixel(map, size, size / 2, y)[1] - 128) / 127);
    }
    const slope = walk.slice(1).map((v, i) => v - walk[i]);
    const change = slope.slice(1).map((v, i) => Math.abs(v - slope[i]));
    return Math.max(...change) / (change.reduce((a, b) => a + b, 0) / change.length);
  };

  assert.ok(creaseOf(1) < creaseOf(0) * 0.8, "easing should measurably soften the handover");
  assert.ok(creaseOf(1) < 9, `the knob should hand over smoothly, got ${creaseOf(1).toFixed(1)}x`);

  // Off by default, because it is not free: easing costs reach, and that
  // depth is the whole point of the thick slab. Cards are large and sit over
  // busy backdrops, where the crease has nothing straight running under it
  // to reveal itself against.
  assert.match(filter, /const KNOB_INNER_EASE = 1;/);
  assert.match(filter, /const GENERIC_INNER_EASE = 0;/);
  assert.match(filter, /const innerEase = knob \? KNOB_INNER_EASE : GENERIC_INNER_EASE;/);
  assert.match(filter, /innerEase: bucket\.innerEase,/);
  const source = readFileSync(join(process.cwd(), "lib", "glass-refraction.ts"), "utf8");
  assert.match(source, /innerEase = 0,/);
});
