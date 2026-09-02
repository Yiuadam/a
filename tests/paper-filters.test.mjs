/*
  The chooser's filter bar, against the content bank it filters.

  The failure this file exists for is a quiet one. A paper carries a word — its
  difficulty, or for writing its task type — and the bar offers a stop per
  word. Nothing anywhere makes the two agree: a paper authored as "Easy" with a
  capital, or an essay typed "problem-solution", still loads, still validates,
  still renders its card. It simply stops appearing under every stop but All,
  and no test that only reads the bank or only reads the component would
  notice, because each is fine on its own.

  So the assertions here are deliberately about the join. Every word in the
  bank has a stop, every stop has papers, and the vocabulary the component
  offers is the one the data was written against.
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

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const load = (name) => JSON.parse(read("data", name));

function papers(prefix) {
  return readdirSync(DATA)
    .filter((f) => new RegExp(`^${prefix}-\\d+\\.json$`).test(f))
    .sort();
}

/*
  The vocabularies, read out of the module that declares them rather than
  copied here. A copy would pass this whole file while the bar showed something
  else entirely, which is the one outcome it must not be possible to get.
*/
function vocabulary(name) {
  const source = read("lib", "paper-filters.ts");
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source);
  assert.ok(match, `lib/paper-filters.ts must export ${name} as a const array`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const DIFFICULTIES = vocabulary("DIFFICULTIES");
const WRITING_TASK_TYPES = vocabulary("WRITING_TASK_TYPES");

// ---- Reading and listening: every difficulty in the bank has a stop ----

test("every reading and listening paper's difficulty is a stop on the bar", () => {
  for (const prefix of ["reading", "listening"]) {
    for (const name of papers(prefix)) {
      const paper = load(name);
      assert.ok(
        DIFFICULTIES.includes(paper.difficulty),
        `${name} has difficulty ${JSON.stringify(paper.difficulty)}, which is not one of ` +
          `${DIFFICULTIES.join(", ")} — it would show under All and nowhere else`,
      );
    }
  }
});

/*
  And the other way round, because a stop nobody can reach is dead interface: a
  learner reads "Easy 0", taps it to check, and gets a sentence saying there is
  nothing there. If the bank genuinely loses its last easy paper this test is
  how that gets noticed, and the fix is a decision about the bar rather than a
  line to delete.
*/
test("every difficulty stop has papers behind it", () => {
  for (const prefix of ["reading", "listening"]) {
    const found = new Set(papers(prefix).map((name) => load(name).difficulty));
    for (const difficulty of DIFFICULTIES) {
      assert.ok(found.has(difficulty), `no ${prefix} paper is ${difficulty}`);
    }
  }
});

// ---- Writing: the same join, on the authored task type ----

test("every writing task's type is a stop on the bar", () => {
  const { tasks } = load("writing-tasks.json");
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.ok(
      WRITING_TASK_TYPES.includes(task.type),
      `${task.id} has type ${JSON.stringify(task.type)}, which is not one of ` +
        `${WRITING_TASK_TYPES.join(", ")}`,
    );
  }
});

test("every writing task type stop has tasks behind it", () => {
  const { tasks } = load("writing-tasks.json");
  const found = new Set(tasks.map((task) => task.type));
  for (const type of WRITING_TASK_TYPES) {
    assert.ok(found.has(type), `no writing task is typed ${type}`);
  }
});

/*
  The type is meant to describe the task, not to be an independent opinion
  about it. Reading it back off the content is what keeps the bar honest when
  somebody edits a prompt: a Task 1 that gains a chart and keeps the type
  "letter" is filed under a word that is now wrong.
*/
test("every writing task's type matches the content it actually carries", () => {
  const { tasks } = load("writing-tasks.json");
  for (const task of tasks) {
    const expected = task.task === 2
      ? "essay"
      : task.dataTable
        ? "table"
        : task.chart
          ? "chart"
          : task.variant === "general"
            ? "letter"
            : null;
    assert.notEqual(expected, null, `${task.id} carries nothing to type it by`);
    assert.equal(task.type, expected, `${task.id} is typed ${task.type} but reads as a ${expected}`);
  }
});

