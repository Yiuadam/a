import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("the owner console uses the BandUp glass shell with one gated refractive layer", () => {
  const shell = read("components", "admin", "ConsoleShell.tsx");
  const layout = read("app", "admin", "layout.tsx");
  const styles = read("components", "admin", "AdminConsole.module.css");

  assert.match(layout, /styles\.canvas/);
  assert.match(shell, /styles\.sidebar/);
  assert.match(shell, /styles\.pageHeader/);
  assert.match(shell, /premade-glass/);
  assert.equal(shell.match(/<RefractiveGlassLayer\b/g)?.length, 1);
  assert.match(styles, /backdrop-filter: blur\(30px\)/);
  assert.match(styles, /var\(--color-indigo-600\)/);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/);
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
