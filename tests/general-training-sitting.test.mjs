/*
  A General Training sitting must be General Training in every part of it that
  differs from Academic.

  The variant used to reach only the Reading paper: a candidate who chose
  General Training was given GT sections to read and then an Academic chart to
  describe, on a screen that said General Training at the top. That is a worse
  error than offering no GT paper at all, because it looks like the real thing.

  Listening and Task 2 are deliberately not asserted to differ — they are the
  same paper on both variants in the real exam, and the bank holds one set.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { composeMock, readingPaper } = await import(
  pathToFileURL(join(process.cwd(), "lib", "exam", "mock.ts")).href
);
const { default: writing } = await import(
  pathToFileURL(join(process.cwd(), "data", "writing-tasks.json")).href,
  { with: { type: "json" } }
);

const SITTINGS = 40;

function task1For(paper) {
  return writing.tasks.find((task) => task.id === paper.writing[0]);
}

test("a General Training sitting draws General Training reading and a letter for Task 1", () => {
  for (let i = 0; i < SITTINGS; i += 1) {
    const paper = composeMock("general");
    for (const id of paper.reading) {
      assert.equal(readingPaper(id)?.variant, "general", `${id} is not a General Training paper`);
    }
    const task1 = task1For(paper);
    assert.equal(task1.variant, "general", `${task1.id} is not a General Training task`);
    assert.equal(task1.type, "letter", `${task1.id} is a ${task1.type}, not a letter`);
  }
});

test("an Academic sitting still draws Academic reading and an Academic Task 1", () => {
  for (let i = 0; i < SITTINGS; i += 1) {
    const paper = composeMock("academic");
    for (const id of paper.reading) {
      assert.equal(readingPaper(id)?.variant, "academic", `${id} is not an Academic paper`);
    }
    assert.equal(task1For(paper).variant, "academic");
  }
});

test("Task 2 is the same essay bank either way", () => {
  const seen = new Set();
  for (let i = 0; i < SITTINGS; i += 1) {
    for (const variant of ["academic", "general"]) {
      const paper = composeMock(variant);
      const task2 = writing.tasks.find((task) => task.id === paper.writing[1]);
      assert.equal(task2.task, 2);
      assert.equal(task2.type, "essay");
      seen.add(variant);
    }
  }
  assert.equal(seen.size, 2);
});
