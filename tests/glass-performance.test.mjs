import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

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

test("the capability rule outlived the third-party layer it was written for", () => {
  /*
    This once guarded a shared store that decided whether to mount a
    third-party displacement pane at all. Both that pane and its gate are
    deleted: refraction was dropped across the site because it made glass look
    fogged, not because of what it cost, so there is no longer a heavy subtree
    to keep off weak hardware.

    The rule above survives on its own merits, and the assertions here check it
    kept exactly one consumer — the option-bar knob's lens, the one piece of
    refraction deliberately left in place. Guarding that is still worth doing:
    it is a live filter, just a small one over a disc it fully covers rather
    than a card-sized pane over page content.
  */
  assert.equal(existsSync(join(process.cwd(), "components", "RefractiveGlassLayer.tsx")), false);
  assert.equal(existsSync(join(process.cwd(), "components", "GlassPerformanceGate.tsx")), false);

  const knobLens = readFileSync(join(process.cwd(), "components", "GlassRefractionFilter.tsx"), "utf8");
  assert.match(knobLens, /supportsDetailedGlass/);
  assert.match(knobLens, /GLASS_PERFORMANCE_QUERY/);
  assert.match(knobLens, /prefers-reduced-transparency: reduce/);
});
