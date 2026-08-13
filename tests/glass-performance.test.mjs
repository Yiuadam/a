import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { supportsDetailedGlass } = await import(
  pathToFileURL(join(process.cwd(), "lib", "glass-performance.ts")).href
);

const capable = {
  finePointer: true,
  reducedMotion: false,
  reducedTransparency: false,
  saveData: false,
  memoryGb: 8,
  cores: 8,
};

test("the detailed SVG glass tier is unavailable on power-sensitive devices", () => {
  assert.equal(supportsDetailedGlass(capable), true);
  assert.equal(supportsDetailedGlass({ ...capable, finePointer: false }), false);
  assert.equal(supportsDetailedGlass({ ...capable, reducedMotion: true }), false);
  assert.equal(supportsDetailedGlass({ ...capable, reducedTransparency: true }), false);
  assert.equal(supportsDetailedGlass({ ...capable, saveData: true }), false);
  assert.equal(supportsDetailedGlass({ ...capable, memoryGb: 4 }), false);
  assert.equal(supportsDetailedGlass({ ...capable, cores: 4 }), false);
});

test("unknown desktop hardware keeps progressive enhancement available", () => {
  assert.equal(supportsDetailedGlass({ ...capable, memoryGb: null, cores: null }), true);
});

test("the third-party SVG tree is conditionally mounted through one shared store", () => {
  const layer = readFileSync(join(process.cwd(), "components", "RefractiveGlassLayer.tsx"), "utf8");
  const gate = readFileSync(join(process.cwd(), "components", "GlassPerformanceGate.tsx"), "utf8");
  assert.match(layer, /<GlassPerformanceGate>/);
  assert.match(gate, /useSyncExternalStore/);
  assert.match(gate, /return enabled \? children : null/);
  assert.match(gate, /listeners = new Set/);
  assert.match(gate, /listeners\.size === 0/);
  assert.match(gate, /prefers-reduced-transparency: reduce/);
});