// ---- The validator enforces the writing type at build time ----

function runValidator(cwd) {
  return spawnSync(process.execPath, [join(process.cwd(), "scripts", "validate-content.mjs")], {
    cwd,
    encoding: "utf8",
  });
}

/*
  Copies data/ into a scratch cwd so one task can be broken without touching
  the real bank, then points the validator at that cwd — it always resolves
  `data/` from process.cwd().
*/
function withBrokenWritingTask(mutate, run) {
  const scratch = mkdtempSync(join(tmpdir(), "bandup-paper-filters-"));
  const scratchData = join(scratch, "data");
  mkdirSync(scratchData);
  for (const name of readdirSync(DATA)) {
    copyFileSync(join(DATA, name), join(scratchData, name));
  }
  const target = join(scratchData, "writing-tasks.json");
  const bank = JSON.parse(readFileSync(target, "utf8"));
  mutate(bank.tasks);
  writeFileSync(target, JSON.stringify(bank, null, 2));
  try {
    return run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the validator rejects a writing task with no type", () => {
  const result = withBrokenWritingTask((tasks) => {
    delete tasks[0].type;
  }, runValidator);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown task type/);
});

test("the validator rejects a writing task with a type outside the set", () => {
  const result = withBrokenWritingTask((tasks) => {
    tasks[0].type = "graph";
  }, runValidator);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown task type: graph/);
});

test("the validator rejects a writing task whose type contradicts its content", () => {
  const result = withBrokenWritingTask((tasks) => {
    const essay = tasks.find((task) => task.task === 2);
    essay.type = "letter";
  }, runValidator);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is typed "letter" but its content is a essay/);
});

// ---- The bar is actually on the chooser, and starts on All ----

test("the chooser renders the filter bar above the paper grid", () => {
  const source = read("components", "TestChooser.tsx");
  const barAt = source.indexOf("<PaperFilter");
  assert.notEqual(barAt, -1, "TestChooser must render the filter bar");
  const gridAt = source.indexOf("practice-paper-grid");
  assert.notEqual(gridAt, -1);
  assert.ok(barAt < gridAt, "the bar belongs above the list it narrows");
});

test("the filter starts on All, and All is a stop of its own", () => {
  const source = read("components", "TestChooser.tsx");
  assert.match(
    source,
    /useState\("all"\)/,
    "the chooser must open unfiltered — a filter nobody asked for hides papers",
  );
  assert.match(source, /\{ id: "all", label: "All", count: all\.length \}/);
});

/*
  Narrowing the list must not renumber it. Both the padlock and the
  "AI-generated" badge are decided by a paper's position in the full library,
  so a filtered view that indexed its own rows would hand a visitor whichever
  paper happened to come first under the stop they tapped.
*/
test("the padlock is decided by position in the whole library, not the filtered view", () => {
  const source = read("components", "TestChooser.tsx");
  assert.match(
    source,
    /const entries = all\.map\(\(paper, index\) => \(\{ paper, index \}\)\);/,
    "positions must be taken from the unfiltered library",
  );
  assert.match(source, /shown\.map\(\(\{ paper: t, index: i \}\) =>/);
  // And the two rules still read that position rather than a fresh count.
  assert.match(source, /const isGenerated = i >= tests\.length;/);
  assert.match(source, /const beyond = limit !== null && i >= limit;/);
});

test("an empty stop explains itself instead of showing a blank list", () => {
  const source = read("components", "TestChooser.tsx");
  assert.match(source, /shown\.length === 0 && \(/);
  assert.match(source, /data-paper-filter-empty/);
});

/*
  One vocabulary, not two. lib/tests.ts sorts the papers easiest first and used
  to keep its own copy of the three words; if that copy and the bar's ever
  disagreed, a paper could sort under a heading the bar cannot show.
*/
test("the paper order and the filter bar read the same difficulty list", () => {
  const source = read("lib", "tests.ts");
  assert.match(source, /import \{ DIFFICULTIES \} from "@\/lib\/paper-filters";/);
  assert.doesNotMatch(
    source,
    /DIFFICULTY_ORDER = \[/,
    "lib/tests.ts must not keep a second copy of the difficulty words",
  );
});
