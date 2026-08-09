/*
  Every paper on disk is reachable from the app.

  This is the check that was missing when listening-5 and listening-6 were
  written, validated, committed — and shown nowhere. An unused JSON import is
  not an error in any language, so nothing failed; the papers were simply
  invisible, and stayed that way until somebody counted.

  The registry cannot be trusted to police itself, so the comparison is against
  the directory: whatever is in data/ is what the app must offer.
*/
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { READING_TESTS, LISTENING_TESTS } = await import(
  pathToFileURL(join(process.cwd(), "lib", "tests.ts")).href
);

function onDisk(prefix) {
  return readdirSync(join(process.cwd(), "data"))
    .filter((f) => new RegExp(`^${prefix}-\\d+\\.json$`).test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

for (const [prefix, registry] of [
  ["reading", READING_TESTS],
  ["listening", LISTENING_TESTS],
]) {
  test(`every ${prefix} paper on disk is in the registry`, () => {
    const files = onDisk(prefix);
    const ids = registry.map((t) => t.id).sort();
    assert.ok(files.length > 0, `no ${prefix} papers found in data/`);
    assert.deepEqual(
      ids,
      files,
      `data/ has ${files.join(", ")} but lib/tests.ts offers ${ids.join(", ")}`,
    );
  });

  test(`${prefix} papers are offered easiest first`, () => {
    const rank = { easy: 0, medium: 1, hard: 2 };
    const seen = registry.map((t) => rank[t.difficulty] ?? 99);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        seen[i] >= seen[i - 1],
        `${registry[i].id} (${registry[i].difficulty}) comes after ${registry[i - 1].id} (${registry[i - 1].difficulty})`,
      );
    }
  });

  test(`${prefix} papers have unique ids and titles`, () => {
    const ids = registry.map((t) => t.id);
    const titles = registry.map((t) => t.title);
    assert.equal(new Set(ids).size, ids.length, "duplicate id");
    assert.equal(new Set(titles).size, titles.length, "duplicate title");
  });
}
