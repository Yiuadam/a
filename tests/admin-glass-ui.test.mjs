import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("the owner console uses the BandUp glass shell, frosted rather than refracting", () => {
  const shell = read("components", "admin", "ConsoleShell.tsx");
  const layout = read("app", "admin", "layout.tsx");
  const styles = read("components", "admin", "AdminConsole.module.css");

  assert.match(layout, /styles\.canvas/);
  assert.match(shell, /styles\.sidebar/);
  assert.match(shell, /styles\.pageHeader/);
  assert.match(shell, /premade-glass/);
  /* The sidebar had one displacement layer, and it is not coming back: the
     owner rejected refraction across the site on look rather than on cost,
     asking for glass that is transparent instead of foggy. `premade-glass`
     above and the blur below are the whole of the material now. */
  assert.doesNotMatch(shell, /RefractiveGlassLayer/);
  assert.match(styles, /backdrop-filter: blur\(30px\)/);
  assert.match(styles, /var\(--color-indigo-600\)/);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/);
});

test("the owner console uses the complete canonical BandUp mark, not its orange rear layer", () => {
  const shell = read("components", "admin", "ConsoleShell.tsx");

  assert.match(shell, /src="\/icons\/final\/steps-five-mark\.svg"/);
  assert.match(shell, /sizes="38px"/);
  assert.match(shell, /unoptimized/);
  assert.doesNotMatch(shell, /steps-five-layer-rear-108\.png/);
});

test("admin controls and data surfaces share capsules and scoped glass", () => {
  const styles = read("components", "admin", "AdminConsole.module.css");
  const cards = read("components", "admin", "StatCard.tsx");
  const finance = read("app", "admin", "finance", "page.tsx");

  assert.match(styles, /:global\(\.btn-primary\)/);
  assert.match(styles, /border-radius: 999px/);
  assert.match(styles, /:global\(\.rounded-2xl\.border\.border-slate-200\)/);
  assert.match(cards, /className="card /);
  assert.match(finance, /active \? "bg-indigo-600 text-white/);
});

test("the user directory has a phone card view and a wide table view", () => {
  const users = read("app", "admin", "users", "page.tsx");

  assert.match(users, /className="grid gap-2 sm:hidden"/);
  assert.match(users, /className="card hidden overflow-x-auto[^\"]*sm:block"/);
  assert.match(users, /Open history/);
});

test("admin charts use the indigo glass visual system", () => {
  const traffic = read("components", "admin", "AdminTrendChart.module.css");
  const finance = read("components", "admin", "FinanceTrendChart.module.css");

  for (const styles of [traffic, finance]) {
    assert.match(styles, /var\(--color-indigo-500\)/);
    assert.match(styles, /var\(--glass-fill-strong\)/);
    assert.match(styles, /var\(--radius-2xl\)/);
    assert.match(styles, /prefers-reduced-transparency/);
  }
});

/*
  The console still gets the native app's own top clearance.

  Reported as "the top of the site setting is being cut" — and it was: on the
  iOS app the header bar is a real UIGlassEffect view floating above the
  WKWebView, not DOM, so every page needs a spacer of its own height reserved
  in the page's own flow or the bar sits over whatever draws first. SiteHeader
  is that spacer everywhere it renders (the invisible div keyed off
  `nativeChromeHeight`, components/SiteHeader.tsx) — except the console, which
  used to return null before ever reaching that branch. The bar still floated;
  only the reservation was missing.

  `enableNativeChrome` runs from an effect declared above every return in the
  component, so it always measures the bar and always sets `--header-h` —
  including on /admin — regardless of what gets rendered. The bug was never in
  the measurement, only in the console skipping the one render branch that
  used it. So the fix is source order: the console's own early return has to
  come panel to panel with, and after, the spacer branch — never in front of
  it — or a future edit could put the early return back above it without
  anyone noticing until the next screenshot.
*/
test("the console reserves the native bar's height instead of rendering under it", () => {
  const header = read("components", "SiteHeader.tsx");

  // The console's own opt-out is now conditioned on there being no bar to miss.
  assert.match(header, /if \(onConsole && nativeChromeHeight === null\) return null;/);

  // And the spacer that reserves the bar's real height still exists, and the
  // console's guard sits before it in source order rather than after.
  const consoleGuard = header.indexOf("if (onConsole && nativeChromeHeight === null) return null;");
  const spacer = header.indexOf("style={{ height: nativeChromeHeight }}");
  assert.ok(consoleGuard > -1 && spacer > -1, "both the guard and the spacer must exist");
  assert.ok(
    consoleGuard < spacer,
    "the console's early return must come before the native spacer branch, so /admin can still reach it",
  );
});

/*
  The admin overview's own rows, shorter — not every row everywhere.

  HubMenu is shared with /account and /billing, which each show one screen's
  worth of choice at a time and can afford the taller default target. Admin's
  overview is the one screen carrying four stat cards and five menu rows at
  once, which is what "make every button slightly shorter to fit" was asked
  about — so the shrink is a `compact` prop this page opts into, not a change
  to the shared default the other two pages were never reported as broken.
*/
test("the admin overview asks HubMenu for its compact rows, and the shared default is unchanged", () => {
  const overview = read("app", "admin", "page.tsx");
  const hub = read("components", "HubMenu.tsx");

  assert.match(overview, /<HubMenu items={menu} compact \/>/);
  assert.match(hub, /compact = false/);
  assert.match(hub, /min-h-\[6\.25rem\]/);
  assert.match(hub, /min-h-\[4\.75rem\]/);

  const account = read("components", "AccountPanel.tsx");
  assert.doesNotMatch(account, /<HubMenu[^>]*compact/);
});
