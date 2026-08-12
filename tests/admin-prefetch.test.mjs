import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const shell = readFileSync("components/admin/ConsoleShell.tsx", "utf8");
const header = readFileSync("components/SiteHeader.tsx", "utf8");
const footer = readFileSync("components/SiteFooter.tsx", "utf8");
const home = readFileSync("app/page.tsx", "utf8");
const intentLink = readFileSync("components/IntentPrefetchLink.tsx", "utf8");

test("admin navigation never preloads every console route together", () => {
  const nav = shell.match(/<nav[\s\S]*?<\/nav>/)?.[0];

  assert.ok(nav, "the admin navigation should exist");
  assert.match(
    nav,
    /href=\{item\.href\}[\s\S]*?prefetch=\{false\}/,
    "admin route links must wait for a click; preloading all of them can exhaust the Free Worker CPU budget",
  );
});

test("always-visible navigation does not create a Worker request burst", () => {
  for (const [name, source] of Object.entries({ shell, header, footer })) {
    const links = source.match(/<Link[\s\S]*?<\/Link>/g) ?? [];
    for (const link of links) {
      assert.match(
        link,
        /prefetch=\{false\}/,
        `${name} has an always-visible link that can preload a Worker route burst`,
      );
    }
  }
});

test("homepage preloads only after pointer, keyboard or touch intent", () => {
  assert.match(home, /IntentPrefetchLink/);
  assert.match(intentLink, /onPointerEnter/);
  assert.match(intentLink, /onFocus/);
  assert.match(intentLink, /onTouchStart/);
  assert.match(intentLink, /prefetch=\{false\}/);
});
