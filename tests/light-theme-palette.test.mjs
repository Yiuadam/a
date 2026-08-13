import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const theme = await readFile(new URL("../lib/theme.ts", import.meta.url), "utf8");

test("the Light theme is neutral white rather than warm or tinted grey", () => {
  const lightBlock = css.match(/html\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(lightBlock, /--color-surface:\s*#ffffff;/);
  assert.match(lightBlock, /--color-background:\s*#fafafa;/);
  assert.match(lightBlock, /--color-foreground:\s*#16171a;/);
  assert.doesNotMatch(lightBlock, /#e8ebef|#f5f6f8|rgba\(92, 101, 121|rgba\(112, 126, 139/);
});

test("browser chrome follows the neutral Light page without a colour flash", () => {
  assert.match(theme, /light:\s*"#fafafa"/);
  assert.doesNotMatch(theme, /light:\s*"#e8ebef"/);
});
