import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");

test("the optional Geist Mono face is not preloaded on every route", () => {
  // Geist Mono remains available through its CSS variable, but most learner
  // pages never use it. Keep the root layout from injecting an unused font
  // preload, which browsers correctly flag in the console.
  assert.match(
    layout,
    /const geistMono = Geist_Mono\(\{[\s\S]*?variable:\s*["']--font-geist-mono["'][\s\S]*?preload:\s*false[\s\S]*?\}\);/,
  );
  assert.match(layout, /className=\{`\$\{geistSans\.variable\} \$\{geistMono\.variable\} h-full antialiased`\}/);
});
