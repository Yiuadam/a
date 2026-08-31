import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const hook = readFileSync(join(process.cwd(), "lib", "segmented-drag.ts"), "utf8");
const filter = readFileSync(join(process.cwd(), "components", "GlassRefractionFilter.tsx"), "utf8");
const org = readFileSync(join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"), "utf8");
const themeToggle = readFileSync(join(process.cwd(), "components", "ThemeToggle.tsx"), "utf8");
const inbox = readFileSync(join(process.cwd(), "components", "account", "NotificationInbox.tsx"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[0];
}

test("every option bar answers a pointer through one implementation, not three copies", () => {
  // The theme control, the organisation sections and the notification filter
  // had each grown the same code independently — a dragging ref, a dragIndex
  // ref, a previewIndex state, an indexAtPointer that floors a fraction of
  // the width, and five handlers that have to agree about which one commits
  // and which only previews.
  //
  // Three copies of something that fiddly is three chances to fix a bug in
  // one and leave it in the others, which is exactly what happened: the
  // theme control learned to lift its knob and deform it, and the other two
  // carried on jumping between whole stops with nothing to show for it.
  assert.match(hook, /export function useSegmentedDrag/);
  assert.match(hook, /onPointerEnter: \(\) => setHovering\(true\),/);
  assert.match(hook, /const travelTo = \(index: number\) => \{/);
  assert.match(hook, /pressed: hovering \|\| settling,/);

  for (const [name, source, commit] of [
    ["organisation", org, /onClick=\{\(\) => \{\s*onOpen\(id\);/],
    ["notification inbox", inbox, /onClick=\{\(\) => \{\s*onChange\(option\.id\);/],
    // The theme control was the last holdout. It kept its own copy right
    // through the extraction — the copy every other one was lifted FROM —
    // and that meant the squash would have had to be written three times to
    // reach every option bar.
    ["theme toggle", themeToggle, /onClick=\{\(\) => \{\s*setTheme\(t\.id\);/],
  ]) {
    assert.match(source, /useSegmentedDrag\(\{/, `${name} should use the shared hook`);
    assert.match(source, /\{\.\.\.drag\.handlers\}/, `${name} should spread the shared handlers`);
    assert.match(source, /data-pressed=\{drag\.pressed \? "" : undefined\}/, `${name} needs the lift flag`);
    assert.match(source, /drag\.position/, `${name} should place its knob from the shared position`);
    // Choosing is a click, and each bar has always made it in the option's
    // own handler. The hook used to take an onCommit as well and fire it
    // from pointerup, which meant two paths to the same commit for as long
    // as it had a pointerup to fire from; it does not, and a dead option
    // left on the signature is an invitation to wire the second one back.
    assert.match(source, commit, `${name} should commit in the option's own click`);
    assert.doesNotMatch(source, /onCommit/, `${name} should not hand the hook a commit as well`);
    // And none of the hand-rolled machinery should survive.
    assert.doesNotMatch(source, /const dragging = useRef\(false\)/, `${name} still has its own drag state`);
    assert.doesNotMatch(source, /indexAtPointer/, `${name} still has its own hit test`);
    // touch-none was there to own the drag gesture, so that a finger sliding
    // across the bar moved the knob instead of scrolling the page. With no
    // drag to own, all it does is refuse to scroll a page from a control
    // that happens to be under the thumb.
    assert.doesNotMatch(source, /touch-none/, `${name} should not take the page's scroll gesture`);
  }
});

test("the pressed knob blooms without moving its own box", () => {
  // These knobs travel by `translate3d(index * 100%)` — a percentage of
  // their OWN width — so growing the box would lengthen every step and land
  // the knob past its label. That is the same bug that put the theme knob
  // half a stop out when its bloom was a `transform: scale`.
  //
  // Growing ::before and ::after with a negative inset leaves the box, and
  // therefore the travel, exactly as it was. Verified in the browser: the
  // knob measured 53.5px wide both idle and pressed.
  const knob = rule(".segmented-knob");
  assert.match(knob, /--segmented-grow: 0px;/);

  // Two-value inset: vertical first, horizontal second, because the squash
  // takes height and gives width. Both still resolve to -grow when the knob
  // is still, which is what leaves the box alone.
  const lens = rule(".segmented-knob::before");
  assert.match(lens, /calc\(var\(--segmented-thin\) - var\(--segmented-grow\)\)/);
  assert.match(lens, /calc\(0px - var\(--segmented-grow\) - var\(--segmented-stretch\)\)/);
  const rim = rule(".segmented-knob::after");
  assert.match(rim, /calc\(var\(--segmented-thin\) - var\(--segmented-grow\)\)/);
  assert.match(rim, /calc\(0px - var\(--segmented-grow\) - var\(--segmented-stretch\)\)/);

  const pressed = rule("[data-pressed] > .segmented-knob.segmented-knob");
  assert.match(pressed, /--segmented-grow: 0\.4375rem;/);
  // Nothing may resize or rescale the knob itself.
  assert.doesNotMatch(pressed, /\n {2}width:/);
  assert.doesNotMatch(pressed, /\n {2}height:/);
  assert.doesNotMatch(pressed, /scale\(/);

  // Doubled class on purpose: each of these knobs carries per-theme
  // overrides selected as `html[data-theme="..."] .notification-filter-
  // selector`, which outranks a plain `[data-pressed] > .segmented-knob` and
  // was quietly keeping the frosted fill on while every other part of the
  // press applied.
  assert.match(css, /\[data-pressed\] > \.segmented-knob\.segmented-knob \{/);
});

test("the pressed knob is clear glass with a lens, wherever it appears", () => {
  // Clearing the frost is gated on the lens really being able to run.
  // WebKit does not displace backdrops by any arrangement — see
  // displacesBackdropContent in GlassRefractionFilter.tsx — so clearing it
  // unconditionally left a transparent hole where the glass should be.
  const clear = rule(
    'html[data-glass-lens-split] [data-pressed] > .segmented-knob.segmented-knob,\nhtml[data-live-glass-refraction] [data-pressed] > .segmented-knob.segmented-knob',
  );
  assert.match(clear, /background: transparent;/);
  assert.match(clear, /backdrop-filter: none;/);
  assert.match(clear, /box-shadow: none;/);

  // Where it cannot run, the knob keeps a real frosted material instead.
  const pressed = rule("[data-pressed] > .segmented-knob.segmented-knob");
  assert.match(pressed, /background: color-mix\(in srgb, var\(--color-surface\) 24%, transparent\);/);
  assert.match(pressed, /backdrop-filter: blur\(14px\)/);

  // Zero blur: this samples the backdrop so `filter` can bend it, and
  // blurring first turns a line crossing the rim into a smear that happens
  // to be displaced. translateZ is what earns the sample; the blur never was.
  const lensPressed = rule("[data-pressed] > .segmented-knob::before");
  assert.match(lensPressed, /backdrop-filter: blur\(0px\);/);
  assert.match(lensPressed, /transform: translateZ\(0\);/);
  assert.match(
    css,
    /html\[data-glass-lens-split\] \[data-pressed\] > \.segmented-knob::before \{\s*\n\s*filter: var\(--glass-lens-filter, none\);/,
  );

  // The labels drop below the knob so the lens has something to bend: a
  // backdrop-filter can only bend what is painted beneath it.
  assert.match(rule("[data-pressed] .segmented-option"), /z-index: 0;/);
  // And the track stops clipping, or the bloom stops at the rail.
  assert.match(rule("[data-pressed]"), /overflow: visible;/);

  // The knob has to actually be given a lens, or the variable resolves to
  // `none` and the whole thing is an invisible no-op.
  assert.match(filter, /KNOB_SELECTOR = "\.theme-toggle-selector, \.segmented-knob"/);
  assert.match(filter, /GENERIC_SELECTOR[\s\S]{0,400}\.segmented-knob/);
});

test("the knob squashes as it is thrown and rounds out as it lands", () => {
  // A knob that deforms the whole time it is lifted is a shape, not a
  // response. The deformation belongs to the journey and to nothing else:
  // set when the knob is thrown, scaled by how far it has to go, released as
  // it lands.
  //
  // It used to be solved from the pointer's own speed, sampled move by move,
  // which is the one thing a pointer that carries the knob can say and a
  // pointer that only names a stop cannot. With the drag gone there is no
  // speed to read, so the distance is the whole of it — a flick across five
  // stops deforms fully, a step to the neighbour barely ovals.
  assert.match(hook, /squash: number;/);
  assert.match(hook, /setSquash\(Math\.min\(1, 0\.4 \+ distance \* 0\.3\)\);/);
  assert.doesNotMatch(hook, /SQUASH_FULL_SPEED/);
  assert.doesNotMatch(hook, /performance\.now\(\)/);

  // Both of them inside the travel, so there is one schedule to read rather
  // than a value nudged from several handlers — which is what made the old
  // one take a settle timer of its own to notice a finger holding still.
  assert.equal((hook.match(/setSquash\(/g) ?? []).length, 2);
  const travel = hook.match(/const travelTo = \(index: number\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(travel, "expected a travelTo");
  assert.equal((travel[0].match(/setSquash\(/g) ?? []).length, 2);

  // The one timer left has to be cleared on unmount, or a journey that
  // outlives its control sets state on something that is gone.
  assert.match(hook, /useEffect\(\(\) => cancelTravel, \[\]\);/);

  // Every option bar hands the value to the CSS.
  for (const [name, source] of [
    ["organisation", org],
    ["notification inbox", inbox],
    ["theme toggle", themeToggle],
  ]) {
    assert.match(source, /"--segmented-squash": drag\.squash,/, `${name} should pass the squash`);
  }

  // It thins by about half of what it stretches by, which is what keeps it
  // reading as one soft lump rather than a circle being scaled: a real body
  // pushed sideways gives up some height, but not all it gains in width,
  // because it also bulges toward a viewer that a flat screen cannot show.
  const knob = rule(".segmented-knob");
  assert.match(knob, /--segmented-stretch: calc\(var\(--segmented-squash, 0\) \* 0\.22rem\);/);
  assert.match(knob, /--segmented-thin: calc\(var\(--segmented-squash, 0\) \* 0\.12rem\);/);
  // Never declared ON the knob: a custom property set on an element beats
  // the same property inherited from its parent, so declaring it here would
  // shadow the value the track is passing down and pin every knob at 0.
  assert.doesNotMatch(knob, /--segmented-squash:/);

  // Measured in the browser on the theme knob, which sizes its own box:
  // 51.0x51.0 at rest, 58.0x47.2 at full squash.
  assert.match(css, /width: calc\(var\(--theme-stop-size\) \* var\(--theme-knob-bloom\) \+ var\(--segmented-squash, 0\) \* 0\.44rem\);/);
  assert.match(css, /height: calc\(var\(--theme-stop-size\) \* var\(--theme-knob-bloom\) - var\(--segmented-squash, 0\) \* 0\.24rem\);/);

  // Someone who asked for less motion has asked for less of this. The bloom
  // and the refraction stay — they say which option is being pointed at —
  // but the squash says nothing the position does not already say.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.segmented-knob,\s*\n\s*\.theme-toggle-base\[data-pressed\] \.theme-toggle-selector \{\s*\n\s*--segmented-squash: 0;/,
  );
});

test("the lens is only promised where the engine can actually deliver it", () => {
  // The split-property pattern was believed to run on Safari. It does not.
  // Four arrangements were rendered in WebKit against a striped backdrop
  // with a strong radial map — backdrop-filter: url(), backdrop-filter:
  // blur() url(), their unprefixed forms, and filter: url() on an element
  // separately carrying backdrop-filter: blur() — and every one left the
  // stripes straight, where the same markup in Chromium bends them plainly.
  // WebKit does filter an element's OWN painted content; the backdrop never
  // enters the filter.
  assert.match(filter, /function displacesBackdropContent\(\)/);
  assert.match(filter, /if \(!displacesBackdropContent\(\)\) return false;/);

  // Asked as a positive test for the engine family that does it, not as a
  // test against the one that does not. Keying off a WebKit quirk excluded
  // Safari correctly and then let Firefox through, which implements neither
  // the prefixed property nor backdrop displacement. Everything that is not
  // Chromium belongs on the clone path, which is the safe side to be wrong
  // on — the clone needs nothing from the backdrop compositor.
  const body = filter.match(/function displacesBackdropContent\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(body, /return isChromium\(\);/);
  assert.match(filter, /function isChromium\(\)/);
});

test("engines that cannot filter a backdrop bend a copy of it instead", () => {
  // WebKit filters an element's own painted content perfectly well; it just
  // will not put a backdrop through a filter. So the knob stops asking to
  // bend what is behind it and carries a copy of what is behind it.
  assert.match(filter, /function supportsCloneLens\(\)/);
  assert.match(filter, /if \(displacesBackdropContent\(\)\) return false;/);
  assert.match(filter, /document\.documentElement\.dataset\.glassLensClone = "";/);
  // The filter definitions have to be mounted for it, or the CSS points at
  // a filter id that is not in the document and nothing bends.
  assert.match(filter, /const filterNeeded = enabled \|\| splitLensEnabled \|\| cloneLensEnabled;/);
  // And the bucketed per-shape filters too — the knob's circle is one.
  assert.match(filter, /const bucketedLensNeeded = splitLensEnabled \|\| cloneLensEnabled;/);

  // The copy has to be registered to the original to the pixel, or it reads
  // as a second offset image rather than as the same thing seen through
  // glass. It is placed by the negative of the knob's own position, so
  // there is one definition of that position rather than two.
  const copy = rule(
    'html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-knob-refraction-copy',
  );
  assert.match(copy, /left: calc\(-1 \* var\(--knob-x\) - 2px\);/);
  assert.match(copy, /top: calc\(-1 \* var\(--knob-y\) - 2px\);/);

  // The travel is backed out on `translate` rather than folded into `left`
  // with the rest, and that distinction is the whole point: the knob's own
  // travel is a transition, so a compensation held in `left` jumps to the
  // destination the moment a stop is tapped while the knob is still gliding
  // there. Measured on a two-stop tap, that left the copy 78.5px away from
  // the track it is standing in for, easing back to zero across the whole
  // 440ms journey — which is visible as the copy's own pill outline sliding
  // across the real one. On `translate` against the same transition below,
  // the two interpolate together and the error stays under a pixel.
  assert.match(
    copy,
    /translate: calc\(-1 \* var\(--theme-index\) \* var\(--theme-stop-pitch\)\) 0;/,
  );
  const copyTravel = rule(
    "html[data-glass-lens-clone] .theme-toggle-base[data-pressed][data-settling] .theme-knob-refraction-copy",
  );
  const knobTravel = rule(".theme-toggle-base[data-pressed][data-settling] .theme-toggle-selector");
  // Same duration and same curve, or they drift apart mid-journey. Read out
  // of the knob's own rule rather than written twice, so a change to one
  // that is not made to the other fails here instead of on a device.
  const travelCurve = knobTravel.match(/translate (\d+ms cubic-bezier\([^)]*\))/)[1];
  assert.match(copyTravel, new RegExp(`transition: translate ${travelCurve.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`));
  // And none on the base rule, matching the knob: the two have to ease at
  // exactly the same moments and never at any others, and the settling rule
  // above is the one place both are given that easing. A transition here
  // would run the copy on changes the knob makes without one, and a copy
  // that eases while the track under it does not is a second pill outline
  // sliding across the real one.
  assert.doesNotMatch(copy, /transition:/);

  // Measured: copy and track both land at 254.1,10.7 118.9x42.4 on WebKit.
  const pressedKnob = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.match(pressedKnob, /left: var\(--knob-x\);/);
  assert.match(pressedKnob, /top: var\(--knob-y\);/);

  // Opaque, or the untouched original shows through and every line appears
  // twice — once bent, once not.
  assert.match(copy, /background: color-mix\(in srgb, var\(--color-surface\) 48%, var\(--color-background\)\);/);
  // The clip is on the knob, so it happens after the filter: the copy is
  // deliberately larger than the disc so the bend has content to pull in.
  const cloneKnob = rule(
    'html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-toggle-selector',
  );
  assert.match(cloneKnob, /overflow: hidden;/);
  assert.match(cloneKnob, /background: transparent;/);

  // No rim or lift added here, and no opaque fill on the lens layer. Both
  // were tried to make the disc read at 1x and both were rejected on a real
  // device; the layer stays transparent outside the copy so the page shows
  // through it unaltered.
  assert.doesNotMatch(cloneKnob, /0 3px 10px/);
  const lensLayer = rule('html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-knob-refraction');
  assert.doesNotMatch(lensLayer, /background:/);

  // Inert wherever the clone path is off, so Chromium is untouched by it.
  assert.match(rule(".theme-knob-refraction,\n.theme-knob-refraction-copy"), /display: none;/);
});

test("a knob sent to a stop travels there instead of teleporting onto it", () => {
  // Naming a stop is all a hover does, and all a tap does: there is nothing
  // under the pointer for the knob to follow, so it has to make the journey
  // itself. Every route that names a stop — hovering an option, focusing one
  // with the keyboard — goes through the one travel.
  assert.match(hook, /if \(index !== null\) travelTo\(index\);/);
  assert.match(hook, /const distance = Math\.abs\(index - position\);/);
  // A knob already on the stop has no journey to make, and starting one
  // would deform it on the spot.
  assert.match(hook, /if \(distance < 0\.5\) return;/);
  // Nothing follows a pointer any more, so none of the gesture that used to
  // is left: no press to move the knob on, no capture to hold, no threshold
  // to decide whether a tap had become a drag.
  assert.doesNotMatch(hook, /DRAG_THRESHOLD/);
  assert.doesNotMatch(hook, /setPointerCapture/);
  assert.doesNotMatch(hook, /onPointerDown/);
  assert.doesNotMatch(hook, /onPointerUp/);

  // Which leaves touch, where there is no hover to answer at all. A tap
  // fires pointerenter on its way in, so the knob is thrown before the click
  // that commits — but pointerleave arrives BEFORE that click, so leaving
  // must not cut the journey short. It clears the lift and the preview and
  // deliberately touches neither the travel nor the deformation.
  const leave = hook.match(/const leave = \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(leave, "expected a leave");
  assert.doesNotMatch(leave[0], /setSquash\(/);
  assert.doesNotMatch(leave[0], /cancelTravel\(/);
  assert.doesNotMatch(leave[0], /setSettling\(/);

  // The stretch is released BEFORE the knob lands, not when it lands:
  // returning to round is itself a 200ms eased change, so releasing it on
  // arrival leaves the knob reforming after it has already stopped, which
  // reads as two events rather than one.
  assert.match(hook, /const TRAVEL_MS = 440;/);
  assert.match(hook, /const REFORM_MS = 200;/);
  assert.match(hook, /\}, TRAVEL_MS - REFORM_MS\);/);
  // And the lifted state outlasts the landing, or the squash rule is taken
  // away mid-reform and the shape snaps round.
  assert.match(hook, /setSettling\(false\);\n\s*settleTravel\.current = null;\n\s*\}, REFORM_MS \* 2\);/);
  // The schedule this pins was measured in the browser on a tap two stops
  // away: launch with squash 1, released at 314ms, settled at 720ms. It is
  // the same schedule either way — what changed is what starts it.
  assert.match(hook, /setSquash\(Math\.min\(1, 0\.4 \+ distance \* 0\.3\)\);/);

  // Still lifted while it flies, or it would shrink away from the icon it
  // is being drawn to — and on touch this is the whole of the lift, since
  // the pointer has left before the knob has landed.
  assert.match(hook, /pressed: hovering \|\| settling,/);
  for (const [name, source] of [
    ["organisation", org],
    ["notification inbox", inbox],
    ["theme toggle", themeToggle],
  ]) {
    assert.match(source, /data-settling=\{drag\.settling \? "" : undefined\}/, `${name} needs the settling flag`);
  }

  // A lifted knob deliberately has no glide — that rule was written for a
  // drag, where easing only makes the lens trail the finger — so travelling
  // has to put one back. Which makes the travel load-bearing rather than
  // decorative: without it a hover move would teleport the knob.
  const settling = rule('.theme-toggle-base[data-pressed][data-settling] .theme-toggle-selector');
  assert.match(settling, /translate 440ms/);
  const pressed = rule(".theme-toggle-base[data-pressed] .theme-toggle-selector");
  assert.doesNotMatch(pressed, /transition:[^;]*translate/);
});

test("the clone lens costs only what it uses", () => {
  // Every filter is a full displacement map: a PNG built, decoded and then
  // sampled again on every frame the lens moves, because the content under
  // a moving lens changes. On the clone path only knobs use one — a card
  // cannot carry a copy of a whole page behind it — so measuring every card
  // and building maps for shapes nothing references is pure cost.
  assert.match(filter, /function measureGenericPanes\(knobsOnly = false\)/);
  assert.match(filter, /knobsOnly \? KNOB_SELECTOR : GENERIC_SELECTOR/);
  assert.match(filter, /measureGenericPanes\(cloneLensEnabled && !splitLensEnabled\)/);

  // And the knob's map is built at a fraction of a card's. A displacement
  // map is a smooth gradient stretched onto its pane, so its useful
  // resolution is set by what it lands on: a card is hundreds of pixels
  // across, a knob is about fifty. Verified indistinguishable at 192.
  assert.match(filter, /const KNOB_MAP_SIZE = 96;/);
  assert.match(filter, /bucket\.bezelWidth === KNOB_BEZEL_WIDTH \? KNOB_MAP_SIZE : GENERIC_MAP_SIZE,/);
  // Measured on an emulated iPhone: 5 filters before, 2 after. The size
  // itself was checked against 192 and 384 and the rendering is
  // indistinguishable, so the smallest is kept.

  // The backdrop layer is switched off where nothing can bend it. A
  // backdrop-filter on a moving, resizing element makes the compositor
  // re-snapshot what is behind it every frame — the frame the animation
  // needs — and on WebKit that snapshot is then thrown away.
  const deadLayer = rule(
    'html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-toggle-selector::before',
  );
  assert.match(deadLayer, /display: none;/);
  assert.match(deadLayer, /backdrop-filter: none;/);

  // The lens layer is deliberately left transparent outside the copy. A
  // measured per-theme fill was tried there, to stop the disc reading as a
  // paler patch of the header, and it made it read as a flat one instead.
  assert.doesNotMatch(css, /--knob-behind:/);

  // The track's own radius. At 0.75rem the copy's ends were nearly square,
  // and a square corner pushed through a round lens comes out as a wedge —
  // the triangle reported in the middle of the knob. The map itself is a
  // clean ring, confirmed by dumping the generated PNG, so the angle was
  // never the lens. This went in once before as part of a batch that was
  // rejected as a whole; it is back on its own.
  const copy2 = rule('html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-knob-refraction-copy');
  assert.match(copy2, /border-radius: var\(--radius-xl\);/);
});
