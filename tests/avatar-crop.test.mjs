/*
  The profile-picture crop, which is the half of the avatar editor that can be
  checked without a browser.

  Everything else about that editor — pointer capture, pinch, the circle drawn
  over the square — needs a real pointing device to exercise and is verified by
  hand. The arithmetic is the part where a mistake is silent: a crop rectangle
  that strays a fraction of a pixel outside the source does not throw, it draws
  an empty strip down one edge, which the JPEG encoder then flattens onto the
  white base and turns into a visible band on somebody's face. So the property
  asserted hardest here is the dull one — whatever the zoom, whatever the drag,
  the crop stays inside the picture.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const {
  CENTRED,
  MAX_ZOOM,
  MIN_ZOOM,
  MIN_OUTPUT_SIZE,
  OUTPUT_SIZE,
  STAGE,
  clampView,
  coverScale,
  cropRect,
  outputSize,
  placement,
  zoomAround,
} = await import(
  pathToFileURL(join(process.cwd(), "components", "account", "crop.ts")).href
);
const { TARGET_BYTES, renderCrop } = await import(
  pathToFileURL(join(process.cwd(), "components", "account", "condense.ts")).href
);

/** Every shape a learner might plausibly hand the editor. */
const IMAGES = [
  { w: 4032, h: 3024, note: "a phone photo, landscape" },
  { w: 3024, h: 4032, note: "the same phone, held upright" },
  { w: 1000, h: 1000, note: "already square" },
  { w: 6000, h: 800, note: "a panorama" },
  { w: 90, h: 140, note: "a tiny old thumbnail" },
];

test("at rest the crop is the largest centred square the picture allows", () => {
  const landscape = cropRect(CENTRED, 4000, 3000);
  assert.equal(landscape.size, 3000);
  assert.equal(landscape.x, 500);
  assert.equal(landscape.y, 0);

  const portrait = cropRect(CENTRED, 3000, 4000);
  assert.equal(portrait.size, 3000);
  assert.equal(portrait.x, 0);
  assert.equal(portrait.y, 500);

  const square = cropRect(CENTRED, 800, 800);
  assert.deepEqual(square, { x: 0, y: 0, size: 800 });
});

test("the crop never leaves the picture, however far it is dragged or zoomed", () => {
  // The offsets tried are deliberately far beyond anything clampView allows,
  // because that is exactly what a fast drag produces: the handler adds a
  // whole gesture's worth of movement in one go and relies on the clamp.
  const offsets = [-100000, -STAGE, -137, 0, 137, STAGE, 100000];
  const zooms = [MIN_ZOOM, 1.3, 2, 3.7, MAX_ZOOM, 99];

  for (const { w, h, note } of IMAGES) {
    for (const zoom of zooms) {
      for (const x of offsets) {
        for (const y of offsets) {
          const crop = cropRect({ zoom, x, y }, w, h);
          assert.ok(crop.size > 0, `${note}: empty crop`);
          assert.ok(crop.x >= 0, `${note}: crop starts left of the picture`);
          assert.ok(crop.y >= 0, `${note}: crop starts above the picture`);
          assert.ok(crop.x + crop.size <= w + 1e-9, `${note}: crop runs off the right`);
          assert.ok(crop.y + crop.size <= h + 1e-9, `${note}: crop runs off the bottom`);
        }
      }
    }
  }
});

test("zoom is held between one and the ceiling", () => {
  assert.equal(clampView({ zoom: 0.2, x: 0, y: 0 }, 1000, 1000).zoom, MIN_ZOOM);
  assert.equal(clampView({ zoom: 50, x: 0, y: 0 }, 1000, 1000).zoom, MAX_ZOOM);
  // Below 1 the picture would stop filling the square and the saved avatar
  // would have blank edges, which is never what anyone chose.
  assert.equal(MIN_ZOOM, 1);
});

test("a square picture at rest cannot be dragged at all", () => {
  // There is nothing outside the crop to bring into it, so every offset
  // collapses to zero rather than sliding the picture off its own edge.
  const view = clampView({ zoom: 1, x: 400, y: -900 }, 1200, 1200);
  assert.equal(view.x, 0);
  assert.equal(view.y, 0);
});

test("zooming in takes less of the picture, not more", () => {
  const wide = cropRect({ zoom: 1, x: 0, y: 0 }, 4032, 3024);
  const closer = cropRect({ zoom: 2, x: 0, y: 0 }, 4032, 3024);
  const closest = cropRect({ zoom: MAX_ZOOM, x: 0, y: 0 }, 4032, 3024);
  assert.ok(closer.size < wide.size);
  assert.ok(closest.size < closer.size);
  assert.equal(Math.round(closer.size), Math.round(wide.size / 2));
});

test("dragging right shows what was to the left", () => {
  const rest = cropRect({ zoom: 2, x: 0, y: 0 }, 4000, 3000);
  const dragged = cropRect({ zoom: 2, x: 200, y: 0 }, 4000, 3000);
  assert.ok(dragged.x < rest.x);
  assert.equal(dragged.size, rest.size);
});

