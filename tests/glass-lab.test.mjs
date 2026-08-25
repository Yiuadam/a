import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { GLASS_LAB, resolveOptics } = await import(
  pathToFileURL(join(process.cwd(), "lib", "glass-lab.ts")).href
);

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const end = css.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${selector} rule`);
  return css.slice(start, end + 2);
}

function tsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

test("resolveOptics only reaches \"enhanced\" when the caller asks for it and the build flag agrees", () => {
  // A caller can request the enhanced treatment in any build; only a build
  // made with the flag set is allowed to honour that request.
  assert.equal(resolveOptics("enhanced", false), "standard");
  assert.equal(resolveOptics("enhanced", true), "enhanced");
  // A build with the flag set still renders standard optics for a surface
  // that never opted in, and for one that opted in explicitly.
  assert.equal(resolveOptics(undefined, true), "standard");
  assert.equal(resolveOptics("standard", true), "standard");
});

test("the experiment is off by default, because nothing in this test run sets NEXT_PUBLIC_GLASS_LAB", () => {
  assert.equal(GLASS_LAB, false);
});

test("the enhanced rim reuses the delegated reflection engine and disables under the same power-aware query as everything else", () => {
  const css = read("app", "globals.css");
  const rim = rule(css, '.refractive-glass-layer[data-optics="enhanced"]::after');

  // The rim paints from --glass-reflection-x/y rather than owning any pointer
  // math of its own, so it is riding the coordinates PointerAttraction was
  // already writing for the adaptive background reflection.
  assert.match(rim, /var\(--glass-reflection-x/);
  assert.match(rim, /var\(--glass-reflection-y/);
  // The gradient-border technique lives or dies on the mask pair.
  assert.match(rim, /mask-composite:\s*exclude/);
  assert.match(rim, /-webkit-mask-composite:\s*xor/);

  /*
    Two rules share the exact same coarse-pointer/reduced-motion query text
    in this file, so the check below anchors on the enhanced rim's selector
    landing immediately inside a media block's opening brace (only
    whitespace between them) rather than merely appearing somewhere after it
    — otherwise this could pass by matching the unrelated, pre-existing
    "Adaptive background reflection" query instead of the one guarding the
    lab rules.
  */
  assert.match(
    css,
    /@media \(hover: none\), \(pointer: coarse\), \(prefers-reduced-motion: reduce\), \(prefers-reduced-transparency: reduce\) \{\s*\.refractive-glass-layer\[data-optics="enhanced"\]::after \{\s*display: none;\s*\}\s*\.refractive-glass-layer\[data-optics="enhanced"\] > \.refractive-glass-core \{\s*scale: 1;\s*\}\s*\}/,
  );
});

test('optics="enhanced" is opted into by exactly one call site: the organisation view tabs', () => {
  // The other of the original two, the homepage placement CTA
  // (IntentPrefetchLink href="/placement" in PlacementHero), no longer
  // exists — the free Pro trial poster took over that slot in the
  // dashboard, always, and its own buttons are plain btn-primary/
  // btn-secondary rather than the premade-glass treatment PlacementHero
  // used. Whether the poster's primary action should opt into the
  // enhanced budget is a design call for whoever next revisits this list,
  // not something this rename should decide on its own.
  const roots = [join(process.cwd(), "app"), join(process.cwd(), "components")];
  const hits = roots.flatMap(tsxFiles).flatMap((path) => {
    const count = (readFileSync(path, "utf8").match(/optics="enhanced"/g) ?? []).length;
    return count > 0 ? [{ file: path.slice(process.cwd().length + 1), count }] : [];
  });

  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  assert.equal(
    total,
    1,
    `expected exactly 1 occurrence of optics="enhanced", found ${total} (${hits.map((hit) => `${hit.file}: ${hit.count}`).join(", ")})`,
  );
  assert.deepEqual(
    hits.map((hit) => hit.file).sort(),
    ["components/organization/OrganizationPortal.tsx"],
  );
});

test("the full-viewport navigation lens is not mounted at all under the lab flag, not merely hidden", () => {
  const header = read("components", "SiteHeader.tsx");
  assert.match(header, /import \{ GLASS_LAB \} from "@\/lib\/glass-lab";/);
  assert.match(header, /\{!GLASS_LAB && <RefractiveGlassLayer radius=\{0\} interactive \/>\}/);
});

test("the enhanced variant is pure CSS: the package's frozen pointer and cornerRadius still stand and no shader mode was enabled", () => {
  const layer = read("components", "RefractiveGlassLayer.tsx");
  assert.match(layer, /elasticity=\{0\}/);
  assert.match(layer, /globalMousePos=\{STILL_POINTER\}/);
  assert.match(layer, /mouseOffset=\{STILL_POINTER\}/);
  assert.doesNotMatch(layer, /mode=(?:"shader"|'shader')/);
});

test("the ruled test backdrop only exists when the layout is built with the flag", () => {
  const layout = read("app", "layout.tsx");
  /* The attribute has to be undefined rather than false when the flag is off:
     `data-glass-lab={false}` would still render an attribute in some React
     versions, and an empty one is exactly what the CSS matches. */
  assert.match(layout, /data-glass-lab=\{GLASS_LAB \? "" : undefined\}/);
  assert.match(layout, /import \{ GLASS_LAB \} from "@\/lib\/glass-lab";/);

  const css = read("app", "globals.css");
  assert.match(css, /body\[data-glass-lab\] \{/);
  assert.match(css, /html\[data-theme="dark"\] body\[data-glass-lab\] \{/);
  /* Painted as the body's own background-image, because a negative-z
     pseudo-element is covered by the body's opaque background colour. */
  assert.doesNotMatch(css, /body\[data-glass-lab\]::after/);
});

test("the Worker's generated types are produced by the build rather than assumed to exist", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.types, "wrangler types");
  /* CI runs `npm run build` before `cf:build`, and the preview workflow runs
     only `cf:build`. Both have to generate the types or one of them fails on a
     clean checkout, which is exactly how this branch first went red. */
  assert.match(pkg.scripts.prebuild, /npm run types/);
  assert.match(pkg.scripts["cf:build"], /npm run types/);
  assert.match(read(".gitignore"), /^worker-configuration\.d\.ts$/m);
});
