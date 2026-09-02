import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

const cssRule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const end = css.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${selector} rule`);
  return css.slice(start, end + 2);
};

test("live glass uses the browser compositor and preserves low-cost fallbacks", () => {
  const engine = read("components/PointerAttraction.tsx");
  const refraction = read("components/GlassRefractionFilter.tsx");
  const css = read("app/globals.css");

  /*
    This test used to open components/RefractiveGlassLayer.tsx and its
    capability gate, and check that the displacement pane they mounted did its
    work on the compositor rather than in a render loop. Both files are gone.

    The reason matters more than the deletion: the layer was not too expensive,
    it was wrong to look at. What the owner asked for is glass you can see
    through, and a displacement pane over live page content reads as fog and
    smearing instead — the text behind it bends and nothing underneath is
    legible. So the whole site is frosted material now, and the only refraction
    left anywhere is the option-bar knob below, which bends a small disc of
    backdrop it fully covers rather than a card-sized pane of the page.

    Asserting the absence rather than dropping the test, because a layer like
    this is easy to reintroduce one card at a time.
  */
  assert.doesNotMatch(refraction, /RefractiveGlassLayer|GlassPerformanceGate/);
  assert.doesNotMatch(engine, /liquid-glass-react/);
  assert.doesNotMatch(css, /refractive-glass-layer|refractive-glass-core/);

  assert.doesNotMatch(engine, /data-glass-reflecting|--glass-reflection-|REFLECTION_FRAME_MS/);
  assert.match(engine, /requestAnimationFrame\(draw\)/);
  assert.match(refraction, /supportsDetailedLiveRefraction/);
  assert.match(refraction, /supportsDetailedGlass/);
  assert.match(refraction, /connection\?\.saveData/);
  assert.doesNotMatch(css, /data-glass-reflecting|--glass-reflection-/);
  assert.match(css, /@supports not \(\(-webkit-backdrop-filter:/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\), \(prefers-reduced-motion: reduce\), \(prefers-reduced-transparency: reduce\)/);
});

test("no surface carries a displacement layer, only frosted material", () => {
  const home = read("app/page.tsx");
  const bell = read("components/account/NotificationBell.tsx");
  const inbox = read("components/account/NotificationInbox.tsx");
  const theme = read("components/ThemeToggle.tsx");

  /*
    The opposite of what this test used to check. It named the surfaces that
    had opted in to a displacement pane — a skill card, the primary dashboard
    button, the notification bell, the theme toggle — and held them to it.

    Every one of those opt-ins is gone, and the list is kept here pointing the
    other way because these were the exact places the layer reached. The owner
    turned refraction down on look rather than on cost: it fogged the surfaces
    it was meant to make glassy. What stays on all of them is the material —
    `premade-glass` for tint and clip, the border, the backdrop blur — which is
    what makes them glass in the first place.
  */
  assert.doesNotMatch(home, /RefractiveGlassLayer/);
  assert.doesNotMatch(bell, /RefractiveGlassLayer/);
  assert.doesNotMatch(theme, /RefractiveGlassLayer/);
  assert.match(home, /dashboard-skill-card card premade-glass/);
  assert.match(home, /btn-primary premade-glass/);
  assert.match(bell, /pointer-attract-glass premade-glass/);
  assert.match(theme, /theme-toggle-base premade-glass/);
  assert.match(inbox, /notification-popover liquid-glass/);
  assert.doesNotMatch(inbox, /notification-popover[^\n]*premade-glass/);
});

test("decorative navigation icons inherit one theme-aware token", () => {
  const css = read("app/globals.css");
  const cardIcons = read("components/CardIcon.tsx");
  const skillIcons = read("components/Icons.tsx");
  const bell = read("components/account/NotificationBell.tsx");
  const header = read("components/SiteHeader.tsx");

  assert.match(css, /--app-icon-color: var\(--color-indigo-600\)/);
  assert.match(css, /html\[data-theme="dark"\] body[\s\S]*--app-icon-color: var\(--color-indigo-700\)/);
  assert.match(css, /\.app-icon-color,[\s\S]*color: var\(--app-icon-color\)/);
  assert.match(cardIcons, /className=\{`app-icon-color shrink-0/);
  assert.match(skillIcons, /className=\{`app-icon-color \$\{className\}`\}/);
  assert.match(bell, /className="app-icon-color relative z-10"/);
  assert.match(header, /className="app-icon-control rounded-xl/);
});