test("a pinch keeps the point between the fingers where it was", () => {
  /*
    The property that makes a pinch feel right: whatever source pixel sits
    under the midpoint of two fingers must still sit under it after the zoom.
    Without it the picture creeps away from the face somebody is framing and
    they end up chasing it around the square.
  */
  const w = 4032;
  const h = 3024;
  const view = { zoom: 1.5, x: 60, y: -40 };
  const pointX = 120;
  const pointY = -85;

  const before = coverScale(w, h) * view.zoom;
  const sourceX = (pointX - view.x) / before + w / 2;

  const after = zoomAround(view, w, h, 2.4, pointX, pointY);
  const scaleAfter = coverScale(w, h) * after.zoom;
  const screenX = (sourceX - w / 2) * scaleAfter + after.x;

  assert.ok(Math.abs(screenX - pointX) < 1e-6, `moved to ${screenX}, wanted ${pointX}`);
  assert.equal(after.zoom, 2.4);
});

test("a pinch past the ceiling stops zooming and stops drifting", () => {
  // Clamping the zoom after working out the ratio, rather than before, left
  // the picture sliding under fingers that were no longer changing anything.
  const view = { zoom: MAX_ZOOM, x: 30, y: 30 };
  const pushed = zoomAround(view, 4000, 3000, MAX_ZOOM * 3, 200, 200);
  assert.equal(pushed.zoom, MAX_ZOOM);
  assert.equal(pushed.x, view.x);
  assert.equal(pushed.y, view.y);
});

test("the saved square follows the crop and is never inflated", () => {
  assert.equal(OUTPUT_SIZE, 256);
  // The largest avatar is 64 CSS px, so this still exceeds a 3x phone screen.
  assert.ok(OUTPUT_SIZE >= 64 * 3);
  assert.equal(TARGET_BYTES, 96 * 1024);
  assert.equal(outputSize(4000), OUTPUT_SIZE);
  assert.equal(outputSize(OUTPUT_SIZE), OUTPUT_SIZE);
  // A 200-pixel crop stays 200: enlarging it would invent detail that was
  // never in the file and cost the learner bytes for the privilege.
  assert.equal(outputSize(200), 200);
  assert.equal(outputSize(12), MIN_OUTPUT_SIZE);
});

test("the browser uploads a small WebP thumbnail", async () => {
  const previousDocument = globalThis.document;
  const canvases = [];
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          fillRect() {},
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          fillStyle: "",
        }),
        toBlob(callback, mime) {
          callback(new Blob([new Uint8Array(18 * 1024)], { type: mime }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };

  try {
    const result = await renderCrop(
      { element: {}, url: "blob:test", width: 4000, height: 3000, release() {} },
      CENTRED,
    );
    assert.equal(result.type, "image/webp");
    assert.ok(result.size <= TARGET_BYTES);
    assert.equal(canvases.at(-1).width, OUTPUT_SIZE);
    assert.equal(canvases.at(-1).height, OUTPUT_SIZE);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("JPEG remains a fallback when a browser cannot encode WebP", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          fillRect() {},
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          fillStyle: "",
        }),
        toBlob(callback, mime) {
          const actual = mime === "image/webp" ? "image/png" : mime;
          callback(new Blob([new Uint8Array(24 * 1024)], { type: actual }));
        },
      };
    },
  };

  try {
    const result = await renderCrop(
      { element: {}, url: "blob:test", width: 1200, height: 1200, release() {} },
      CENTRED,
    );
    assert.equal(result.type, "image/jpeg");
    assert.ok(result.size <= TARGET_BYTES);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("at rest the picture exactly covers the square and no more", () => {
  for (const { w, h, note } of IMAGES) {
    const spot = placement(CENTRED, w, h);
    const shorter = Math.min(spot.width, spot.height);
    const longer = Math.max(spot.width, spot.height);
    assert.ok(Math.abs(shorter - 1) < 1e-9, `${note}: leaves a gap or overshoots`);
    assert.ok(longer >= 1 - 1e-9, `${note}: does not fill the square`);
    // Centred: whatever hangs over one edge hangs over the other equally.
    assert.ok(Math.abs(spot.left + spot.width / 2 - 0.5) < 1e-9, `${note}: off-centre`);
    assert.ok(Math.abs(spot.top + spot.height / 2 - 0.5) < 1e-9, `${note}: off-centre`);
  }
});

test("the picture always covers the square, at any zoom or offset", () => {
  // If it ever failed to, the saved avatar would have a transparent edge —
  // which becomes a black band once it is flattened for JPEG.
  for (const { w, h, note } of IMAGES) {
    for (const zoom of [1, 1.7, MAX_ZOOM]) {
      for (const x of [-9999, 0, 9999]) {
        const spot = placement({ zoom, x, y: x }, w, h);
        assert.ok(spot.left <= 1e-9, `${note}: a gap on the left`);
        assert.ok(spot.top <= 1e-9, `${note}: a gap on the top`);
        assert.ok(spot.left + spot.width >= 1 - 1e-9, `${note}: a gap on the right`);
        assert.ok(spot.top + spot.height >= 1 - 1e-9, `${note}: a gap on the bottom`);
      }
    }
  }
});

test("nonsense numbers do not become NaN somewhere further down", () => {
  // A pointer event on a stage that is still zero pixels wide produced
  // Infinity here once, and an Infinity in a CSS percentage renders nothing
  // at all rather than failing loudly.
  const view = clampView({ zoom: Number.NaN, x: Number.POSITIVE_INFINITY, y: -0 / 0 }, 2000, 1000);
  assert.ok(Number.isFinite(view.zoom));
  assert.ok(Number.isFinite(view.x));
  assert.ok(Number.isFinite(view.y));

  const crop = cropRect(view, 2000, 1000);
  assert.ok(Number.isFinite(crop.x) && Number.isFinite(crop.y) && Number.isFinite(crop.size));
});
