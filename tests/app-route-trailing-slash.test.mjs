/*
  The route names the app compares against, compared the way the app sees them.

  next.config.ts sets `trailingSlash: true` for the static export the iOS app
  ships, because a bundle served off the filesystem inside a WebView resolves a
  page by asking a directory for its index.html. The consequence nobody sees on
  a laptop is that `usePathname()` answers "/practice/writing/" in the app and
  "/practice/writing" on the website, so every `pathname === "/practice/writing"`
  is quietly false on exactly one of the two platforms.

  Nothing threw. Both builds compiled, every test passed, and the website was
  correct at every route. The only signal was an owner on a real iPhone saying
  the writing exam scrolled with the site's footer under it — the viewport lock
  in AppMain and the hide list in SiteFooter both name that route, and in the
  app neither name ever matched.

  So this feeds the app's own form of every route to everything that compares
  one, and it reads the route names out of the components rather than repeating
  them, because a copy of the list here would go stale the first time a page is
  added and would then be testing nothing.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const load = (...parts) => import(pathToFileURL(join(root, ...parts)).href);

const { routePath } = await load("lib", "platform.ts");
const { currentHref, NAV_GROUPS, PRIMARY } = await load("lib", "nav.ts");
const { safeAuthReturnPath } = await load("lib", "auth", "return-path.ts");

/** The pathname the iOS export produces for a route the website writes bare. */
const asApp = (path) => (path === "/" ? "/" : `${path}/`);

test("the normaliser turns the app's pathname into the website's, and leaves the website's alone", () => {
  assert.equal(routePath("/practice/writing/"), "/practice/writing");
  assert.equal(routePath("/practice/writing"), "/practice/writing");
  assert.equal(routePath("/account/profile/"), "/account/profile");
});

test("the root survives, because \"\" is not a route and matches nothing", () => {
  assert.equal(routePath("/"), "/");
  assert.notEqual(routePath("/"), "");
});

/*
  The five components that decide something by naming a route. Their conditions
  cannot be imported — they are .tsx and they are hooks — so the route names are
  read straight out of the source and checked against the normaliser, and the
  source is checked for reading its pathname through the normaliser at all.
  Both halves are needed: the first proves every name survives the round trip,
  the second proves the round trip actually happens.
*/
const ROUTE_COMPARERS = [
  ["components", "AppMain.tsx"],
  ["components", "SiteFooter.tsx"],
  ["components", "SiteHeader.tsx"],
  ["components", "NavLinks.tsx"],
  ["components", "MaintenanceGate.tsx"],
];

/** Comments stripped, so a route named in prose is not mistaken for a comparison. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("every route a component names is still matched when the app adds its slash", () => {
  let checked = 0;
  for (const parts of ROUTE_COMPARERS) {
    const source = code(read(...parts));
    for (const [, route] of source.matchAll(/pathname === "(\/[^"]*)"/g)) {
      assert.equal(
        routePath(asApp(route)),
        route,
        `${parts.join("/")} compares against ${route}, which the app's ${asApp(route)} does not reach`,
      );
      checked += 1;
    }
  }
  // If this ever reads zero the loop above is passing by finding nothing.
  assert.ok(checked >= 15, `expected the sweep to find the route comparisons, found ${checked}`);
});

test("no component reads the raw pathname to compare a route with", () => {
  for (const parts of ROUTE_COMPARERS) {
    const source = code(read(...parts));
    assert.match(
      source,
      /const pathname = useRoutePath\(\)/,
      `${parts.join("/")} must take its route from useRoutePath`,
    );
    assert.doesNotMatch(
      source,
      /usePathname\(\)/,
      `${parts.join("/")} still reads usePathname directly, which carries the app's trailing slash`,
    );
  }
});

/*
  SiteFooter decides two more things by exact name — which pages introduce the
  product and which already say it themselves — and those are list lookups
  rather than comparisons, so the sweep above does not see them.
*/
test("the footer's two route lists are looked up with the normalised route", () => {
  const source = code(read("components", "SiteFooter.tsx"));
  assert.match(source, /INTRODUCES_ITSELF\.includes\(pathname\)/);
  assert.match(source, /SAYS_IT_ITSELF\.includes\(pathname\)/);
});

test("the navigation marks the same row whichever form of the route it is given", () => {
  const hrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
  for (const href of [...hrefs, ...PRIMARY.map((item) => item.href), "/speaking/part-2"]) {
    assert.equal(
      currentHref(asApp(href)),
      currentHref(href),
      `${asApp(href)} and ${href} mark different rows`,
    );
  }
});

test("Home is still marked only on Home when every route carries a slash", () => {
  assert.equal(currentHref("/"), "/");
  for (const path of ["/plan", "/history", "/practice", "/speaking", "/chat"]) {
    assert.notEqual(currentHref(asApp(path)), "/", `Home was marked on ${asApp(path)}`);
  }
});

/*
  The return path is the one place where normalising the wrong thing would be
  worse than not normalising at all: it is a destination, and in the app the
  slashed form is the one the export can open. So the checks read the route and
  the stored value keeps its slash.
*/
const INVITE = "?request=8f14e45f-ea0b-4c5f-9b31-2a7c1d3e4f50#token=abcdefghijklmnopqrstuvwxyz";

test("the app's own invitation gets the strict check, not the general one", () => {
  assert.equal(safeAuthReturnPath(`/organization/invite${INVITE}`), true);
  assert.equal(safeAuthReturnPath(`/organization/invite/${INVITE}`), true);
  // Strict means strict in both forms: a token too short to be genuine is
  // refused whichever build produced the path.
  assert.equal(safeAuthReturnPath("/organization/invite?request=nope#token=short"), false);
  assert.equal(safeAuthReturnPath("/organization/invite/?request=nope#token=short"), false);
});

test("an ordinary in-app path is accepted in either form, and an outside one in neither", () => {
  for (const path of ["/", "/pricing", "/practice/writing", "/practice/writing/", "/plan/"]) {
    assert.equal(safeAuthReturnPath(path), true, `${path} should be an acceptable return path`);
  }
  for (const path of ["//evil.example/", "//evil.example/?", "https://evil.example/", "/\\evil.example/"]) {
    assert.equal(safeAuthReturnPath(path), false, `${path} should never be an acceptable return path`);
  }
});

/*
  The trailing slash is a property of the mobile build's config, not a fact
  anybody would think to check. If it is ever turned off this whole file is
  answering a question nobody is asking any more, and the comment above every
  routePath call would be describing a build that no longer exists.
*/
test("the static export still asks for directory-style URLs", () => {
  const source = read("next.config.ts");
  assert.match(source, /trailingSlash: true/);
});
