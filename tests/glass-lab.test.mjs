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

test("the enhanced rim went with the layer it was drawn on", () => {
  const css = read("app", "globals.css");

  /*
    This used to open the enhanced rim's rule and check its two radial
    gradients, its mask pair and the coarse-pointer query that switched it off.
    The rim was painted as an ::after on the refraction layer, so it could not
    outlive it, and the layer was removed because the owner rejected refraction
    on look: it made glass read as fog rather than as something clear.

    Checked by absence rather than dropped, because the rim was the most
    convincing part of the experiment and is the piece most likely to be
    reached for again. Bringing it back means giving it a surface of its own
    first, not re-attaching it to a lens.
  */
  assert.doesNotMatch(css, /data-optics/);
  assert.doesNotMatch(css, /--glass-rim-lit|--glass-rim-shade/);
});

test('optics="enhanced" has no call sites left anywhere', () => {
  /*
    The count this guards used to be one — the organisation view tabs, the last
    surface still opted into the enhanced treatment. It is zero now: the prop
    was only ever read by the refraction layer, and that went with the rest of
    the site's refraction, which the owner turned down for fogging the very
    surfaces it was supposed to make glassy.

    The sweep is kept, rather than the test deleted, because it is the cheap
    way to catch the experiment creeping back one call site at a time — which
    is exactly how it spread the first time.
  */
  const roots = [join(process.cwd(), "app"), join(process.cwd(), "components")];
  const hits = roots.flatMap(tsxFiles).flatMap((path) => {
    const count = (readFileSync(path, "utf8").match(/optics="enhanced"/g) ?? []).length;
    return count > 0 ? [{ file: path.slice(process.cwd().length + 1), count }] : [];
  });

  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  assert.equal(
    total,
    0,
    `expected no occurrences of optics="enhanced", found ${total} (${hits.map((hit) => `${hit.file}: ${hit.count}`).join(", ")})`,
  );
});

test("the full-viewport navigation lens is not mounted at all, in any build", () => {
  // The nav sheet lost its lens before the rest of the site did, and for its
  // own reason: it was the one full-viewport surface the layer was ever asked
  // to cover, and the package's centring left it covering only the middle of
  // the sheet on a real device. That head start is now moot — refraction is
  // gone everywhere, rejected on look — but the header is still worth pinning,
  // because a full-viewport lens is the single most expensive thing this page
  // could be made to paint. The CSS blur on .nav-paper covers the sheet.
  const header = read("components", "SiteHeader.tsx");
  assert.doesNotMatch(header, /import \{ GLASS_LAB \} from "@\/lib\/glass-lab";/);
  assert.doesNotMatch(header, /RefractiveGlassLayer/);
});

test("nothing imports the displacement package any more, and it is out of the manifest", () => {
  /*
    What this checked was that the enhanced variant stayed pure CSS: the
    third-party layer's pointer was frozen, its elasticity zeroed and its
    shader mode never switched on, so the look came from stylesheet rules
    rather than from the package animating anything.

    The layer is deleted and the package with it. Kept as a dependency check
    because that is the durable version of the same guarantee — a package that
    is not installed cannot start animating anything — and because the removal
    of the manifest entry is the part a lockfile update could quietly undo.
  */
  const roots = [join(process.cwd(), "app"), join(process.cwd(), "components")];
  for (const path of roots.flatMap(tsxFiles)) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /from "liquid-glass-react"|import\("liquid-glass-react"\)/,
      `${path.slice(process.cwd().length + 1)} still imports liquid-glass-react`,
    );
  }
  const pkg = JSON.parse(read("package.json"));
  assert.equal("liquid-glass-react" in (pkg.dependencies ?? {}), false);
  assert.equal("liquid-glass-react" in (pkg.devDependencies ?? {}), false);
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
