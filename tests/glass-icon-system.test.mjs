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
  assert.match(css, /\.nav-paper \{[\s\S]*?color-background\) 9%, transparent\)[\s\S]*backdrop-filter: blur\(2px\)/);
  assert.match(css, /\.nav-paper > \.refractive-glass-layer \{[^}]*position: absolute;[^}]*inset: -1px/);
  assert.match(css, /\.nav-paper > \.refractive-glass-layer\[data-interactive\] > span \{[^}]*display: none !important/);
  assert.doesNotMatch(css, /\.nav-paper > \.refractive-glass-layer \{[^}]*position: fixed/);
  assert.match(css, /@supports not[\s\S]*\.nav-paper \{[\s\S]*background: var\(--color-background\)/);
});

test("navigation opens immediately without stagger while keeping its fixed glass surface", () => {
  const css = read("app/globals.css");
  const header = read("components/SiteHeader.tsx");
  const panel = cssRule(css, ".nav-paper");

  assert.match(header, /className="nav-menu-group liquid-glass/);
  assert.match(header, /className="nav-paper premade-glass fixed inset-x-0 bottom-0 top-\[var\(--header-h\)\]/);
  assert.match(panel, /backdrop-filter: blur\(2px\)/);
  assert.doesNotMatch(panel, /\banimation(?:-\w+)?:/);
  assert.doesNotMatch(css, /\.nav-menu-group\s*\{[^}]*\banimation(?:-\w+)?\s*:/);
  assert.doesNotMatch(header, /--nav-group-(?:delay|touch-delay|flow-x)/);
  assert.doesNotMatch(css, /@keyframes (?:glass-menu-open|nav-group-materialise|nav-group-touch-open)/);
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

  assert.match(popover, /className="notification-popover liquid-glass/);
  assert.doesNotMatch(popover, /RefractiveGlassLayer/);
  assert.doesNotMatch(popover, /premade-glass-content/);
  assert.match(css, /\.notification-popover \{[\s\S]*contain: paint;[\s\S]*clip-path: inset\(0 round var\(--radius-xl\)\)/);
  assert.match(css, /\.notification-popover \{[\s\S]*?background-color: color-mix\(in srgb, var\(--color-surface\) 68%, transparent\)[\s\S]*?blur\(36px\)/);
  assert.match(css, /\.notification-popover::before \{[\s\S]*?pointer-events: none;[\s\S]*?border-radius: inherit;[\s\S]*?inset 0 1px 0/);
  assert.match(css, /\.notification-popover > \* \{[\s\S]*?position: relative;[\s\S]*?z-index: 1/);
  assert.match(css, /html\[data-theme\]\[data-live-glass-refraction\] \.liquid-glass\.notification-popover \{[\s\S]*?blur\(36px\)[\s\S]*?url\("#bandup-live-glass-refraction"\)/);
});
