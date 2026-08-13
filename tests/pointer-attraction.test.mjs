import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { boundedTouchCardTransform } = await import(
  pathToFileURL(join(process.cwd(), "lib", "pointer-attraction.ts")).href
);

function transformedAxis(size, drift, scale, originPercent) {
  const origin = size * originPercent / 100;
  const start = drift + origin * (1 - scale);
  return { start, end: start + size * scale };
}

test("touch attraction never paints outside the card layout box", () => {
  for (const x of [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]) {
    for (const y of [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]) {
      const response = boundedTouchCardTransform(x, y, 320, 84);
      const horizontal = transformedAxis(320, response.driftX, response.scaleX, response.originX);
      const vertical = transformedAxis(84, response.driftY, response.scaleY, response.originY);
      assert.ok(horizontal.start >= -1e-9);
      assert.ok(horizontal.end <= 320 + 1e-9);
      assert.ok(vertical.start >= -1e-9);
      assert.ok(vertical.end <= 84 + 1e-9);
    }
  }
});

test("touch attraction clamps fingers dragged beyond the card", () => {
  assert.deepEqual(
    boundedTouchCardTransform(4, -3, 320, 84),
    boundedTouchCardTransform(1, -1, 320, 84),
  );
});

test("only bounded interactive controls keep pointer attraction", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "PointerAttraction.tsx"),
    "utf8",
  );
  assert.match(source, /MAX_CARD_WIDTH = 560/);
  assert.match(source, /MAX_CARD_HEIGHT = 190/);
  assert.match(source, /\[data-pointer-attract\], button, a\[href\], summary/);
  assert.doesNotMatch(source, /const TARGET = .*\.card/);
  assert.match(source, /it is an actual control/);
});

test("all glass reflection is delegated to one visible, power-aware surface", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "PointerAttraction.tsx"),
    "utf8",
  );
  assert.match(source, /GLASS_SURFACE = "\.card, \.liquid-glass, \.premade-glass/);
  assert.match(source, /REFLECTION_FRAME_MS = 32/);
  assert.match(source, /MAX_REFLECTION_DEVICE_PIXELS = 1_250_000/);
  assert.equal((source.match(/document\.addEventListener\("pointermove"/g) ?? []).length, 1);
  assert.match(source, /connection\?\.saveData/);
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(source, /prefers-reduced-transparency: reduce/);
  assert.match(source, /rect\.width \* rect\.height \* dpr \* dpr <= MAX_REFLECTION_DEVICE_PIXELS/);
  assert.match(source, /rect\.bottom > 0[\s\S]*rect\.top < window\.innerHeight/);
  assert.match(source, /Math\.round\(Math\.max\(0, Math\.min\(100/);
  assert.match(source, /target === current/);
  assert.ok(source.indexOf("timestamp - lastReflectionPaint") < source.indexOf("const rect = glassSurface.getBoundingClientRect()"));
});
