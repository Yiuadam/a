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
  // Interactive controls (toggles, inputs) keep the stronger neutral-grey
  // fill — they need to read as clickable. .btn-secondary is a button
  // rather than a toggle or field, so it has its own rule below with the
  // same fill but a blue perimeter (see the accent-perimeter test).
  assert.match(css, /html\[data-theme="light"\] \.theme-toggle-base,[\s\S]*?background:\s*color-mix\(in srgb, var\(--color-indigo-100\) 46%, transparent\);/);
  assert.doesNotMatch(
    css,
    /html\[data-theme="light"\] \.theme-toggle-base,[\s\S]{0,400}?\.btn-secondary,/,
  );
  const lightBtnSecondary = css.match(/html\[data-theme="light"\] \.btn-secondary \{[\s\S]*?\n\}/)?.[0];
  assert.ok(lightBtnSecondary, "expected a standalone Light .btn-secondary rule");
  assert.match(lightBtnSecondary, /background:\s*color-mix\(in srgb, var\(--color-indigo-100\) 46%, transparent\);/);
  assert.match(lightBtnSecondary, /border-color:\s*color-mix\(in srgb, var\(--color-accent-blue\) 45%, transparent\);/);
  // Actual glass (.card/.liquid-glass/.premade-glass) is split out into its
  // own, much lighter fill: no colour of its own, and transparent enough
  // that the page's own background wash glows through the blur instead of
  // sitting under a grey scrim. .nav-menu-group is excluded even though it
  // carries the .liquid-glass class: it has its own dedicated material on
  // ::before instead, and matching it here too gave it a second, unwanted
  // background (see the nav-menu-group test below).
  assert.match(
    css,
    /html\[data-theme="light"\] \.liquid-glass:not\(\.nav-menu-group\),\nhtml\[data-theme="light"\] \.card,\nhtml\[data-theme="light"\] \.premade-glass \{[\s\S]*?background:\s*color-mix\(in srgb, var\(--color-indigo-100\) 16%, transparent\);/,
  );
  assert.match(css, /html\[data-theme="light"\] a\.card\.card:hover,[\s\S]*?background:\s*color-mix\(in srgb, var\(--color-indigo-200\) 58%, transparent\);/);
  assert.match(css, /html\[data-theme="light"\] \.btn-primary \{[\s\S]*?background:\s*var\(--color-indigo-600\);/);
  assert.doesNotMatch(css, /html\[data-theme="warm"\] \.card \{[\s\S]*?background:\s*#fac69f;/);
});

test("Light's canvas is a flat light blue, and its glass carries no colour of its own", () => {
  // A flat colour for the whole page — not white, and (per a later direct
  // request) not a gradient either; an earlier bottom-to-top blue gradient
  // was replaced with one plain colour. Lightened and desaturated once from
  // the original #cfe7fb, on a direct request for a softer wash.
  assert.match(
    css,
    /html\[data-theme="light"\] \{[\s\S]*?--color-background:\s*#dfecf6;/,
  );
  assert.doesNotMatch(css, /html\[data-theme="light"\][\s\S]{0,2000}linear-gradient\(to top, #8dc3ef/);
  // Two `html[data-theme="light"] body` blocks exist (an earlier one only
  // tunes --glass-* tokens); match the later one, which actually sets the
  // page's background.
  const lightBodyBlocks = css.match(/html\[data-theme="light"\] body \{[\s\S]*?\n\}/g) ?? [];
  const lightBody = lightBodyBlocks.find((block) => block.includes("background:"));
  assert.ok(lightBody, "expected a Light body override that sets background");
  assert.match(lightBody, /background:\s*#dfecf6;/);
  assert.doesNotMatch(lightBody, /linear-gradient/);
  // .nav-menu-group still carries the Warm theme's own brown tint and
  // warm-black wall shade by default (see its base rule) — Light overrides
  // just those custom properties with colourless mixes, rather than
  // redeclaring the whole layered wall/rim formula. Thinned down from
  // Warm's own strength too, so the nav list reads as more transparent
  // glow-blur over Light's own blue wash — and thinned again on a later,
  // direct "more transparent" request. Held on .nav-menu-group itself
  // (not ::before) so both the warped wall/tint layer and the unwarped
  // highlight sheen (see the glass-refraction tests) read the same colours.
  const lightNavGroupColors = css.match(
    /html\[data-theme="light"\] \.nav-menu-group \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(lightNavGroupColors, "expected a Light override for .nav-menu-group");
  // Raised from 3% alongside the sheet's scrim. The two move together by
  // necessity: a translucent card sitting on a dimmed ground goes down with
  // the ground, so lifting the card off it means the card's own fill has to
  // come up by about as much as the ground went down. Move only one and the
  // pair travels together and nothing separates.
  assert.match(lightNavGroupColors, /--nav-tint:\s*color-mix\(in srgb, var\(--color-background\) 22%, transparent\);/);
  assert.match(lightNavGroupColors, /--nav-wall-light:\s*color-mix\(in srgb, white 35%, transparent\);/);
  assert.match(lightNavGroupColors, /--nav-wall-shade:\s*color-mix\(in srgb, black 10%, transparent\);/);
  assert.match(lightNavGroupColors, /--nav-wall-shade-soft:\s*color-mix\(in srgb, black 5%, transparent\);/);

  // .nav-menu-group carries no background of its own in any theme (see the
  // isolation comment on its base rule) — all its material lives on
  // ::before, tuned just above. It used to also pick up a stray 16%
  // indigo-100 background from the shared .liquid-glass rule (matched via
  // that class), stacked underneath its own dedicated layer; excluding it
  // there (see the test above) is what makes this element's own computed
  // background plain transparent.
  assert.doesNotMatch(css, /html\[data-theme="light"\] \.nav-menu-group \{\s*\n\s*background:/);

  // The two ambient ombre glows outside the wall/tint layer (the nav sheet's
  // own bathing glow, and the lift under each open card) also mix in the
  // Warm theme's brown by default — Light drops the coloured layer from
  // each and keeps only the neutral shadow.
  assert.match(css, /html\[data-theme="light"\] \.nav-paper \{\s*\n\s*box-shadow:\s*none;\s*\n\}/);
  // Two `html[data-theme="light"] .nav-menu-group` blocks exist now (the
  // colours above, and this lift-off-sheet box-shadow); find the one that
  // actually sets box-shadow rather than assuming match order.
  const lightNavGroupBlocks = css.match(/html\[data-theme="light"\] \.nav-menu-group \{[\s\S]*?\n\}/g) ?? [];
  const lightNavGroupShadow = lightNavGroupBlocks.find((block) => block.includes("box-shadow:"));
  assert.ok(lightNavGroupShadow, "expected a Light .nav-menu-group override that sets box-shadow");
  assert.match(lightNavGroupShadow, /color-mix\(in srgb, black 18%, transparent\)/);
  assert.doesNotMatch(lightNavGroupShadow, /rgb\(142, 104, 78\)/);
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
  // The ramp sits on the logo's own hue rather than a browner cousin of it.
  // The mark was decoded to a canvas and its pixels counted rather than
  // eyedropped by memory: its body runs #903c18 through #b45424 to #cc6030,
  // which is hue 18-19 degrees, and this ramp had been sitting at 28-30.
  // That ten-degree gap is the whole difference between reading as orange
  // and reading as brown, so hue is what moved; the lightness ladder is
  // untouched, which is what keeps every contrast relationship in the theme
  // where it was.
  assert.match(darkBlock, /--color-indigo-600:\s*#e27c4d;/);
  assert.match(darkBlock, /--color-indigo-700:\s*#ee9a73;/);
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

test("primary buttons carry an accent-coloured perimeter in every theme", () => {
  // The base rule mixes the accent into the existing --glass-edge rather
  // than replacing it outright — an orange-brown perimeter in Warm and Dark,
  // where the accent ramp actually is that colour. Light overrides its own
  // border-color separately below with its own blue token, since Light's
  // accent ramp is neutral grey rather than a colour worth mixing in here.
  const baseRule = css.match(/\n\.btn-primary \{[\s\S]*?\n\}/)?.[0];
  assert.ok(baseRule, "expected a base .btn-primary rule");
  assert.match(baseRule, /border-color:\s*color-mix\(in srgb, var\(--color-indigo-600\) 55%, var\(--glass-edge\)\);/);

  const hoverRule = css.match(/\n\.btn-primary:hover:not\(:disabled\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(hoverRule, "expected a base .btn-primary:hover rule");
  assert.match(hoverRule, /border-color:\s*color-mix\(in srgb, var\(--color-indigo-600\) 70%, var\(--glass-specular\)\);/);

  // Dark used to pin this to a plain white-based border from when its own
  // accent ramp was kept deliberately monochrome — now that the ramp itself
  // carries the logo's orange-brown, the border formula matches every other
  // theme's, just mixed against Dark's own near-black glass edge instead of
  // var(--glass-edge).
  const darkRule = css.match(/html\[data-theme="dark"\] \.btn-primary,\nhtml\[data-theme="dark"\] \.btn-primary:hover:not\(:disabled\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(darkRule, "expected a Dark .btn-primary override");
  assert.match(darkRule, /border-color:\s*color-mix\(in srgb, var\(--color-indigo-600\) 55%, rgba\(255, 255, 255, 0\.22\)\);/);
  assert.doesNotMatch(darkRule, /border-color:\s*rgba\(255, 255, 255, 0\.22\);/);

  // Light: on a direct request, the one deliberately blue token in the
  // theme (--color-accent-blue), not the neutral-grey indigo ramp every
  // other part of a Light button still uses (fill, focus states, etc).
  const lightRule = css.match(/html\[data-theme="light"\] \.btn-primary \{[\s\S]*?\n\}/)?.[0];
  assert.ok(lightRule, "expected a Light .btn-primary override");
  assert.match(lightRule, /border-color:\s*color-mix\(in srgb, var\(--color-accent-blue\) 60%, transparent\);/);

  const lightHoverRule = css.match(/html\[data-theme="light"\] \.btn-primary:hover:not\(:disabled\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(lightHoverRule, "expected a Light .btn-primary:hover override");
  assert.match(lightHoverRule, /border-color:\s*var\(--color-accent-blue\);/);
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
