/*
  CEFR levels for practice content.

  Reading and listening papers, writing tasks and speaking topics carry a
  `level` alongside their existing `difficulty` — the same six-point scale
  data/placement.json already grades every placement question by. This file
  checks three things: every shipped content item has a valid level, the
  validator actually rejects one that is missing or bogus, and the card that
  shows a learner a paper's difficulty shows the CEFR code beside it.
*/
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DATA = join(process.cwd(), "data");
const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const load = (name) => JSON.parse(read("data", name));

function papers(prefix) {
  return readdirSync(DATA)
    .filter((f) => new RegExp(`^${prefix}-\\d+\\.json$`).test(f))
    .sort();
}

// ---- Every shipped item has a valid level ----

test("every reading and listening paper has a valid CEFR level", () => {
  for (const prefix of ["reading", "listening"]) {
    for (const name of papers(prefix)) {
      const paper = load(name);
      assert.ok(
        CEFR_LEVELS.includes(paper.level),
        `${name} has level ${paper.level}, not one of ${CEFR_LEVELS.join(", ")}`,
      );
      // The backfill is meant to be an honest judgement, not a rename of
      // difficulty — so at minimum both fields have to be present and distinct
      // in kind, not the same string doing double duty.
      assert.ok(typeof paper.difficulty === "string" && paper.difficulty.length > 0);
    }
  }
});

test("every writing task has a valid CEFR level", () => {
  const { tasks } = load("writing-tasks.json");
  assert.ok(tasks.length > 0);
  for (const t of tasks) {
    assert.ok(
      CEFR_LEVELS.includes(t.level),
      `${t.id} has level ${t.level}, not one of ${CEFR_LEVELS.join(", ")}`,
    );
  }
});

test("every speaking topic has a valid CEFR level", () => {
  const speaking = load("speaking-topics.json");
  for (const part of ["part1", "part2", "part3"]) {
    for (const item of speaking[part]) {
      assert.ok(
        CEFR_LEVELS.includes(item.level),
        `speaking ${part} topic "${item.topic}" has level ${item.level}`,
      );
    }
  }
});

// ---- The validator actually enforces this ----

function runValidator(cwd) {
  return spawnSync(process.execPath, [join(process.cwd(), "scripts", "validate-content.mjs")], {
    cwd,
    encoding: "utf8",
  });
}

test("the real content bank passes the validator", () => {
  const result = runValidator(process.cwd());
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

/*
  Copies the whole data/ directory into a scratch cwd so a single file can be
  broken without touching the real content bank, then points the validator at
  that scratch cwd — the script always resolves `data/` from process.cwd().
*/
function withBrokenReadingLevel(mutate, run) {
  const scratch = mkdtempSync(join(tmpdir(), "bandup-content-levels-"));
  const scratchData = join(scratch, "data");
  mkdirSync(scratchData);
  for (const name of readdirSync(DATA)) {
    copyFileSync(join(DATA, name), join(scratchData, name));
  }
  const target = join(scratchData, "reading-1.json");
  const paper = JSON.parse(readFileSync(target, "utf8"));
  mutate(paper);
  writeFileSync(target, JSON.stringify(paper, null, 2));
  try {
    return run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the validator rejects a paper with no level", () => {
  const result = withBrokenReadingLevel((paper) => {
    delete paper.level;
  }, runValidator);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown CEFR level/);
});

test("the validator rejects a paper with a bogus level", () => {
  const result = withBrokenReadingLevel((paper) => {
    paper.level = "Z9";
  }, runValidator);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown CEFR level: Z9/);
});

// ---- The card renders both ----

test("TestChooser shows the CEFR level ungarbled beside the difficulty", () => {
  const source = read("components", "TestChooser.tsx");
  const levelAt = source.indexOf("objectiveTest?.level");
  assert.notEqual(levelAt, -1, "TestChooser must render objectiveTest?.level");
  const difficultyAt = source.indexOf("objectiveTest?.difficulty");
  assert.notEqual(difficultyAt, -1);
  // Level reads first, because it is the scale the placement result already
  // speaks — the difficulty word is the secondary, familiar label.
  assert.ok(levelAt < difficultyAt, "the CEFR level must come before the difficulty word");

  // The span carrying the level must not sit inside a `capitalize` class —
  // CSS text-transform would turn "B1" into "B1" visually undamaged only by
  // accident; the point is that a CEFR code has no case to transform, and a
  // capitalize rule applied to it is a bug waiting for a level like "a1".
  const lineStart = source.lastIndexOf("\n", levelAt);
  const lineEnd = source.indexOf("\n", levelAt);
  const line = source.slice(lineStart, lineEnd);
  assert.doesNotMatch(line, /capitalize/, "the level span must not be CSS-capitalized");
});

test("the practice hub card shows the CEFR level ungarbled beside the difficulty", () => {
  const source = read("app", "practice", "page.tsx");
  const levelAt = source.indexOf("{t.level}");
  assert.notEqual(levelAt, -1, "the practice hub card must render {t.level}");
  const difficultyAt = source.indexOf("{t.difficulty}");
  assert.notEqual(difficultyAt, -1);
  assert.ok(levelAt < difficultyAt, "the CEFR level must come before the difficulty word");

  const lineStart = source.lastIndexOf("\n", levelAt);
  const lineEnd = source.indexOf("\n", levelAt);
  const line = source.slice(lineStart, lineEnd);
  assert.doesNotMatch(line, /capitalize/, "the level span must not be CSS-capitalized");
});
