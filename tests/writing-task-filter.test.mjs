/*
  Writing's and reading's filter bars, against the content bank each filters —
  and a guard that difficulty's is actually gone.

  This file used to be tests/paper-filters.test.mjs and covered three bars:
  difficulty on reading and listening, task type on writing. The owner's
  instruction was blunt — difficulty is an estimate, not a promise, and it
  must stop being a thing a learner can filter or choose anywhere in the
  product — so two of those three bars are deleted rather than adjusted, and
  the tests that pinned them go with them rather than being weakened to pass.

  What was left, for a while, was writing's bar alone, keyed on `task` (1 or
  2) instead of `type` (chart, table, letter, essay). `task` is a real,
  authored property — it is how IELTS itself divides its own writing paper —
  so the failure mode the old file worried about barely applies: there is no
  vocabulary a task could misspell its way out of, because
  scripts/validate-content.mjs already rejects a task number that is not 1 or
  2 before this file ever runs.

  Reading has since grown a bar of its own, on the strength of the same
  argument: `ReadingTest.variant` is a real, authored property too — it is how
  IELTS itself divides its own reading paper — checked by
  scripts/validate-content.mjs simply by being unable to compile without it
  (lib/types.ts makes it required, not optional). It is deliberately not the
  same bar writing uses, and not merely restyled: Task 1 and Task 2 are two
  slices of one paper a candidate reads either way, so "All" is a real third
  stop; Academic and General Training are two different exams, so a bar with
  an "All" that interleaved them would recreate exactly the "wade through
  papers meant for the other exam" the owner's brief for this feature ruled
  out. See ReadingVariantFilter in components/TestChooser.tsx.

  What the join tests below still earn their keep on is the same thing they
  always did — a stop with nothing behind it is dead interface, and only the
  bank knows if that has happened.
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

// ---- Difficulty's filter is gone, not just unused ----

test("the difficulty filter model has been deleted, not merely stopped", () => {
  assert.throws(() => read("lib", "paper-filters.ts"), /ENOENT/);

  // Nothing left in the app should still reach for the module that used to
  // hold it — an orphaned import would be a build error today, but this is
  // the assertion that says why one can never reappear quietly: there is
  // nothing at that path to import.
  for (const file of [
    join("lib", "tests.ts"),
    join("lib", "types.ts"),
    join("components", "TestChooser.tsx"),
  ]) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /paper-filters/,
      `${file} must not reference the deleted filter model`,
    );
  }
});

test("listening renders no filter bar at all", () => {
  const source = read("components", "TestChooser.tsx");
  // Writing's bar is written once, guarded on kind === "writing"; reading's
  // once, guarded on kind === "reading" — and neither is written a second
  // time, disabled or hidden, standing by for listening, which alone still
  // has nothing left to narrow by.
  assert.match(
    source,
    /\{kind === "writing" && \(\s*<WritingTaskFilter/,
    "the writing bar must be reachable only when kind is writing",
  );
  assert.equal(
    (source.match(/<WritingTaskFilter/g) ?? []).length,
    1,
    "there must be exactly one writing filter bar in the component",
  );
  assert.match(
    source,
    /\{kind === "reading" && \(\s*<ReadingVariantFilter/,
    "the reading bar must be reachable only when kind is reading",
  );
  assert.equal(
    (source.match(/<ReadingVariantFilter/g) ?? []).length,
    1,
    "there must be exactly one reading filter bar in the component",
  );
});

// ---- Reading: the join, on the authored variant ----

test("every reading paper carries a real variant", () => {
  const files = readdirSync(DATA).filter((f) => /^reading-\d+\.json$/.test(f));
  for (const file of files) {
    const paper = load(file);
    assert.ok(
      paper.variant === "academic" || paper.variant === "general",
      `${file} has variant ${JSON.stringify(paper.variant)}, which is neither "academic" nor "general"`,
    );
  }
});

/*
  And the other way round: a stop nobody can reach is dead interface. Unlike
  writing's two stops, these are not merely worth noticing if the bank drains
  — an empty General Training stop would leave the whole point of this
  feature unreachable from the one screen a learner is told to look for it.
*/
test("both reading variants have papers behind them", () => {
  const files = readdirSync(DATA).filter((f) => /^reading-\d+\.json$/.test(f));
  const found = new Set(files.map((f) => load(f).variant));
  for (const variant of ["academic", "general"]) {
    assert.ok(found.has(variant), `no reading paper has variant "${variant}"`);
  }
});

