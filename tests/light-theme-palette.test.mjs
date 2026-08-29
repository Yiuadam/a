import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const theme = await readFile(new URL("../lib/theme.ts", import.meta.url), "utf8");

test("every theme keeps the learner canvas white while controls carry its accent", () => {
  const lightBlock = css.match(/html\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(lightBlock, /--color-surface:\s*#ffffff;/);
  assert.match(lightBlock, /--color-foreground:\s*#16171a;/);
  assert.match(lightBlock, /--color-indigo-600:\s*#c7ccd3;/);
  assert.match(lightBlock, /--color-accent-fg:\s*#26282d;/);
  assert.doesNotMatch(lightBlock, /#4f46e5|#4338ca/);
  assert.match(css, /White canvas themes/);
  assert.match(css, /html\[data-theme="light"\] \.card,[\s\S]*?background:\s*var\(--color-indigo-100\);/);
  assert.match(css, /html\[data-theme="light"\] a\.card\.card:hover,[\s\S]*?background:\s*var\(--color-indigo-200\);/);
  assert.match(css, /html\[data-theme="dark"\] \{[\s\S]*?--color-foreground:\s*#16171a;/);
  assert.match(css, /html\[data-theme="warm"\],[\s\S]*?--color-background:\s*#ffffff;/);
  assert.match(css, /\.btn-primary,[\s\S]*?background:\s*var\(--color-indigo-600\);/);
});

test("the Light theme describes its neutral interactive accent", () => {
  assert.match(theme, /White canvas with a light grey control accent/);
});

test("browser chrome stays white while the control theme changes", () => {
  assert.match(theme, /warm:\s*"#ffffff"/);
  assert.match(theme, /light:\s*"#ffffff"/);
  assert.match(theme, /dark:\s*"#ffffff"/);
  assert.match(theme, /m\.content="#ffffff"/);
});
