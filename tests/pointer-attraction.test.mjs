import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