test("the full navigation menu stays clearer than the cards it carries", () => {
  const css = read("app/globals.css");
  const header = read("components/SiteHeader.tsx");

  assert.match(header, /className="nav-paper premade-glass/);
  // The sheet was the first surface to lose its displacement layer and is now
  // simply one of many without one — refraction is gone site-wide, rejected
  // for fogging what it covered. The plain CSS blur below is the whole of this
  // sheet's material, and it is what reaches the edges.
  assert.doesNotMatch(header, /RefractiveGlassLayer/);
  // The sheet itself carries no tint or refraction of its own — only the
  // .nav-menu-group cards it holds do, layering their own heavier blur and
  // colour on top. But it does carry a real, uniform blur so the gaps
  // between cards read as a soft glow, not legible page text just because
  // no card happens to cover that spot.
  // The sheet now carries a scrim rather than nothing. Blur alone does not
  // separate the cards from their ground: everything under the sheet is
  // already soft, and cards made of the same light material on a field of
  // the same brightness read as one continuous surface. Taking the ground
  // down slightly gives them an edge to be forward of.
  assert.match(css, /\.nav-paper \{[^}]*background: var\(--nav-scrim, transparent\);/);
  assert.match(css, /\.nav-paper \{[^}]*backdrop-filter: blur\(14px\);/);
  // .nav-paper also carries the .premade-glass class, which light/dark
  // theme rules elsewhere paint with a real background colour — this
  // explicit rule, placed after those, is what actually decides the sheet
  // in every theme rather than only the unthemed default. It has to hand
  // back the same scrim, not `transparent`: returning nothing here dimmed
  // the sheet in one theme and left it clear in the other two.
  assert.match(
    css,
    /html\[data-theme="light"\] \.nav-paper,\nhtml\[data-theme="dark"\] \.nav-paper \{[\s\S]*?background: var\(--nav-scrim, transparent\);\n\}/,
  );
  // A soft warm glow spread across the whole sheet, at a fraction of each
  // card's own — so the glow reads as bathing the panel the cards sit in,
  // not as something that stops dead at a card's own edge. inset, since
  // .nav-paper is the full sheet rather than a bounded shape with an edge
  // to glow outward from.
  assert.match(css, /\.nav-paper \{[^}]*box-shadow: inset 0 0 48px 12px/);
  assert.match(css, /html\[data-theme="dark"\] \.nav-paper \{\s*box-shadow: inset 0 0 48px 12px/);
  assert.doesNotMatch(css, /\.nav-paper > \.refractive-glass-layer/);
  assert.match(css, /@supports not[\s\S]*\.nav-paper \{[\s\S]*background: var\(--color-background\)/);
});

test("navigation keeps its fixed glass surface, and grows outward from the button that opened it", () => {
  const css = read("app/globals.css");
  const header = read("components/SiteHeader.tsx");
  const panel = cssRule(css, ".nav-paper");

  assert.match(header, /className="nav-menu-group liquid-glass/);
  assert.match(header, /className="nav-paper premade-glass fixed inset-x-0 bottom-0 top-\[var\(--header-h\)\]/);
  // The sheet is painted with the scrim it inherits from the open header,
  // which is what gives the cards on it something to stand out from.
  assert.match(panel, /background: var\(--nav-scrim, transparent\);/);
  // The base rule stays motion-inert; the grow lives entirely in the
  // reduced-motion-gated block below, same as every other glass panel.
  assert.doesNotMatch(panel, /\banimation(?:-\w+)?:/);

  // The sheet's own opening move is a scale-from-the-button grow — a
  // clip-path circle reveal was tried and rejected: animating clip-path is
  // not reliably GPU-compositor-accelerated the way transform/opacity are,
  // and every .nav-menu-group card it holds carries its own live SVG
  // refraction filter, genuinely expensive to re-evaluate every frame.
  assert.match(css, /@keyframes nav-sheet-grow \{/);
  assert.match(css, /@keyframes nav-sheet-grow \{[\s\S]*?transform: scale\(0\.06\)/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\.nav-paper \{[\s\S]*?transform-origin: var\(--nav-origin-x, 50%\) top;[\s\S]*?animation: nav-sheet-grow/,
  );
  // transform and opacity only — no clip-path/width/height — is what keeps
  // this compositor-only at the full-viewport scale the sheet animates at.
  const growStart = css.indexOf("@keyframes nav-sheet-grow {");
  const growEnd = css.indexOf("\n}\n", growStart);
  assert.doesNotMatch(css.slice(growStart, growEnd), /\bclip-path\s*:/);

  assert.match(header, /--nav-origin-x/);

  // Each card fades and rises into its own final position rather than
  // reusing the popovers' squash-and-stretch bounce: a card that has
  // already arrived has no reason to keep overshooting past its resting
  // place and springing back.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\.nav-menu-group \{[\s\S]*?animation: nav-card-settle\b/,
  );
  assert.match(css, /@keyframes nav-card-settle \{/);
  const settleStart = css.indexOf("@keyframes nav-card-settle {");
  const settleEnd = css.indexOf("\n}\n", settleStart);
  const settleBody = css.slice(settleStart, settleEnd);
  // Exactly a start and an end state — no intermediate overshoot step for
  // the card to spring past its resting place and back from.
  assert.equal((settleBody.match(/%\s*\{/g) ?? []).length, 2);
  // The cascade is a handful of fixed per-card delays, not a formula fed by a
  // custom property — nothing for SiteHeader itself to compute or clean up.
  assert.doesNotMatch(header, /--nav-group-(?:delay|touch-delay|flow-x)/);
});

test("the header icon ships a right-sized immutable static asset without image optimisation", () => {
  const header = read("components/SiteHeader.tsx");
  const asset = readFileSync(
    join(process.cwd(), "components", "assets", "steps-five-layer-rear-108.png"),
  );

  assert.match(header, /import bandupMarkRear from "@\/components\/assets\/steps-five-layer-rear-108\.png"/);
  assert.match(header, /src=\{bandupMarkRear\}[\s\S]*sizes="36px"[\s\S]*unoptimized/);
  assert.doesNotMatch(header, /src="\/icons\/final\/steps-five-layer-rear\.png"/);
  assert.equal(asset.readUInt32BE(16), 108);
  assert.equal(asset.readUInt32BE(20), 108);
  assert.ok(asset.byteLength < 20_000, `header icon is ${asset.byteLength} bytes`);
});

test("Google's owned iframe is hard-clipped at every wrapper boundary", () => {
  const css = read("app/globals.css");
  const component = read("components/account/GoogleSignIn.tsx");

  assert.match(component, /google-signin-viewport[^"]*overflow-hidden rounded-full/);
  assert.match(component, /google-signin-host[^"]*w-full[^"]*overflow-hidden rounded-full/);
  assert.match(css, /\.google-signin-viewport \{[\s\S]*clip-path: inset\(0 round 999px\)/);
  assert.match(css, /\.google-signin-host iframe \{[\s\S]*width: 100% !important/);
  assert.match(css, /\.google-signin-host,[\s\S]*clip-path: inset\(0\.5px round 999px\)/);
  assert.match(css, /-webkit-mask-image: -webkit-radial-gradient\(white, black\)/);
});

test("the notification popover paints exactly one clipped outer glass boundary", () => {
  const css = read("app/globals.css");
  const inbox = read("components/account/NotificationInbox.tsx");
  const popover = inbox.slice(inbox.indexOf('<div role="dialog" aria-label="Notifications"'), inbox.indexOf("export default function NotificationInbox"));

  // Same Safari workaround as .nav-paper: an `isolate` ancestor with no
  // filter of its own silently zeroes out a descendant's backdrop-filter
  // on real iOS, even though the same CSS blurs fine in Chromium.
  assert.match(css, /\[data-notification-bell-root\] \{[^}]*backdrop-filter: blur\(1px\);/);
  assert.match(popover, /className="notification-popover liquid-glass/);
  assert.doesNotMatch(popover, /RefractiveGlassLayer/);
  assert.doesNotMatch(popover, /premade-glass-content/);
  // `contain: paint` and `clip-path: inset(0 round …)` used to be asserted
  // here and are deliberately gone. clip-path clips everything an element
  // paints, outer box-shadows included, and the warm ambient glow below is an
  // outer shadow whose whole purpose is to spread past the panel's own edge —
  // with a clip in place it was drawn and then thrown away. `overflow: hidden`
  // still rounds the content, which is all either of them was doing.
  // The rule's own comment names both properties, so the check has to read the
  // declarations rather than the prose explaining their absence.
  const popoverRule = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/\n\.notification-popover \{[\s\S]*?\n\}/)?.[0];
  assert.ok(popoverRule, "expected a base .notification-popover rule");
  assert.match(popoverRule, /overflow: hidden;/);
  assert.doesNotMatch(popoverRule, /clip-path:/);
  assert.doesNotMatch(popoverRule, /contain: paint/);

  // A real panel of glass, and one that can only be that from outside the
  // header. An element carrying a backdrop-filter is a Backdrop Root, and
  // .site-header carries one, so anything rendered inside the header samples
  // an empty backdrop and blurs nothing at any radius — which is exactly how
  // this panel came to be reported as a transparent window with the page's
  // own headings legible through it. NotificationBell portals it into
  // document.body, and it is therefore positioned from the anchor geometry
  // that component publishes rather than from Tailwind's `absolute`.
  assert.match(css, /\.notification-popover \{[\s\S]*?position: fixed;[\s\S]*?top: calc\(var\(--notification-anchor-bottom[\s\S]*?right: var\(--notification-anchor-right/);
  assert.match(css, /\.notification-popover \{[\s\S]*?backdrop-filter: blur\(2[0-9]px\)/);

  // The fill is the other half of legibility: dense body text behind the
  // panel has to survive as tone rather than as words, and the page either
  // side of the panel is deliberately left untouched, so nothing else is
  // helping.
  assert.match(css, /\.notification-popover \{[\s\S]*?--notification-tint: color-mix\([\s\S]*?var\(--color-background\) \d\d%, transparent\)/);

  // Both decorative layers redeclare `display`. The reset near the top of the
  // file (`.liquid-glass::before, .card::before { display: none }`) matches
  // this element too, because the panel also carries `liquid-glass` — without
  // the redeclaration the wall and the rim are silently never painted, which
  // is exactly the bug .nav-menu-group's own pseudo-elements once carried.
  assert.match(css, /\.notification-popover::before \{[\s\S]*?display: block;[\s\S]*?pointer-events: none;[\s\S]*?border-radius: inherit;/);
  assert.match(css, /\.notification-popover::after \{[\s\S]*?display: block;[\s\S]*?mask-composite: exclude;/);
  assert.match(css, /\.notification-popover > \* \{[\s\S]*?position: relative;[\s\S]*?z-index: 1/);

  // The warm ambient glow — .nav-menu-group's third box-shadow, to the value.
  // It is the layer the owner means by "glow" and the one most easily lost.
  assert.match(css, /\.notification-popover \{[\s\S]*?0 0 14px 2px color-mix\(in srgb, rgb\(142, 104, 78\) 7%, transparent\)/);

  // No more special-cased exclusion from the SVG lens: this popover now
  // gets exactly the generic .liquid-glass refraction treatment.
  assert.doesNotMatch(css, /html\[data-theme\]\[data-live-glass-refraction\] \.liquid-glass\.notification-popover/);
});
