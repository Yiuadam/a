import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/practice/page.tsx", import.meta.url), "utf8");

test("practice introduction is one six-word sentence", () => {
  assert.match(source, /Real exam format, with band scores\./);
  assert.doesNotMatch(source, /Tests in the same format as the real exam/);
});

test("skill destinations have comfortable compact responsive buttons", () => {
  assert.match(source, /grid grid-cols-2 gap-2 sm:grid-cols-4/);
  assert.match(source, /!min-h-12 !px-4 text-center !text-xs sm:!px-5/);
});
