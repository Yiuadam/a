import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile("components/TestChooser.tsx", "utf8");

test("reading and listening paper libraries scroll inside the locked viewport", () => {
  assert.match(source, /data-paper-chooser/);
  assert.match(source, /h-full[^\"]*overflow-y-auto/);
});
