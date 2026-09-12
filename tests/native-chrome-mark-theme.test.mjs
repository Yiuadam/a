/*
  The native header's logo, per theme — not one raster for all three.

  Reported directly: "the xcode build is not up to date, all the theme
  logos". It was not a stale build; the native bar's mark was a single
  imageset, BandUpMark, baked once from Warm and asked for regardless of
  `selectedTheme` — so Light and Dark always showed the Warm-coloured mark,
  on every build, correctly, because that is what the code asked for.

  components/BandUpMark.tsx solved exactly this problem on the website by
  drawing the mark as real SVG reading CSS custom properties rather than a
  raster, and its own comment is explicit about the wrong fix: "the only way
  to move a raster's colours is a filter, which turns a chosen palette into
  whatever hue-rotate happens to give." A raster still can't read a custom
  property, so the native fix is that same answer applied here — one baked
  imageset per theme, from the same three colour sets, rather than a filter
  over the one that already existed.
*/
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const swift = read("ios", "App", "App", "NativeChromeView.swift");
const globals = read("app", "globals.css");

test("the old single, theme-blind imageset is gone", () => {
  const catalog = join(root, "ios", "App", "App", "Assets.xcassets");
  assert.ok(!existsSync(join(catalog, "BandUpMark.imageset")));
});

test("all three themes have their own imageset, at the three sizes the header actually needs", () => {
  const catalog = join(root, "ios", "App", "App", "Assets.xcassets");
  for (const theme of ["Warm", "Light", "Dark"]) {
    const dir = join(catalog, `BandUpMark${theme}.imageset`);
    assert.ok(existsSync(dir), `BandUpMark${theme}.imageset is missing`);
    const contents = JSON.parse(readFileSync(join(dir, "Contents.json"), "utf8"));
    const scales = contents.images.map((i) => i.scale).sort();
    assert.deepEqual(scales, ["1x", "2x", "3x"]);
    for (const image of contents.images) {
      assert.ok(
        existsSync(join(dir, image.filename)),
        `${theme}'s Contents.json names ${image.filename}, which is not in the imageset`,
      );
    }
  }
});

test("markImageName(for:) is the one place a theme name becomes a catalog entry", () => {
  const fn = swift.slice(
    swift.indexOf("static func markImageName(for theme: String) -> String {"),
  );
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /case "light": return "BandUpMarkLight"/);
  assert.match(body, /case "dark": return "BandUpMarkDark"/);
  assert.match(body, /default: return "BandUpMarkWarm"/);
});

test("both places the logo is ever set read markImageName(for:), and neither still hardcodes the old name", () => {
  assert.doesNotMatch(swift, /UIImage\(named: "BandUpMark"\)/);
  assert.equal(
    (swift.match(/logoView\.image = UIImage\(named: NativeChromeView\.markImageName\(for: selectedTheme\)\)/g) ?? [])
      .length,
    2,
    "expected exactly two call sites: initial build(), and every applyTheme()",
  );
});

test("the three theme colour sets baked into the PNGs are the same three globals.css defines for the web mark", () => {
  /*
    Not re-derived from memory — read back from the one file both the web
    component and the native generator are meant to agree with, so a future
    change to a theme's palette in globals.css has something here that would
    go stale rather than silently drift, the same way the raster itself just
    did once already.
  */
  const values = {
    warm: { near: "#a9784a", mid: "#87582f", far: "#603a1c", sheet: "#e09a5a", paper: "#fdf8f0" },
    light: { near: "#dbe3f5", mid: "#c2cdea", far: "#a6b4dd", sheet: "#5866c2", paper: "#fbfcfe" },
    dark: { near: "#2a2019", mid: "#16110d", far: "#090706", sheet: "#d9813f", paper: "#f3ebdd" },
  };
  // Each `--mark-ground-near` declaration anchors its own rule block — found
  // by the value rather than by which selector owns it, since Warm's is a
  // bare `:root` among several in this file and the other two are scoped
  // to `html[data-theme="..."]`, three different shapes of "this block".
  for (const [theme, expected] of Object.entries(values)) {
    const anchor = `--mark-ground-near: ${expected.near};`;
    const at = globals.indexOf(anchor);
    assert.ok(at > -1, `${theme}'s ground colour ${expected.near} is not in globals.css at all`);
    const block = globals.slice(at, globals.indexOf("}", at) + 1);
    assert.match(block, new RegExp(`--mark-ground-mid: ${expected.mid};`), theme);
    assert.match(block, new RegExp(`--mark-ground-far: ${expected.far};`), theme);
    assert.match(block, new RegExp(`--mark-sheet: ${expected.sheet};`), theme);
    assert.match(block, new RegExp(`--mark-paper: ${expected.paper};`), theme);
  }
});

test("the mark is reassigned in applyTheme, not left to only ever match the theme the bar launched in", () => {
  const fn = swift.slice(
    swift.indexOf("private func applyTheme(animated: Bool = true) {"),
  );
  const body = fn.slice(0, fn.indexOf("\n  private func", 10));
  assert.match(body, /logoView\.image = UIImage\(named: NativeChromeView\.markImageName\(for: selectedTheme\)\)/);
});
