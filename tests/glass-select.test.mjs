import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function tsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

test("every BandUp choice list uses the shared floating glass control", () => {
  const roots = [join(process.cwd(), "app"), join(process.cwd(), "components")];
  const nativeSelects = roots.flatMap(tsxFiles).filter((path) => /<select\b/i.test(readFileSync(path, "utf8")));
  assert.deepEqual(nativeSelects, [], `Native selects bypass the floating glass list: ${nativeSelects.join(", ")}`);

  const shared = readFileSync(join(process.cwd(), "components", "GlassSelect.tsx"), "utf8");
  assert.match(shared, /createPortal/);
  assert.match(shared, /position: "fixed"/);
  assert.match(shared, /organization-picker-popover/);
  assert.match(shared, /role="listbox"/);
});
