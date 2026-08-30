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
  const component = read("components/RefractiveGlassLayer.tsx");
  const gate = read("components/GlassPerformanceGate.tsx");
  const engine = read("components/PointerAttraction.tsx");
  const refraction = read("components/GlassRefractionFilter.tsx");
  const css = read("app/globals.css");

  assert.match(component, /interactive = false/);
  assert.match(component, /<GlassPerformanceGate>/);
  assert.match(gate, /return enabled \? children : null/);
  assert.doesNotMatch(component, /addEventListener|requestAnimationFrame|useState|useEffect/);
  assert.match(component, /globalMousePos=\{STILL_POINTER\}/);
  assert.match(component, /mouseOffset=\{STILL_POINTER\}/);
  assert.doesNotMatch(engine, /data-glass-reflecting|--glass-reflection-|REFLECTION_FRAME_MS/);
  assert.match(engine, /requestAnimationFrame\(draw\)/);
  assert.match(refraction, /supportsDetailedLiveRefraction/);
  assert.match(refraction, /supportsDetailedGlass/);
  assert.match(refraction, /connection\?\.saveData/);
  assert.doesNotMatch(css, /data-glass-reflecting|--glass-reflection-/);
  assert.match(css, /@supports not \(\(-webkit-backdrop-filter:/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\), \(prefers-reduced-motion: reduce\), \(prefers-reduced-transparency: reduce\)/);
});

test("high-detail SVG refraction remains opt-in on selected controls", () => {
  const home = read("app/page.tsx");
  const bell = read("components/account/NotificationBell.tsx");
  const inbox = read("components/account/NotificationInbox.tsx");
  const theme = read("components/ThemeToggle.tsx");

  // The dashboard-hero placement card this used to anchor on is gone — the
  // free Pro trial poster took over its slot (tests/free-pro-trial.test.mjs,
  // tests/dashboard-home.test.mjs) — so this now anchors on a skill card,
  // another still-selective use of the base non-interactive variant.
  assert.match(home, /dashboard-skill-card[\s\S]*?<RefractiveGlassLayer \/>/);
  assert.match(home, /btn-primary premade-glass[\s\S]*?<RefractiveGlassLayer radius=\{999\} interactive \/>/);
  assert.match(bell, /<RefractiveGlassLayer radius=\{999\} interactive \/>/);
  assert.match(inbox, /notification-popover liquid-glass/);
  assert.doesNotMatch(inbox, /notification-popover[^\n]*premade-glass/);
  assert.match(theme, /<RefractiveGlassLayer radius=\{14\} interactive \/>/);
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
  assert.match(header, /<RefractiveGlassLayer radius=\{0\} interactive \/>/);
  // The sheet itself carries no tint or refraction of its own — only the
  // .nav-menu-group cards it holds do, layering their own heavier blur and
  // colour on top. But it does carry a real, uniform blur so the gaps
  // between cards read as a soft glow, not legible page text just because
  // no card happens to cover that spot.
  assert.match(css, /\.nav-paper \{[^}]*background: transparent;/);
  assert.match(css, /\.nav-paper \{[^}]*backdrop-filter: blur\(28px\);/);
  // No inset highlight either — tuned for when this sheet carried real
  // visible material, it now reads as a stray grey line across the top of
  // the first row of cards.
  assert.doesNotMatch(css, /\.nav-paper \{[^}]*box-shadow:/);
  assert.match(css, /\.nav-paper > \.refractive-glass-layer \{[^}]*position: absolute;[^}]*inset: -1px/);
  assert.match(css, /\.nav-paper > \.refractive-glass-layer\[data-interactive\] > span \{[^}]*display: none !important/);
  assert.doesNotMatch(css, /\.nav-paper > \.refractive-glass-layer \{[^}]*position: fixed/);
  assert.match(css, /@supports not[\s\S]*\.nav-paper \{[\s\S]*background: var\(--color-background\)/);
});

test("navigation keeps its fixed glass surface, and grows outward from the button that opened it", () => {
  const css = read("app/globals.css");
  const header = read("components/SiteHeader.tsx");
  const panel = cssRule(css, ".nav-paper");

  assert.match(header, /className="nav-menu-group liquid-glass/);
  assert.match(header, /className="nav-paper premade-glass fixed inset-x-0 bottom-0 top-\[var\(--header-h\)\]/);
  assert.match(panel, /background: transparent;/);
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
  assert.match(css, /\.notification-popover \{[\s\S]*contain: paint;[\s\S]*clip-path: inset\(0 round var\(--radius-xl\)\)/);
  // Same barely-there, live-refracted material as the nav list, not the
  // heavier, more opaque frosted drawer this used to be.
  assert.match(css, /\.notification-popover \{[\s\S]*?background-color: color-mix\(in srgb, var\(--color-surface\) 9%, transparent\)[\s\S]*?blur\(2px\)/);
  assert.match(css, /\.notification-popover::before \{[\s\S]*?pointer-events: none;[\s\S]*?border-radius: inherit;[\s\S]*?inset 0 1px 0/);
  assert.match(css, /\.notification-popover > \* \{[\s\S]*?position: relative;[\s\S]*?z-index: 1/);
  // No more special-cased exclusion from the SVG lens: this popover now
  // gets exactly the generic .liquid-glass refraction treatment.
  assert.doesNotMatch(css, /html\[data-theme\]\[data-live-glass-refraction\] \.liquid-glass\.notification-popover/);
});
