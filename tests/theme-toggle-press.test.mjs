import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const toggle = readFileSync(join(process.cwd(), "components", "ThemeToggle.tsx"), "utf8");
const filter = readFileSync(join(process.cwd(), "components", "GlassRefractionFilter.tsx"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[0];
}

test("pressing the theme toggle is answered by the knob, not only by the commit", () => {
  // The icon under the knob only changes colour once the choice commits, so
  // during a drag the control had nothing at all to say "yes, that one".
  // The bloom is that receipt.
  //
  // It hangs off its own attribute rather than the existing `data-flowing`,
  // which hover and keyboard focus also set — a pointer resting over the
  // control is not a press, and blooming for it would make the receipt
  // meaningless.
  assert.match(toggle, /const \[pressed, setPressed\] = useState\(false\)/);
  assert.match(toggle, /data-pressed=\{pressed \? "" : undefined\}/);
  assert.match(toggle, /onPointerDown[\s\S]{0,200}setPressed\(true\)/);
  // Released and cancelled both have to clear it, or a knob left mid-drag
  // stays bloomed and clear for good.
  assert.match(toggle, /onPointerUp[\s\S]{0,300}setPressed\(false\)/);
  assert.match(toggle, /onPointerCancel[\s\S]{0,200}setPressed\(false\)/);

  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /scale: 1\.12;/);

  // Scale is its own property, not a second function inside `transform`: the
  // press has to answer faster than the 440ms glide between stops, and one
  // `transform` can only carry one duration for both.
  const knob = rule(".theme-toggle-selector");
  assert.match(knob, /\n  scale: 1;/);
  assert.match(knob, /transition:[\s\S]*?transform 440ms[\s\S]*?scale 200ms/);
});

test("the dragged knob is clear glass: reformation only, no frost and no glow", () => {
  // The reference is a clear lens, not a frosted pill — what is behind it
  // bends, rather than being hidden. So every part of the frosted recipe
  // comes off while the finger is down.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /background: transparent;/);
  assert.match(pressedKnob, /backdrop-filter: none;/);
  assert.match(pressedKnob, /-webkit-backdrop-filter: none;/);
  // No blur and no brightness lift survive into the pressed state.
  assert.doesNotMatch(pressedKnob, /blur\(/);
  assert.doesNotMatch(pressedKnob, /brightness\(/);
  assert.doesNotMatch(pressedKnob, /saturate\(/);
  // The rim stays: an edge is what makes a clear thing findable at all.
  assert.match(pressedKnob, /box-shadow:/);
  assert.match(pressedKnob, /border-color:/);

  // The idle knob keeps its frosted material, so this is a press state
  // rather than a permanent change to the control.
  const knob = rule(".theme-toggle-selector");
  assert.match(knob, /backdrop-filter: blur\(18px\)/);

  // The displacement rides its own layer, never the knob itself: anything
  // painted on a filtered layer is sheared along with the backdrop, which is
  // the bug .nav-menu-group-sheen exists to avoid. The rim and highlight
  // above therefore stay unwarped.
  const lens = rule(".theme-toggle-selector::before");
  assert.match(lens, /opacity: 0;/);
  assert.doesNotMatch(lens, /backdrop-filter/);

  const lensPressed = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector::before");
  assert.match(lensPressed, /opacity: 1;/);
  // 1px is not frost — it is the smallest value that reliably makes WebKit
  // commit the layer so the backdrop is sampled at all, exactly as
  // .card::before does it.
  assert.match(lensPressed, /backdrop-filter: blur\(1px\);/);

  assert.match(
    css,
    /html\[data-glass-lens-split\] \.theme-toggle-base\[data-pressed\] \.theme-toggle-selector::before \{\s*\n\s*filter: var\(--glass-lens-filter, none\);/,
  );

  // And the knob has to actually be given a lens, or the variable above
  // resolves to `none` and the whole thing is an invisible no-op.
  assert.match(filter, /GENERIC_SELECTOR[\s\S]{0,400}\.theme-toggle-selector/);
});