test("the chooser renders the reading filter bar above the paper grid", () => {
  const source = read("components", "TestChooser.tsx");
  const barAt = source.indexOf("<ReadingVariantFilter");
  assert.notEqual(barAt, -1, "TestChooser must render the reading filter bar");
  const gridAt = source.indexOf("practice-paper-grid");
  assert.notEqual(gridAt, -1);
  assert.ok(barAt < gridAt, "the bar belongs above the list it narrows");
});

test("the reading filter starts on Academic, and has no All stop to fall back to", () => {
  const source = read("components", "TestChooser.tsx");
  assert.match(
    source,
    /useState<ReadingTest\["variant"\]>\("academic"\)/,
    'the chooser must open on Academic — a General Training learner opting in is the point, not a surprise',
  );
  // Unlike writing's bar, whose options are `[{ id: "all", ... }, ...writingTaskOptions]`,
  // the reading bar is handed its options with nothing prepended — see the
  // header comment on this file for why there is deliberately no All stop to
  // interleave the two exams under.
  assert.match(
    source,
    /<ReadingVariantFilter\s+options=\{readingVariantOptions\}/,
    "the reading bar must be handed its options with no All stop added in front",
  );
});

test("no paper anywhere still carries a rendered difficulty word", () => {
  // The two cards that used to print "Easy" / "Medium" / "Hard" next to the
  // CEFR level. Both are gone; neither is worth a difficulty label a learner
  // could mistake for a fact.
  const chooser = read("components", "TestChooser.tsx");
  assert.doesNotMatch(chooser, /objectiveTest\?\.difficulty/);
  const hub = read("app", "practice", "page.tsx");
  assert.doesNotMatch(hub, /\{t\.difficulty\}/);
});

// ---- Writing: the join, on the authored task number ----

test("every writing task carries a real task number", () => {
  const { tasks } = load("writing-tasks.json");
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.ok(
      task.task === 1 || task.task === 2,
      `${task.id} has task ${JSON.stringify(task.task)}, which is neither 1 nor 2`,
    );
  }
});

/*
  And the other way round, because a stop nobody can reach is dead interface: a
  learner reads "Task 2 0", taps it to check, and gets a sentence saying there
  is nothing there. If the bank genuinely loses every Task 2 this test is how
  that gets noticed, and the fix is a decision about the bar rather than a
  line to delete.
*/
test("both task stops have tasks behind them", () => {
  const { tasks } = load("writing-tasks.json");
  const found = new Set(tasks.map((task) => task.task));
  for (const taskNumber of [1, 2]) {
    assert.ok(found.has(taskNumber), `no writing task is Task ${taskNumber}`);
  }
});

// ---- Writing: the type field is still real, still checked, no longer a filter ----

/*
  The type is meant to describe the task, not to be an independent opinion
  about it. Reading it back off the content is what keeps it honest when
  somebody edits a prompt: a Task 1 that gains a chart and keeps the type
  "letter" is filed under a word that is now wrong — even though nothing in
  the interface reads that word any more.
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
          /* A pair of plans of the same site: the third thing Academic Task 1
             asks for, after a chart and a table. */
          : task.plans
            ? "plan"
            : task.process
              ? "process"
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
  const scratch = mkdtempSync(join(tmpdir(), "bandup-writing-task-filter-"));
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

test("the validator rejects a writing task with an invalid task number", () => {
  const result = withBrokenWritingTask((tasks) => {
    tasks[0].task = 3;
  }, runValidator);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid task number/);
});

// ---- The bar is actually on the chooser, and starts on All ----

test("the chooser renders the filter bar above the paper grid", () => {
  const source = read("components", "TestChooser.tsx");
  const barAt = source.indexOf("<WritingTaskFilter");
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
  paper happened to come first under the stop they tapped. This is unchanged
  by what the bar now filters on — it was never about difficulty or type in
  the first place.
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
  assert.match(source, /data-writing-task-filter-empty/);
});
