import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const toggle = readFileSync(join(process.cwd(), "components", "ThemeToggle.tsx"), "utf8");
/* The knob's state moved into the shared hook, so the behaviour this file
   pins now lives there — the theme control was the last of the three option
   bars still carrying its own copy, and the one the copy was lifted from. */
const hook = readFileSync(join(process.cwd(), "lib", "segmented-drag.ts"), "utf8");
const filter = readFileSync(join(process.cwd(), "components", "GlassRefractionFilter.tsx"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[0];
}

test("pointing at the theme toggle is answered by the knob, not only by the commit", () => {
  // The icon under the knob only changes colour once the choice commits, so
  // until then the control had nothing at all to say "yes, that one". The
  // bloom is that receipt, and three different things can earn it: a pointer
  // resting over the bar, a finger carrying the knob, and a knob still in
  // the air after being thrown.
  //
  // Each of those is tracked separately because each is cleared by something
  // different — leaving, releasing, and landing — and only their union
  // decides whether the knob is lifted. Collapsing them into one flag is how
  // this got rewritten twice: the effect answered a press only, so it never
  // appeared until a finger was already committed to the control; then it
  // answered hover only, and the drag lost its receipt entirely.
  assert.match(hook, /const \[hovering, setHovering\] = useState\(false\)/);
  assert.match(hook, /const \[pressing, setPressing\] = useState\(false\)/);
  assert.match(hook, /pressed: hovering \|\| pressing \|\| settling,/);
  assert.match(toggle, /data-pressed=\{drag\.pressed \? "" : undefined\}/);
  assert.match(hook, /onPointerEnter: \(\) => setHovering\(true\),/);
  assert.match(hook, /onPointerDown: \(event\) => \{\s*\n\s*dragging\.current = true;/);
  assert.match(hook, /setPressing\(true\);/);
  // Leaving and cancelling both have to clear the hover, or a knob the
  // pointer has left stays bloomed and clear for good — and a touch that the
  // browser takes back is cancelled rather than left. Both route through one
  // `leave`, and a cancel additionally ends the gesture, because there is no
  // pointerup coming to do it.
  assert.match(hook, /const leave = \(\) => \{\s*\n\s*setHovering\(false\);/);
  assert.match(hook, /onPointerLeave: \(\) => \{[\s\S]{0,300}if \(!dragging\.current\) leave\(\);/);
  assert.match(hook, /onPointerCancel: \(\) => \{\s*\n\s*end\(moved\.current\);\s*\n\s*leave\(\);/);
  // And releasing clears the press, or a knob let go of stays lifted with
  // nothing on it.
  assert.match(hook, /const end = \(dragged: boolean\) => \{[\s\S]*?setPressing\(false\);/);

  // It has to grow past the track, not inside it: breaking the outline is
  // the signal, and a bloom that stays within the rail reads as a highlight
  // rather than as something lifted.
  //
  // Expressed against the control's one measurement rather than restated as
  // a number. The size used to be five separate magic values — the option
  // buttons, the knob, its travel, and the bloom's size and offset — which
  // had to be re-derived by hand and kept in agreement; matching the account
  // button's height meant changing all five. They are all functions of
  // --theme-stop-size now, so the outer height is the only thing set.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  // Grown by layout, never by `transform: scale`. A backdrop-filter on a
  // scaled element samples its backdrop through that scale, so scaling
  // magnified the page behind the knob: the image inside stopped lining up
  // with the same page just outside the rim, which reads as a second offset
  // copy rather than as something seen through glass, and every edge inside
  // was an upscaled resample, which is where the stair-stepping came from.
  // The squash rides on top of the bloom, so each of these carries a second
  // term that is zero whenever the knob is still.
  assert.match(pressedKnob, /width: calc\(var\(--theme-stop-size\) \* var\(--theme-knob-bloom\) \+ /);
  assert.match(pressedKnob, /height: calc\(var\(--theme-stop-size\) \* var\(--theme-knob-bloom\) - /);
  // Same centre: the offset is half the growth, so it comes from the same
  // number rather than being computed by hand alongside it.
  // Named once, because the clone lens has to place its copy by the exact
  // negative of this and two copies of the arithmetic would drift apart.
  assert.match(pressedKnob, /--knob-x: calc\(\s*var\(--theme-stop-inset\) - var\(--theme-stop-size\) \* \(var\(--theme-knob-bloom\) - 1\) \/ 2/);
  assert.match(pressedKnob, /--knob-y: calc\(\s*var\(--theme-stop-inset\) - var\(--theme-stop-size\) \* \(var\(--theme-knob-bloom\) - 1\) \/ 2/);
  assert.match(pressedKnob, /left: var\(--knob-x\);/);
  assert.match(pressedKnob, /top: var\(--knob-y\);/);
  assert.doesNotMatch(pressedKnob, /scale\(/);

  // Which needs the track to stop clipping for exactly that long.
  const pressedBase = rule(".theme-toggle-base[data-pressed]");
  assert.match(pressedBase, /overflow: visible;/);
  /* A companion rule used to pull the glass layer's deliberate 1px overscan
     back in for the same moment, so it did not fringe past the track's corners
     while the clip was off. There is no layer to pull in now — refraction was
     removed site-wide, rejected on look — and the track's own tint is painted
     on the element rather than on a child, so releasing the clip lets nothing
     out but the knob. */
  assert.doesNotMatch(css, /refractive-glass-layer/);

  // Travel and size ride separate properties so the press can answer faster
  // than the glide — but which carries which is not interchangeable. The
  // individual translate/rotate/scale properties apply BEFORE `transform`,
  // so putting scale there multiplies whatever transform translates: at 1.5
  // the 1.875rem step became 2.8125rem and the knob landed half a stop past
  // its own icon. Travel on `translate` (applied first, unscaled), size on
  // `transform` (applied last, about the already-moved centre).
  const knob = rule(".theme-toggle-selector");
  assert.match(knob, /\n  translate: calc\(var\(--theme-index\) \* var\(--theme-stop-pitch\)\) 0;/);
  assert.doesNotMatch(knob, /\n  scale: /);
  assert.doesNotMatch(knob, /\n  transform: /);
  assert.match(knob, /transition:[\s\S]*?translate 440ms[\s\S]*?width 200ms/);
});

test("the lifted knob is clear glass: reformation only, no frost and no glow", () => {
  // The reference is a clear lens, not a frosted pill — what is behind it
  // bends, rather than being hidden. So every part of the frosted recipe
  // comes off while the pointer is over the control.
  //
  // But only where the lens can actually run. Clearing the frost on an
  // engine that never displaces the backdrop leaves a plain transparent
  // hole in the control, which is what iPhone was showing: WebKit does not
  // displace backdrops at all, by any of the four arrangements measured in
  // GlassRefractionFilter's displacesBackdropContent.
  const clear = rule(
    'html[data-glass-lens-split] .theme-toggle-base[data-pressed] .theme-toggle-selector,\nhtml[data-live-glass-refraction] .theme-toggle-base[data-pressed] .theme-toggle-selector',
  );
  assert.match(clear, /background: transparent;/);
  assert.match(clear, /backdrop-filter: none;/);
  assert.match(clear, /-webkit-backdrop-filter: none;/);
  assert.doesNotMatch(clear, /blur\(/);

  // And where it cannot, the knob keeps a real material rather than a hole.
  // Thinner than the resting knob, which is nearly opaque: that is right at
  // its resting size and wrong once it blooms to half again as large, where
  // it becomes a solid disc over the icon underneath.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /background: color-mix\(in srgb, var\(--color-surface\) 24%, transparent\);/);
  assert.match(pressedKnob, /backdrop-filter: blur\(14px\)/);
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
  // Zero radius, and the translateZ that actually earns the backdrop.
  //
  // This borrowed 1px from .card::before on the belief that the blur was
  // what made WebKit commit the layer. It is not — the explicit translateZ
  // is — and the blur cost real definition: a line crossing the rim has to
  // come out bent but still a line. Blurred first it arrives as a smear
  // that happens to be displaced, which reads as fog rather than glass.
  // Measured against a loud track border: mushy at 1px, a sharp kink at 0.
  assert.match(lensPressed, /transform: translateZ\(0\);/);
  assert.match(lensPressed, /backdrop-filter: blur\(0px\);/);
  assert.doesNotMatch(lensPressed, /blur\((?!0px)/);

  assert.match(
    css,
    /html\[data-glass-lens-split\] \.theme-toggle-base\[data-pressed\] \.theme-toggle-selector::before \{\s*\n\s*filter: var\(--glass-lens-filter, none\);/,
  );

  // And the knob has to actually be given a lens, or the variable above
  // resolves to `none` and the whole thing is an invisible no-op.
  assert.match(filter, /GENERIC_SELECTOR[\s\S]{0,400}\.theme-toggle-selector/);
});

test("the knob is a fraction under a finger and a whole stop otherwise", () => {
  // One number places the knob — a multiple of --theme-index, which the CSS
  // multiplies by the stop pitch — and what it means depends on which
  // gesture is moving it.
  //
  // A drag writes a fraction of it on every pointermove, because a lens that
  // does not move has nothing new to sample: a knob that jumped between
  // three fixed positions made the refraction a still image that changed
  // twice across a whole gesture. Everything else writes a whole stop, and
  // the journey between stops is a CSS transition rather than a value pushed
  // a frame at a time. The clamp is for the organisation bar, which reports
  // -1 while no section is open.
  assert.match(hook, /const visibleIndex = previewIndex \?\? Math\.max\(0, selectedIndex\);/);
  assert.match(hook, /const position = dragPosition \?\? visibleIndex;/);
  assert.match(toggle, /"--theme-index": drag\.position/);
  // Not floored to a stop — the raw fractional position is what is stored.
  assert.match(hook, /const raw = \(\(event\.clientX - rect\.left\) \/ rect\.width\) \* count - 0\.5;/);
  assert.match(hook, /setDragPosition\(next\)/);
  // Rounded for the commit, so releasing picks the stop it looks nearest.
  assert.match(hook, /const index = Math\.round\(next\);/);
  // And the fraction lasts exactly as long as the gesture does: release and
  // cancel both hand the knob back to whole stops to settle, through the one
  // `end` they share.
  assert.match(hook, /const end = \(dragged: boolean\) => \{[\s\S]*?setDragPosition\(null\);/);
  assert.match(hook, /onPointerUp: \(event\) => \{[\s\S]*?end\(dragged\);/);
  assert.match(hook, /onPointerCancel: \(\) => \{\s*\n\s*end\(moved\.current\);/);
  // The option buttons take their size from the same variable, so nothing
  // in the JSX can drift out of step with the knob that travels over them.
  assert.match(toggle, /className=\{`theme-toggle-option app-icon-control/);
  assert.doesNotMatch(toggle, /h-7 w-7/);

  // A lifted knob has no glide of its own — the pressed rule drops
  // `translate` from the transition, which is what stops the lens trailing a
  // finger it is meant to be under. That rule is exactly why a hover move
  // cannot simply change the index: it would teleport. So the two gestures
  // divide on `settling`, which puts the glide back for the length of a
  // journey and is never set while something is carrying the knob.
  // Everything else keeps its easing either way, so the bloom and the turn
  // to clear glass still ease in.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /transition:/);
  assert.doesNotMatch(pressedKnob, /transition:[^;]*translate/);
  assert.match(pressedKnob, /transition:[\s\S]*?width 200ms/);
  assert.match(
    rule(".theme-toggle-base[data-pressed][data-settling] .theme-toggle-selector"),
    /translate 440ms/,
  );
  // And the resting knob glides, which is what carries it home once the
  // pointer has gone and the lift with it.
  assert.match(rule(".theme-toggle-selector"), /transition:[\s\S]*?translate 440ms/);
});

test("the pressed knob disperses for real, rather than painting a rainbow", () => {
  // A prism separates because its refractive index depends on wavelength:
  // blue bends hardest, red least. One feDisplacementMap moves all three
  // channels by a single vector, so it bends without ever separating —
  // which is why the fringe used to be a drawn gradient ring.
  //
  // Three passes at three scales express it properly: the same normal map
  // slightly under, at, and over the true bend, with each pass then allowed
  // to contribute only the channel it was solved for.
    // 0.02, cut hard when the whole-face lens arrived: dispersion scales with
  // the displacement it splits, and once the whole face bends rather than
  // only the rim band, the same coefficient separated everywhere. This app's
  // icons are 0.75px hairlines, so a per-channel offset of even a pixel put
  // red and green edges on a monochrome glyph — an aberration fault however
  // physical its derivation.
  // Off. Three passes at three scales genuinely separate the backdrop's own
  // colours, but that was only safe while displacement lived in the rim band.
  // Once the whole face bends the split reaches everything the knob covers,
  // including this app's 1.3px icon strokes, which came through with yellow
  // and magenta on them. A monochrome glyph with coloured edges reads as a
  // fault however physically derived; the reference's icon shows no colour.
  assert.match(filter, /const KNOB_DISPERSION = 0;/);
  assert.match(filter, /const GENERIC_DISPERSION = 0;/);
  assert.match(filter, /scale=\{entry\.scale \* \(1 - entry\.dispersion\)\}/);
  assert.match(filter, /scale=\{entry\.scale \* \(1 \+ entry\.dispersion\)\}/);
  assert.match(filter, /result="lens-red"/);
  assert.match(filter, /result="lens-green"/);
  assert.match(filter, /result="lens-blue"/);

  // Each matrix keeps one channel and passes alpha through. Alpha has to
  // survive: the passes are composited additively, and a channel carried on
  // zero alpha is premultiplied away to nothing before it can be added.
  assert.match(filter, /values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/);
  assert.match(filter, /values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"/);
  assert.match(filter, /values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/);
  // Recombined with screen rather than an arithmetic sum: adding three
  // opaque premultiplied passes yields alpha 3, which both divides the
  // colours down and makes anything composited over it afterwards vanish.
  assert.match(filter, /<feBlend in="only-red" in2="only-green" mode="screen"/);
  assert.match(filter, /<feBlend in="red-green" in2="only-blue" mode="screen"/);

  // Dispersion is part of the bucket identity, so a card can never pick up
  // the knob's three-pass filter by measuring the same shape — three times
  // the displacement work is worth it for one 28px knob, not for every card
  // on a page.
  assert.match(filter, /function bucketKey\(\s*\n\s*aspect: number,\s*\n\s*cornerRadius: number,\s*\n\s*bezelWidth: number,\s*\n\s*dispersion: number,/);
  assert.match(filter, /const dispersion = knob \? KNOB_DISPERSION : GENERIC_DISPERSION;/);
  // Cards keep the single pass.
  assert.match(filter, /entry\.dispersion > 0 \?/);

  // And the drawn spectrum is gone from the rim. It was not merely
  // redundant once the lens disperses: a painted rainbow fires over a flat
  // backdrop, where a real prism has nothing to split and shows nothing —
  // so the one place the two disagreed was the place the drawing lied.
  // Verified both ways: strong derived fringe over a hard black/white edge,
  // none over flat grey.
  const rim = rule(".theme-toggle-selector::after");
  assert.doesNotMatch(rim, /rgba\(126, 228, 255/);
  assert.doesNotMatch(rim, /rgba\(255, 184, 116/);
  assert.doesNotMatch(rim, /rgba\(158, 152, 255/);
  // What is left is the part dispersion does not explain: a rim catches the
  // light above it, and that catch is white. Same geometry, same mask — but
  // held far back. The reference's rim is very nearly invisible, so a strong
  // white ring reads as a halo stuck to the knob rather than as glass.
  assert.match(rim, /padding: 0\.5px;/);
  assert.match(rim, /mask-composite: exclude;/);
  assert.match(rim, /var\(--glass-specular\)/);
  assert.doesNotMatch(rim, /rgba\(/);

  const rimPressed = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector::after");
  assert.match(rimPressed, /opacity: 1;/);
});

test("the pressed knob keeps its icons in front of it", () => {
  // These two used to swap places for the length of a press. That was right
  // while the knob carried a displacement lens: a filter can only bend what is
  // painted beneath it, and the buttons carry Tailwind's z-10 while the knob's
  // z-index is auto — so the icons painted on top and the knob's backdrop was
  // nothing but the track's own flat wash. Dropping the icons underneath was
  // what gave the lens something real to reform.
  //
  // There is no lens on the knob now — see the drawn-edge test in
  // segmented-controls for what replaced it and why — so being behind buys
  // nothing and costs the thing the arrangement existed for. The knob is
  // frosted, and a 16px glyph under a 9px blur is a smudge rather than a
  // control. It surfaced as the icon vanishing under the knob with the
  // navigation open, where the header's own fill sits behind the toggle and
  // made the loss obvious.
  assert.doesNotMatch(css, /\.theme-toggle-base\[data-pressed\] \.app-icon-control \{/);

  // The knob still rises for the press — that is the bloom standing proud of
  // the rail, and it is unrelated to what the icons do.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /z-index: 2;/);

  // Idle never had a z-index of its own and still does not, so the buttons'
  // own z-10 is what keeps the icons readable in both states now.
  const idleBase = css.match(/\n\.theme-toggle-base \{[\s\S]*?\n\}/);
  assert.ok(idleBase);
  assert.doesNotMatch(idleBase[0], /z-index/);
});

test("the theme control is exactly as tall as the account button beside it", () => {
  // They sit side by side in the header, so a few pixels of difference in
  // height reads as a misalignment rather than as two sizes.
  //
  // Solved for the OUTER height, which is the thing being matched: the
  // account button is h-10, so 2.5rem total, and the control adds 0.125rem
  // of padding and a 1px border on each side around its option — leaving
  // 2.125rem for the option itself.
  const base = rule(".theme-toggle-base");
  assert.match(base, /--theme-stop-size: 2\.125rem;/);
  assert.match(base, /--theme-stop-inset: 0\.125rem;/);
  assert.match(base, /--theme-stop-gap: 0\.125rem;/);
  // Pitch is derived, so the knob's travel can never disagree with the
  // spacing of the buttons it travels between.
  assert.match(base, /--theme-stop-pitch: calc\(var\(--theme-stop-size\) \+ var\(--theme-stop-gap\)\);/);
  assert.match(base, /--theme-knob-bloom: 1\.5;/);
  // The account button's own height, which the value above is solved against.
  const header = readFileSync(join(process.cwd(), "components", "SiteHeader.tsx"), "utf8");
  assert.match(header, /aria-label="Your account"[\s\S]{0,400}h-10 w-10/);

  // Option and knob both read the one measurement.
  assert.match(rule(".theme-toggle-option"), /width: var\(--theme-stop-size\);\s*\n\s*height: var\(--theme-stop-size\);/);
  const knob = rule(".theme-toggle-selector");
  assert.match(knob, /width: var\(--theme-stop-size\);/);
  assert.match(knob, /height: var\(--theme-stop-size\);/);
  assert.match(knob, /left: var\(--theme-stop-inset\);/);
});

test("the theme knob is visible on a light track, not only in dark", () => {
  // Every other segmented knob gets an explicit fill per theme — the
  // `html[data-theme="light"] .notification-filter-selector, ...` list names
  // six of them. The theme control was the one left off it, so it alone fell
  // through to the shared --glass-fill-strong: white at 16% with a white
  // edge at 32%. Over Warm's cream paper or Light's pale blue that is very
  // nearly nothing, and which theme was selected could only be read from the
  // icon's own colour.
  //
  // Scoped by :not([data-theme="dark"]) rather than by naming Warm and Light
  // separately, because Dark is the only one of the three that already had a
  // fill of its own — which is exactly why the bug showed up in the other
  // two and not there.
  // Lifted, not outlined, which is how the reference does it on a light bar:
  // its selected knob carries no stroke at all, is the same white as the bar
  // behind it, and is separated only by a soft shadow underneath. The first
  // attempt here reached for a border — the one thing the reference does not
  // have. A stroke on a pale track reads as a drawn outline; a shadow reads
  // as height.
  const lit = rule('html:not([data-theme="dark"]) .theme-toggle-selector');
  assert.match(lit, /background: color-mix\(in srgb, var\(--color-surface\) 97%, transparent\);/);
  assert.match(lit, /border-color: transparent;/);
  // Two shadows: a tight one to seat it and a wider one to lift it.
  assert.match(lit, /box-shadow:\s*\n\s*0 1px 2px[\s\S]*?0 4px 10px/);
  // Dark keeps its own, older override untouched.
  assert.match(css, /html\[data-theme="dark"\] \.theme-toggle-selector,/);

  // And the press still strips it: a clear knob is the point of the pressed
  // state, and this rule has to outrank the shared one that clears it.
  const litPressed = rule(
    'html:not([data-theme="dark"]) .theme-toggle-base[data-pressed] .theme-toggle-selector',
  );
  assert.match(litPressed, /background: transparent;/);
  assert.doesNotMatch(litPressed, /--color-surface/);
});

test("the account button sits clear of the theme control", () => {
  // The cluster is right-aligned, so the gap between these two is what moves
  // the account button left rather than any change to the account button.
  const header = readFileSync(join(process.cwd(), "components", "SiteHeader.tsx"), "utf8");
  assert.match(header, /className="ml-2 sm:ml-3">\s*\n\s*<ThemeToggle \/>/);
});
