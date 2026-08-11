/*
  Which navigation row is marked as the current page.

  This exists because of a bug visible in a screenshot and in nothing else. The
  first version of the menu asked `pathname.startsWith(href)` per row, which is
  right for nested routes — /practice/reading should mark "Reading" — and wrong
  the moment two rows are nested inside each other. On /practice/reading both
  "Reading" and "All practice tests" lit up, because /practice is a prefix of
  /practice/reading. Two rows claiming to be the page you are on is worse than
  none: it makes the marker mean nothing.

  Nothing threw, no type caught it, and the build was green. The only signal
  was two highlighted rows in a screenshot.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { currentHref, NAV_GROUPS, PRIMARY } = await import(
  pathToFileURL(join(process.cwd(), "lib", "nav.ts")).href
);

test("a nested route marks the nested row, not its parent", () => {
  assert.equal(currentHref("/practice/reading"), "/practice/reading");
  assert.equal(currentHref("/practice/listening"), "/practice/listening");
  assert.equal(currentHref("/practice/writing"), "/practice/writing");
});

test("the parent row is marked on the parent route itself", () => {
  assert.equal(currentHref("/practice"), "/practice");
});

test("Home is marked only on Home", () => {
  assert.equal(currentHref("/"), "/");
  for (const path of ["/plan", "/history", "/practice", "/speaking", "/chat"]) {
    assert.notEqual(currentHref(path), "/", `Home was marked on ${path}`);
  }
});

test("a route below a destination still marks that destination", () => {
  assert.equal(currentHref("/speaking/part-2"), "/speaking");
});

test("an unknown route marks nothing", () => {
  assert.equal(currentHref("/nowhere"), null);
});

test("a path that merely shares a prefix is not a match", () => {
  // /planner is not /plan, however much it looks like it.
  assert.notEqual(currentHref("/planner"), "/plan");
});

test("exactly one row can ever be marked", () => {
  const paths = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
  for (const path of [...paths, "/practice/reading", "/speaking/part-2", "/nowhere"]) {
    const hit = currentHref(path);
    const matches = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.href === hit);
    assert.ok(matches.length <= 1, `${path} matched ${matches.length} rows`);
  }
});

/*
  The header row is capped at five deliberately. Nine destinations needed 706px
  in a header that had 578px, and the overflow was painted over the account
  button at every width. If this fails, the fix is to move something into the
  menu — not to raise the number.
*/
test("the header row stays at five destinations", () => {
  assert.equal(PRIMARY.length, 5, "the header row is sized for five; see lib/nav.ts");
});

test("every header destination is also reachable from the menu", () => {
  const inMenu = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
  for (const item of PRIMARY) {
    assert.ok(inMenu.has(item.href), `${item.href} is in the header but not the menu`);
  }
});

test("no destination is listed twice within one group", () => {
  for (const group of NAV_GROUPS) {
    const hrefs = group.items.map((i) => i.href);
    assert.equal(new Set(hrefs).size, hrefs.length, `${group.title} repeats a destination`);
  }
});

test("the founder and product page uses the clear About BandUp name", () => {
  const items = NAV_GROUPS.flatMap((group) => group.items);
  assert.deepEqual(
    items.find((item) => item.href === "/about"),
    { href: "/about", label: "About BandUp" },
  );
  assert.equal(items.some((item) => item.href === "/credits"), false);
});
