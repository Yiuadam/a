import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const end = css.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${selector} rule`);
  return css.slice(start, end + 2);
}

test("opening navigation keeps a real liquid-glass header surface", () => {
  const header = read("components", "SiteHeader.tsx");
  const css = read("app", "globals.css");
  const openHeader = rule(css, ".nav-open-header");
  const openHeaderSurface = rule(css, ".nav-open-header::before");
  const openHeaderContent = rule(css, ".nav-open-header > :not(.nav-paper)");
  const darkOpenHeaderSurface = rule(css, "html[data-theme=\"dark\"] .nav-open-header::before");

  // Opening the list deliberately swaps the header class, but it must not
  // swap away the material surface. The open state owns a separate painted
  // layer so it stays visibly filled and blurred above the menu.
  assert.match(header, /open \? "nav-open-header z-\[1000\]" : "liquid-glass z-40"/);
  assert.match(openHeaderSurface, /content:\s*["']{2}\s*;/);
  assert.match(openHeaderSurface, /position:\s*absolute\s*;/);
  assert.match(openHeaderSurface, /inset:\s*0\s*;/);
  assert.match(openHeaderSurface, /pointer-events:\s*none\s*;/);
  //
  // Filled, but only a fraction of the way. This layer is inset: 0 at z-index
  // 0, so it lands directly under the theme knob — and the knob is a
  // backdrop-filter, which samples whatever is painted beneath it. At a full
  // --glass-fill (0.42 white in Light) it is a flat wash across the whole bar,
  // so the knob had nothing to sample but a solid colour and came out a solid
  // disc. That is exactly why the knob read as glass with the menu closed and
  // as paint the moment it opened: what was behind it changed from the page to
  // a sheet of colour. The brightness lift goes for the same reason it went
  // from the knob — over a near-white page it only moves the sample toward
  // white.
  assert.match(openHeaderSurface, /background:\s*color-mix\(in srgb, var\(--glass-fill\) 40%, transparent\)\s*;/);
  assert.match(openHeaderSurface, /-webkit-backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(118%\)\s*;/);
  assert.match(openHeaderSurface, /backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(118%\)\s*;/);

  // Dark mode needs the same translucent glass material rather than a bare,
  // transparent header. Keeping this explicit catches a future dark-only
  // regression such as the one visible in the report.
  assert.match(darkOpenHeaderSurface, /background:\s*color-mix\(in srgb, var\(--glass-fill\) 40%, transparent\)\s*;/);
  assert.match(darkOpenHeaderSurface, /-webkit-backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(105%\)\s+brightness\(106%\)\s*;/);
  assert.match(darkOpenHeaderSurface, /backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(105%\)\s+brightness\(106%\)\s*;/);
  assert.doesNotMatch(openHeaderSurface, /background:\s*transparent\s*;/);
  assert.doesNotMatch(darkOpenHeaderSurface, /background:\s*transparent\s*;/);

  // A backdrop filter on the header itself turns it into the containing block
  // for the fixed navigation sheet. The visible surface therefore lives on
  // the pseudo-element; the header remains filter-free and the menu remains
  // a viewport-fixed layer beneath it.
  // The closed header's border-b earns its keep against an opaque bar; open,
  // it sits directly above .nav-paper's much clearer material (9% tint, 2px
  // blur) and a solid line at that seam reads as a stray leftover rather
  // than a deliberate divider.
  assert.match(openHeader, /border-color:\s*transparent\s*;/);
  assert.match(openHeader, /isolation:\s*isolate\s*;/);
  // The bar is painted with the same scrim as the sheet below it, and
  // declares it, because .nav-paper is this element's own child and has to
  // inherit the identical value. Drifting apart is what went wrong before:
  // the sheet was dimmed to give the cards something to stand out from and
  // the bar was not, which left a bright strip across the top of a dimmed
  // page reading as a piece of a different screen.
  assert.match(openHeader, /--nav-scrim:\s*color-mix\(in srgb, rgb\(28, 20, 14\) 10%, transparent\);/);
  assert.match(openHeader, /background:\s*var\(--nav-scrim\)\s*;/);
  assert.match(openHeader, /box-shadow:\s*[\s\S]*?var\(--glass-highlight\) 45%/);
  assert.match(openHeaderContent, /position:\s*relative\s*;/);
  assert.match(openHeaderContent, /z-index:\s*1\s*;/);
  assert.doesNotMatch(openHeader, /(?:-webkit-)?backdrop-filter:\s*blur\(/);
  assert.match(header, /className="nav-paper premade-glass fixed inset-x-0 bottom-0 top-\[var\(--header-h\)\]/);
});
