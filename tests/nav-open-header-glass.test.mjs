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
  assert.match(openHeaderSurface, /background:\s*var\(--glass-fill\)\s*;/);
  assert.match(openHeaderSurface, /-webkit-backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(108%\)\s+brightness\(103%\)\s*;/);
  assert.match(openHeaderSurface, /backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(108%\)\s+brightness\(103%\)\s*;/);

  // Dark mode needs the same translucent glass material rather than a bare,
  // transparent header. Keeping this explicit catches a future dark-only
  // regression such as the one visible in the report.
  assert.match(darkOpenHeaderSurface, /background:\s*var\(--glass-fill\)\s*;/);
  assert.match(darkOpenHeaderSurface, /-webkit-backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(105%\)\s+brightness\(106%\)\s*;/);
  assert.match(darkOpenHeaderSurface, /backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s+saturate\(105%\)\s+brightness\(106%\)\s*;/);
  assert.doesNotMatch(openHeaderSurface, /background:\s*transparent\s*;/);
  assert.doesNotMatch(darkOpenHeaderSurface, /background:\s*transparent\s*;/);

  // A backdrop filter on the header itself turns it into the containing block
  // for the fixed navigation sheet. The visible surface therefore lives on
  // the pseudo-element; the header remains filter-free and the menu remains
  // a viewport-fixed layer beneath it.
  assert.match(openHeader, /border-color:\s*var\(--glass-edge\)\s*;/);
  assert.match(openHeader, /isolation:\s*isolate\s*;/);
  assert.match(openHeader, /background:\s*color-mix\(in srgb, var\(--glass-fill\) 45%, transparent\)\s*;/);
  assert.match(openHeader, /box-shadow:\s*[\s\S]*?var\(--glass-highlight\) 45%/);
  assert.match(openHeaderContent, /position:\s*relative\s*;/);
  assert.match(openHeaderContent, /z-index:\s*1\s*;/);
  assert.doesNotMatch(openHeader, /(?:-webkit-)?backdrop-filter:\s*blur\(/);
  assert.match(header, /className="nav-paper premade-glass fixed inset-x-0 bottom-0 top-\[var\(--header-h\)\]/);
});
