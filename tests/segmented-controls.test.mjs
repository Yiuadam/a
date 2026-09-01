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
  // A rule that names this selector on its own is what these assertions are
  // about, so it is what gets looked for first. Several selectors here are
  // also members of a shared rule listing others alongside them, and that
  // shared rule sits earlier in the stylesheet — so searching the grouped
  // form first would quietly return the wrong block and assert against
  // declarations that belong to something else.
  //
  // The grouped form is only the fallback, for a selector that has no rule of
  // its own because it joined one. Two elements converging on the same
  // declarations is how these controls are meant to end up, and it should not
  // read as a missing rule. Leading selectors must contain no brace and no
  // slash, so a preceding comment cannot be mistaken for part of the list.
  const match =
    css.match(new RegExp(`\\n${escaped} \\{[\\s\\S]*?\\n\\}`)) ??
    css.match(new RegExp(`\\n(?:[^{}/]*,\\n)*${escaped}(?:,\\n[^{}]*?)? \\{[\\s\\S]*?\\n\\}`));
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

  // Two gestures reach the same knob and both live here. Hover lifts it and
  // throws it between options; a press that moves carries it under the
  // pointer. They were built one after the other and each time only one
  // survived — the drag was taken out so hover could have the effect, and
  // hover kept it — so what is worth pinning is that both are present at
  // once rather than either one on its own.
  assert.match(hook, /onPointerEnter: \(\) => setHovering\(true\),/);
  assert.match(hook, /const travelTo = \(index: number\) => \{/);
  assert.match(hook, /onPointerDown: \(event\) => \{/);
  assert.match(hook, /onPointerMove: \(event\) => \{/);
  assert.match(hook, /onPointerUp: \(event\) => \{/);
  assert.match(hook, /const trackPointer = \(event: PointerEvent<HTMLDivElement>\) => \{/);
  // And the lift answers all three states, so it covers a pointer resting on
  // the bar, a finger carrying the knob, and a knob still in the air.
  assert.match(hook, /pressed: hovering \|\| pressing \|\| settling,/);

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
    // The hit test clamps to the ends of the bar, which it can only do if it
    // is told how many stops there are.
    assert.match(source, /\n\s*count: [A-Za-z][\w.]*\.length,/, `${name} should say how many stops it has`);
    // Two commit paths, one per gesture, and never both for the same
    // gesture. A tap commits in the option's own click, which is how all
    // three bars have always chosen. A drag ends over an option that gets no
    // click at all — the track captures the pointer the moment the gesture
    // becomes a drag, and the compatibility click is retargeted to the track
    // with it — so the drag commits through the hook instead. Dropping
    // either one loses a whole gesture; firing both would commit twice, and
    // the organisation bar pushes a history entry per commit.
    assert.match(source, commit, `${name} should commit a tap in the option's own click`);
    assert.match(source, /onCommit: \(index\) =>/, `${name} should give the drag somewhere to commit`);
    // And none of the hand-rolled machinery should survive.
    assert.doesNotMatch(source, /const dragging = useRef\(false\)/, `${name} still has its own drag state`);
    assert.doesNotMatch(source, /indexAtPointer/, `${name} still has its own hit test`);
    // touch-none is what the drag costs the page, and it is deliberate: a
    // finger sliding across the bar has to carry the knob rather than scroll
    // whatever is behind it, and it cannot do both. It came off while there
    // was no drag to own the gesture, because then all it did was refuse to
    // scroll a page from a control that happens to be under a thumb.
    assert.match(source, /touch-none/, `${name} needs the gesture its drag runs on`);
  }
});

test("the pressed knob blooms its own box, and its stride stays one stop", () => {
  // The bloom is the box's now, not its layers'. It used to grow ::before and
  // ::after outward with a negative inset and leave the box alone, because
  // the knob stepped by `translate3d(index * 100%)` — a percentage of its OWN
  // width — and a wider box would have lengthened every step and landed the
  // knob past its label. The cost was that the pill never actually expanded:
  // measured in the browser, 53.5px wide idle and pressed alike, while the
  // theme knob went 36.1px to 54.2px. Only a ring bloomed around a box that
  // sat still, which is not the same gesture at all.
  //
  // Subtracting the growth back off the stride is what freed the box. Every
  // term below is the element's own border box, so what remains after the
  // swell comes off is exactly one stop, whatever the knob currently measures.
  const knob = rule(".segmented-knob");
  assert.match(knob, /--segmented-grow: 0px;/);
  assert.match(
    knob,
    /translate3d\(\s*calc\(\s*var\(--segmented-index, 0\) \*\s*\(100% - 2 \* var\(--segmented-grow\) - 2 \* var\(--segmented-stretch\)\)\s*\)/,
  );
  // It must not step by the span. A percentage resolves against the
  // containing block in `width` but the element's own border box in
  // `transform`, so --segmented-span sizes the knob correctly and would step
  // it by a fraction of itself — measured at 38.5px against a true pitch of
  // 86.1px, i.e. never leaving the first stop.
  assert.doesNotMatch(knob, /translate3d\(\s*calc\(\s*var\(--segmented-index, 0\) \* var\(--segmented-span\)\)/);

  // The box carries bloom and squash together, and grows about its own centre:
  // the left edge gives up half of what the width gains.
  assert.match(knob, /width: calc\(var\(--segmented-span\) \+ 2 \* var\(--segmented-stretch\) \+ 2 \* var\(--segmented-grow\)\);/);
  assert.match(knob, /left: calc\(var\(--segmented-inset\) - var\(--segmented-stretch\) - var\(--segmented-grow\)\);/);
  assert.match(knob, /inset-block: calc\(var\(--segmented-inset\) \+ var\(--segmented-thin\) - var\(--segmented-grow\)\);/);

  // Position belongs to this rule now. It was `relative` here once, which at
  // equal specificity beat the `absolute` each knob set in its own earlier
  // rule: the knob fell back into flow, took a grid column of its own and
  // pushed the options along by one.
  assert.match(knob, /position: absolute;/);
  assert.doesNotMatch(knob, /position: relative;/);

  // The layers are flush with the box, since they no longer fake its growth.
  const lens = rule(".segmented-knob::before");
  assert.match(lens, /\n {2}inset: 0;/);
  const rim = rule(".segmented-knob::after");
  assert.match(rim, /\n {2}inset: 0;/);

  const pressed = rule("[data-pressed] > .segmented-knob.segmented-knob");
  assert.match(pressed, /--segmented-grow: 0\.4375rem;/);
  // Offsets, never a scale: growing by a transform would stretch the backdrop
  // the lens is sampling along with the knob, and the glass would stop
  // reading as glass.
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

  // The labels stay above the knob, press included. They used to drop below
  // it so the lens had something to bend, which only worked where the press
  // clears the frost — and on WebKit it never does, because the lens it would
  // hand over to cannot run there at all. The word underneath was read
  // through a 9px blur for as long as a finger was down, reported from an
  // iPhone as a white blob with a smudge in it. The theme control settled
  // this first and keeps its glyphs on top.
  assert.doesNotMatch(css, /\[data-pressed\] \.segmented-option \{/);
  // And the track stops clipping, or the bloom stops at the rail.
  assert.match(rule("[data-pressed]"), /overflow: visible;/);

  // The knob has to actually be given a lens, or the variable resolves to
  // `none` and the whole thing is an invisible no-op.
  assert.match(filter, /KNOB_SELECTOR = "\.theme-toggle-selector, \.segmented-knob"/);
  assert.match(filter, /GENERIC_SELECTOR[\s\S]{0,400}\.segmented-knob/);
});

test("the knob squashes as it moves and rounds out as it stops, however it is moved", () => {
  // A knob that deforms the whole time it is lifted is a shape, not a
  // response. The deformation belongs to the motion and to nothing else.
  //
  // Where the number comes from depends on which gesture is doing the
  // moving, because the two have different measurements to hand. A drag can
  // read the pointer's own speed, move by move, so it does: a slow
  // deliberate drag barely ovals and a flick deforms fully. A hover or a tap
  // only names a stop and leaves, so there is no speed to read and the
  // distance is the whole of it — crossing five stops deforms more than
  // stepping to the neighbour. One value, two ways of solving it, because
  // neither gesture can be expressed in the other's terms.
  assert.match(hook, /squash: number;/);
  assert.match(hook, /const SQUASH_FULL_SPEED = 4;/);

  // A drag's reading is filtered before it becomes a shape, and filtered
  // asymmetrically. One sample is a raw derivative — one distance over one
  // gap between pointer events — and those gaps are uneven enough that a
  // late frame reads as a flick and a doubled event reads as a stop. Fed
  // straight to the knob it fluttered between fat and thin under a steady
  // finger, reporting the event timer rather than the gesture. Rising faster
  // than it falls is what makes the recovery read as a material: thrown
  // water deforms at once and takes its time coming back.
  assert.match(hook, /const SQUASH_RISE = 0\.5;/);
  assert.match(hook, /const SQUASH_FALL = 0\.2;/);
  assert.match(hook, /const target = Math\.min\(1, speed \/ SQUASH_FULL_SPEED\);/);
  assert.match(
    hook,
    /const level = current \+ \(target - current\) \* \(target > current \? SQUASH_RISE : SQUASH_FALL\);/,
  );
  // And a change too small to see does not cost a render. A pointer can fire
  // far more often than the screen refreshes, and a hundredth of a squash is
  // a fraction of a pixel.
  assert.match(hook, /if \(Math\.abs\(level - squash\) >= 0\.01\) setSquash\(level\);/);

  // A throw is not filtered: the distance is known in full at that point, so
  // there is nothing to smooth against. It sets the level outright, and
  // carries the filter's own level with it so a drag beginning before the
  // throw has landed continues from the shape on screen rather than from
  // whatever the filter last held.
  assert.match(hook, /squashLevel\.current = Math\.min\(1, 0\.4 \+ distance \* 0\.3\);/);
  assert.match(hook, /setSquash\(squashLevel\.current\);/);
  // Every reset clears the filter too, or the next gesture starts mid-squash.
  assert.equal((hook.match(/squashLevel\.current = 0;/g) ?? []).length, 3);
  // performance.now, not Date.now: this is an elapsed-time measurement and
  // it must not move when the wall clock is adjusted.
  assert.match(hook, /performance\.now\(\)/);
  assert.doesNotMatch(hook, /Date\.now\(\)/);

  // Each source owns its whole schedule — a value and the thing that takes
  // it away again — so there is one place to read either one rather than a
  // number nudged from several handlers.
  const travel = hook.match(/const travelTo = \(index: number\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(travel, "expected a travelTo");
  assert.equal((travel[0].match(/setSquash\(/g) ?? []).length, 2);
  const sampler = hook.match(/const sampleSpeed = \(next: number\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(sampler, "expected a sampleSpeed");
  assert.equal((sampler[0].match(/setSquash\(/g) ?? []).length, 2);
  // pointermove stops firing the instant a finger holds still, so without a
  // timer of its own nothing would ever tell a dragged knob it had stopped.
  assert.match(
    sampler[0],
    /settleTimer\.current = setTimeout\(\(\) => \{\s*\n\s*squashLevel\.current = 0;\s*\n\s*setSquash\(0\);\s*\n\s*\}, 90\);/,
  );
  // And letting go is a stop, however fast it was travelling a frame ago.
  const end = hook.match(/const end = \(dragged: boolean\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(end, "expected an end");
  assert.match(end[0], /cancelSettle\(\);\s*\n\s*squashLevel\.current = 0;\s*\n\s*setSquash\(0\);/);

  // Both timers have to be cleared on unmount, or a journey — or a squash
  // waiting to round out — outlives its control and sets state on something
  // that is gone.
  assert.match(
    hook,
    /useEffect\(\s*\n\s*\(\) => \(\) => \{\s*\n\s*cancelSettle\(\);\s*\n\s*cancelTravel\(\);\s*\n\s*\},\s*\n\s*\[\],\s*\n\s*\);/,
  );

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

test("WebKit gets a drawn edge, because a bent copy of a flat surface shows nothing", () => {
  // The detection stays, and it is still correct: WebKit will not put a
  // backdrop through a filter by any route, so it never joins the split path.
  assert.match(filter, /function supportsCloneLens\(\)/);
  assert.match(filter, /if \(displacesBackdropContent\(\)\) return false;/);
  assert.match(filter, /document\.documentElement\.dataset\.glassLensClone = "";/);

  // What changed is what that path then does. It used to hand the knob a
  // full copy of the track and bend that instead, on the reasoning that
  // WebKit filters an element's own painted content perfectly well.
  //
  // Every part of that was true, and it was measured on a real iPhone
  // simulator (iOS 18.7, AppleWebKit 605.1.15) rather than inferred: a
  // filter over an element's own content bends it hard, the same filter as
  // a backdrop-filter leaves the identical stripes dead straight, feImage
  // resolves a plain href, supportsCloneLens() returns true, the flag is set
  // on the document, and outlining the copy showed its own boundary arriving
  // visibly warped. The clone path was running, on the device, correctly.
  //
  // It was invisible anyway, and no tuning reaches that. A copy holds only
  // what it is given, and what this one held was the track: a near-flat wash
  // of the page's own colour with three small glyphs on it. Bending flat
  // cream against a cream page moves pixels that all look the same. The
  // thing with contrast worth bending is the page behind the header, which
  // is exactly what a copy cannot contain and what WebKit will not filter.
  //
  // So the copy is gone from the stylesheet and from the markup.
  assert.doesNotMatch(css, /theme-knob-refraction/);
  assert.doesNotMatch(themeToggle, /theme-knob-refraction/);

  // In its place, real frosted glass — which WebKit does support — so the
  // icon and track under the knob stay visible through it rather than being
  // replaced by an opaque copy of themselves.
  const cloneKnob = rule(
    'html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-toggle-selector',
  );
  assert.match(cloneKnob, /backdrop-filter: blur\(9px\)/);
  assert.doesNotMatch(cloneKnob, /background: transparent;/);
  // And a drawn edge: a bright inner hairline where a lens catches the
  // light, a lift under the top rim and a shade under the bottom one,
  // standing in for the compression a solved bevel would produce.
  assert.match(cloneKnob, /inset 0 0 0 1px/);

  // The spectral fringe, and the axis it runs along is the point.
  //
  // It was a cone of hue first: the colour cycled as you went round the rim.
  // That is the wrong axis and it looked it. Dispersion does not vary with
  // which way a piece of edge faces — it varies with how far the light was
  // bent, which at a rim changes as you move across the fringe rather than
  // along it. So the ramp is radial, and its order is wavelength order: red
  // where the bend is least, violet where it is most, because a shorter
  // wavelength is deviated further by the same surface.
  //
  // And thin. A fringe on real glass is the narrowest thing about it, the
  // last sliver before the edge rather than a halo standing off it.
  const ring = rule(
    'html[data-glass-lens-clone] .theme-toggle-base[data-pressed] .theme-toggle-selector::after',
  );
  assert.doesNotMatch(ring, /conic-gradient/);
  assert.match(ring, /background: radial-gradient\(\s*\n\s*closest-side,\s*\n\s*transparent 0 88%,/);
  assert.match(ring, /#ff6a3d[\s\S]*#5aa8ff/, "red must come before blue across the band");
  // The base rule builds its hairline from padding plus a two-layer xor
  // mask, and the padding has to be undone here or the band is masked twice.
  assert.match(ring, /padding: 0;/);

  // Not a full ring. One light, placed up and to the left by the drawn
  // highlight, so the colour that comes apart belongs opposite it — down and
  // to the right. A band all the way round implies the edge is doing the same
  // thing everywhere, which is what made it read as a decoration drawn on the
  // knob rather than as something happening to light. 135deg runs top-left to
  // bottom-right, so it fades the band out exactly where the highlight is.
  assert.match(ring, /mask-image: linear-gradient\(135deg, transparent 32%, #000 78%\);/);
  // On Chromium the same restriction is the specular's own dot product with
  // its sign flipped, so the highlight and the fringe cannot disagree about
  // where the light is — and composited `in`, which is what multiplies the
  // two alphas rather than adding them.
  assert.match(filter, /const SPECTRUM_SIDE = 5;/);
  assert.match(filter, /result="spectrum-side"/);
  assert.match(filter, /in2="spectrum-side"\s*\n\s*operator="in"/);

  // Costing nothing per frame is the other half of this. The live path was
  // re-running a filter over a moving element every frame for a result
  // nobody could see, which is what "laggy" was.
  assert.doesNotMatch(cloneKnob, /filter: var\(--glass-lens-filter/);
});

test("a knob sent to a stop travels there instead of teleporting onto it", () => {
  // Naming a stop is all a hover does, and all a tap does: there is nothing
  // under the pointer for the knob to follow, so it has to make the journey
  // itself. Every route that names a stop — hovering an option, focusing one
  // with the keyboard, releasing a press that never moved — goes through the
  // one travel.
  assert.match(hook, /if \(index !== null\) travelTo\(index\);/);
  assert.match(hook, /const distance = Math\.abs\(index - position\);/);
  // A knob already on the stop has no journey to make, and starting one
  // would deform it on the spot.
  assert.match(hook, /if \(distance < 0\.5\) return;/);

  // A press is not a journey and it is not a drag either, not yet. The knob
  // must not jump to the finger on pointerdown: that is what made a tap
  // teleport it, leaving the travel above nothing to animate. So the gesture
  // has to move a real distance before it counts as one, and only then does
  // the knob come off its stop.
  assert.match(hook, /const DRAG_THRESHOLD = 0\.06;/);
  assert.match(hook, /const moved = useRef\(false\);/);
  assert.match(
    hook,
    /if \(from !== null && Math\.abs\(positionAtPointer\(event\) - from\) < DRAG_THRESHOLD\) return;\s*\n\s*moved\.current = true;/,
  );
  // And a release that never crossed it goes the same way a hover does —
  // name the stop, then travel to it — rather than committing a position the
  // knob was never carried to.
  assert.match(hook, /const dragged = moved\.current;/);
  assert.match(hook, /setPreviewIndex\(index\);\s*\n\s*travelTo\(index\);/);

  // The two gestures must not fight over the position. A hover that lands
  // mid-drag would put the 440ms glide back on a knob that is meant to be
  // pinned under the pointer, and name a stop the finger has already left,
  // so `preview` stands down for as long as a gesture is running.
  assert.match(hook, /if \(dragging\.current\) return;\s*\n\s*setPreviewIndex\(index\);/);
  // And the throw hover may have started a moment ago is called off at the
  // threshold — not on pointerdown, which would cut short the journey toward
  // the very option being pressed.
  const move = hook.match(/onPointerMove: \(event\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(move, "expected an onPointerMove");
  assert.match(move[0], /cancelTravel\(\);/);
  assert.match(move[0], /setSettling\(false\);/);
  const down = hook.match(/onPointerDown: \(event\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(down, "expected an onPointerDown");
  assert.doesNotMatch(down[0], /cancelTravel\(/);
  assert.doesNotMatch(down[0], /setSettling\(/);
  // Nor does it move or capture anything. Both wait for the threshold.
  assert.doesNotMatch(down[0], /setDragPosition\(/);
  assert.doesNotMatch(down[0], /setPointerCapture\(/);

  // The capture is taken at the same moment, and the commit path hangs off
  // it: while the track holds the pointer the compatibility click is
  // retargeted to the track, which has no handler, so a drag can only commit
  // through onCommit — and a tap, which never captures, can only commit
  // through the option's own click. Capturing on pointerdown instead would
  // have taken the click away from taps too, leaving two paths racing for
  // one commit.
  assert.match(move[0], /event\.currentTarget\.setPointerCapture\(event\.pointerId\);/);
  const up = hook.match(/onPointerUp: \(event\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(up, "expected an onPointerUp");
  assert.match(up[0], /if \(dragged\) \{[\s\S]*?onCommit\(index\);/);
  assert.match(up[0], /event\.currentTarget\.releasePointerCapture\(event\.pointerId\);/);

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
  assert.match(hook, /squashLevel\.current = Math\.min\(1, 0\.4 \+ distance \* 0\.3\);/);

  // Still lifted while it flies, or it would shrink away from the icon it
  // is being drawn to — and on touch this is the whole of the lift, since
  // the pointer has left before the knob has landed. The lift covers all
  // three states: a pointer resting on the bar, a finger carrying the knob,
  // and a knob still in the air after both have gone.
  assert.match(hook, /pressed: hovering \|\| pressing \|\| settling,/);
  for (const [name, source] of [
    ["organisation", org],
    ["notification inbox", inbox],
    ["theme toggle", themeToggle],
  ]) {
    assert.match(source, /data-settling=\{drag\.settling \? "" : undefined\}/, `${name} needs the settling flag`);
  }

  // A lifted knob deliberately has no glide — that rule is written for the
  // drag, where easing only makes the lens trail the finger — so travelling
  // has to put one back. Which makes the travel load-bearing rather than
  // decorative in both directions: without it a hover move would teleport
  // the knob, and with it left switched on a drag would lag behind the
  // pointer. Settling is therefore the one flag that separates them, and the
  // drag clears it at the threshold.
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

  // The copy's own corner radius used to be asserted here — it had to match
  // the track's, because a square corner pushed through a round lens came
  // out as a wedge, the triangle once reported in the middle of the knob.
  // There is no copy any more, so there is no corner to match: see the
  // drawn-edge test above for what WebKit gets instead and why.
  assert.doesNotMatch(css, /theme-knob-refraction-copy/);
});
