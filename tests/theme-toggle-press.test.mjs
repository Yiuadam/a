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

  // It has to grow past the track, not inside it: breaking the outline is
  // the signal, and a bloom that stays within the rail reads as a highlight
  // rather than as something lifted. 1.5 takes the 1.75rem knob to
  // 2.625rem against a 2rem track.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /transform: scale\(1\.5\);/);

  // Which needs the track to stop clipping for exactly that long...
  const pressedBase = rule(".theme-toggle-base[data-pressed]");
  assert.match(pressedBase, /overflow: visible;/);
  // ...and the live glass layer's deliberate 1px overscan pulled back in
  // while the clip that was containing it is gone, or it fringes past the
  // track's corners.
  const pressedLayer = rule(".theme-toggle-base[data-pressed] > .refractive-glass-layer");
  assert.match(pressedLayer, /inset: 0;/);

  // Travel and size ride separate properties so the press can answer faster
  // than the glide — but which carries which is not interchangeable. The
  // individual translate/rotate/scale properties apply BEFORE `transform`,
  // so putting scale there multiplies whatever transform translates: at 1.5
  // the 1.875rem step became 2.8125rem and the knob landed half a stop past
  // its own icon. Travel on `translate` (applied first, unscaled), size on
  // `transform` (applied last, about the already-moved centre).
  const knob = rule(".theme-toggle-selector");
  assert.match(knob, /\n  translate: calc\(var\(--theme-index\) \* 1\.875rem\) 0;/);
  assert.match(knob, /\n  transform: scale\(1\);/);
  assert.doesNotMatch(knob, /\n  scale: /);
  assert.match(knob, /transition:[\s\S]*?translate 440ms[\s\S]*?transform 200ms/);
  // The travel must never be expressed through `transform`, which is what
  // reintroduces the scaled-step bug.
  assert.doesNotMatch(knob, /transform:[^;]*translate/);
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

test("the pressed knob disperses at its rim, the way the reference glass does", () => {
  // A real lens bends short wavelengths harder than long ones, so its edge
  // splits white light into a spectrum. feDisplacementMap cannot: it moves
  // all three channels by one vector, bending the backdrop without ever
  // separating it. Doing it honestly would be three filter passes at three
  // scales, on a 28px knob, for an effect a couple of pixels wide.
  //
  // So the fringe is painted, on the same masked-gradient-border as
  // .card::after — the only way to get a border whose colour varies around
  // its own perimeter. Painted also means it survives a flat backdrop,
  // where a real split would have nothing to separate.
  const rim = rule(".theme-toggle-selector::after");
  // Sub-pixel: a spectrum at the edge of real glass is the thinnest thing
  // about it, and a full pixel ring reads as a coloured border drawn around
  // the knob rather than as light coming apart in it.
  assert.match(rim, /padding: 0\.5px;/);
  assert.match(rim, /mask-composite: exclude;/);
  assert.match(rim, /-webkit-mask-composite: xor;/);
  // Cool at one end of the sweep, warm at the other — dispersion has an
  // order, and a rim that ran one hue would just be a coloured border.
  assert.match(rim, /rgba\(126, 228, 255/);
  assert.match(rim, /rgba\(255, 184, 116/);
  // Sits above both the lens layer and the knob's own rim.
  assert.match(rim, /z-index: 3;/);
  assert.match(rim, /opacity: 0;/);

  // Pressed only. A frosted pane scatters light rather than splitting it,
  // so a rainbow on the resting knob would describe the wrong material.
  const rimPressed = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector::after");
  assert.match(rimPressed, /opacity: 1;/);
});

test("the pressed knob has something behind it to bend", () => {
  // The lens was correct, active, and completely invisible: a
  // backdrop-filter can only bend what is painted beneath it, and the
  // buttons carry Tailwind's z-10 while the knob's z-index is auto — so the
  // icons painted on top of the knob and its backdrop was nothing but the
  // track's own flat wash. Bending flat colour looks exactly like flat
  // colour, which is the same trap that made a 56px blur hide the card
  // lens.
  //
  // So the two swap places for the length of the press. Both halves are
  // load-bearing and neither works alone, which is why both are pinned.
  const icons = rule(".theme-toggle-base[data-pressed] .app-icon-control");
  assert.match(icons, /z-index: 0;/);

  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /z-index: 2;/);

  // Idle keeps the icons on top, because the resting knob is frosted at
  // 18px and an icon read through that is a smear, not a control.
  const idleBase = css.match(/\n\.theme-toggle-base \{[\s\S]*?\n\}/);
  assert.ok(idleBase);
  assert.doesNotMatch(idleBase[0], /z-index/);
});
