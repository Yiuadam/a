import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const theme = await readFile(new URL("../lib/theme.ts", import.meta.url), "utf8");

test("Light keeps a white canvas with neutral-grey interactive controls", () => {
  const lightBlock = css.match(/html\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(lightBlock, /--color-surface:\s*#ffffff;/);
  assert.match(lightBlock, /--color-foreground:\s*#16171a;/);
  assert.match(lightBlock, /--color-indigo-600:\s*#c7ccd3;/);
  assert.match(lightBlock, /--color-accent-fg:\s*#26282d;/);
  assert.doesNotMatch(lightBlock, /#4f46e5|#4338ca/);
  assert.match(css, /Light canvas theme/);
  // Interactive controls (buttons, toggles, inputs) keep the stronger
  // neutral-grey fill — they need to read as clickable.
  assert.match(css, /html\[data-theme="light"\] \.btn-secondary,[\s\S]*?background:\s*color-mix\(in srgb, var\(--color-indigo-100\) 46%, transparent\);/);
  assert.doesNotMatch(
    css,
    /html\[data-theme="light"\] \.btn-secondary,[\s\S]{0,400}?\.card,/,
  );
  // Actual glass (.card/.liquid-glass/.premade-glass) is split out into its
  // own, much lighter fill: no colour of its own, and transparent enough
  // that the page's own background wash glows through the blur instead of
  // sitting under a grey scrim.
  assert.match(
    css,
    /html\[data-theme="light"\] \.liquid-glass,\nhtml\[data-theme="light"\] \.card,\nhtml\[data-theme="light"\] \.premade-glass \{[\s\S]*?background:\s*color-mix\(in srgb, var\(--color-indigo-100\) 16%, transparent\);/,
  );
  assert.match(css, /html\[data-theme="light"\] a\.card\.card:hover,[\s\S]*?background:\s*color-mix\(in srgb, var\(--color-indigo-200\) 58%, transparent\);/);
  assert.match(css, /html\[data-theme="light"\] \.btn-primary \{[\s\S]*?background:\s*var\(--color-indigo-600\);/);
  assert.doesNotMatch(css, /html\[data-theme="warm"\] \.card \{[\s\S]*?background:\s*#fac69f;/);
});

test("Light's canvas is a deep-to-white blue wash, and its glass carries no colour of its own", () => {
  // Anchored to the bottom of the viewport (fixed attachment, matching the
  // Warm theme's own corner washes) and fading to white toward the top —
  // not a flat white canvas any more.
  assert.match(
    css,
    /html\[data-theme="light"\] body \{[\s\S]*?background:\s*linear-gradient\(to top, #8dc3ef 0%, #c3e2f7 40%, #ffffff 88%\);[\s\S]*?background-attachment:\s*fixed;/,
  );
  // .nav-menu-group::before still carries the Warm theme's own brown tint
  // and warm-black wall shade by default (see its base rule) — Light
  // overrides just those custom properties with colourless mixes, rather
  // than redeclaring the whole layered wall/rim formula. Thinned down from
  // Warm's own strength too, so the nav list reads as more transparent
  // glow-blur over Light's own blue wash.
  const lightNavBefore = css.match(
    /html\[data-theme="light"\] \.nav-menu-group::before \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(lightNavBefore, "expected a Light override for .nav-menu-group::before");
  assert.match(lightNavBefore, /--nav-tint:\s*color-mix\(in srgb, var\(--color-background\) 5%, transparent\);/);
  assert.match(lightNavBefore, /--nav-wall-light:\s*color-mix\(in srgb, white 45%, transparent\);/);
  assert.match(lightNavBefore, /--nav-wall-shade:\s*color-mix\(in srgb, black 14%, transparent\);/);
  assert.match(lightNavBefore, /--nav-wall-shade-soft:\s*color-mix\(in srgb, black 7%, transparent\);/);

  // The two ambient ombre glows outside the wall/tint layer (the nav sheet's
  // own bathing glow, and the lift under each open card) also mix in the
  // Warm theme's brown by default — Light drops the coloured layer from
  // each and keeps only the neutral shadow.
  assert.match(css, /html\[data-theme="light"\] \.nav-paper \{\s*\n\s*box-shadow:\s*none;\s*\n\}/);
  const lightNavGroup = css.match(
    /html\[data-theme="light"\] \.nav-menu-group \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(lightNavGroup, "expected a Light override for .nav-menu-group");
  assert.match(lightNavGroup, /color-mix\(in srgb, black 18%, transparent\)/);
  assert.doesNotMatch(lightNavGroup, /rgb\(142, 104, 78\)/);
});

test("Warm keeps its original cream-paper canvas and clay browser chrome", () => {
  assert.match(css, /--color-background:\s*#e7e0d8;/);
  assert.match(css, /--color-surface:\s*#f4eee7;/);
  assert.match(theme, /Cream paper and clay — easiest on the eyes/);
  assert.match(theme, /warm:\s*"#e7e0d8"/);
});

test("the Light theme describes its neutral interactive accent", () => {
  assert.match(theme, /White canvas with a light grey control accent/);
});

test("Dark remains a low-light theme with a graphite canvas", () => {
  const darkBlock = css.match(/html\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(darkBlock, /color-scheme:\s*dark;/);
  assert.match(darkBlock, /--color-background:\s*#111113;/);
  assert.match(darkBlock, /--color-surface:\s*#1d1d20;/);
  assert.match(theme, /Dark canvas with graphite cards and controls/);
});

test("Dark carries the same orange-brown accent as the logo and Warm's own glass", () => {
  const darkBlock = css.match(/html\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  // The accent ramp, not the graphite slate/background tokens above — icons,
  // links, focus rings and active states all resolve through --color-indigo-*
  // via Tailwind's indigo-* utilities, so recolouring this one ramp is what
  // carries the accent everywhere those are used, without touching every
  // component that uses them.
  assert.match(darkBlock, /--color-indigo-600:\s*#e0954f;/);
  assert.doesNotMatch(darkBlock, /--color-indigo-600:\s*#5f5f68;/);
  assert.doesNotMatch(darkBlock, /Interactive states stay monochrome/);
  // Low numbers stay dark background tints, high numbers climb to a bright
  // accent — the same inverted-ramp shape Dark already uses for slate, rose
  // and emerald, so this one isn't the odd one out.
  const indigo50 = darkBlock.match(/--color-indigo-50:\s*#([0-9a-f]{6});/)?.[1];
  const indigo800 = darkBlock.match(/--color-indigo-800:\s*#([0-9a-f]{6});/)?.[1];
  assert.ok(indigo50 && indigo800, "expected both indigo-50 and indigo-800 in the Dark block");
  const luminance = (hex) => parseInt(hex.slice(0, 2), 16) + parseInt(hex.slice(2, 4), 16) + parseInt(hex.slice(4, 6), 16);
  assert.ok(luminance(indigo50) < luminance(indigo800), "indigo-50 should be darker than indigo-800 in Dark");
});

test("Dark navigation keeps its opened header free of a containing blur", () => {
  assert.match(
    css,
    /html\[data-theme="dark"\] \.nav-open-header \{[\s\S]*?-webkit-backdrop-filter:\s*none;[\s\S]*?backdrop-filter:\s*none;/,
  );
  assert.doesNotMatch(
    css,
    /html\[data-theme="dark"\] \.nav-open-header,[\s\S]*?backdrop-filter:\s*blur\(var\(--glass-blur\)\)/,
  );
});

test("browser chrome follows the selected canvas", () => {
  assert.match(theme, /light:\s*"#ffffff"/);
  assert.match(theme, /dark:\s*"#111113"/);
  assert.match(theme, /m\.content=\(\{warm:"#e7e0d8",light:"#ffffff",dark:"#111113"\}\)\[t\]/);
});
