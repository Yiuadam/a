#!/usr/bin/env node
/*
  Checks the exam content bank for the defects that would actually hurt a
  learner: an answer key that cannot be reached from the passage, a multiple
  choice question whose correct index does not exist, a completion answer the
  app's own matching logic would mark wrong.

  This mirrors the normalisation in lib/band.ts — if the two ever drift, a
  learner types the right answer and is told it is wrong, so the duplication is
  deliberate and worth keeping honest.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "data");
const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

function load(name) {
  try {
    return JSON.parse(readFileSync(join(DATA, name), "utf8"));
  } catch (err) {
    fail(name, `could not be parsed — ${err.message}`);
    return null;
  }
}

/** Same normalisation the app uses when marking a typed answer. */
function normalise(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, "")
    .replace(/\s+/g, " ");
}

function checkQuestions(file, questions, source, expectedCount) {
  if (!Array.isArray(questions)) return fail(file, "questions is not an array");
  if (questions.length !== expectedCount) {
    fail(file, `expected ${expectedCount} questions, found ${questions.length}`);
  }

  const seenIds = new Set();
  const tfngAnswers = new Set();

  for (const q of questions) {
    if (!q.id) fail(file, "a question is missing its id");
    if (seenIds.has(q.id)) fail(file, `duplicate question id ${q.id}`);
    seenIds.add(q.id);

    if (q.type === "tfng") {
      if (!["TRUE", "FALSE", "NOT GIVEN"].includes(q.answer)) {
        fail(file, `${q.id} has an invalid True/False/Not Given answer: ${q.answer}`);
      }
      tfngAnswers.add(q.answer);
      if (!q.statement) fail(file, `${q.id} has no statement`);
    } else if (q.type === "mcq") {
      if (!Array.isArray(q.options) || q.options.length < 3) {
        fail(file, `${q.id} needs at least three options`);
      } else if (
        !Number.isInteger(q.answer) ||
        q.answer < 0 ||
        q.answer >= q.options.length
      ) {
        // An out-of-range index makes the question unanswerable.
        fail(file, `${q.id} has an answer index outside its options`);
      }
      if (!q.question) fail(file, `${q.id} has no question text`);
    } else if (q.type === "completion") {
      if (!q.sentence?.includes("___")) fail(file, `${q.id} has no ___ blank to fill`);
      if (!q.answer) {
        fail(file, `${q.id} has no answer`);
      } else {
        if (source && !normalise(source).includes(normalise(q.answer))) {
          fail(file, `${q.id} answer "${q.answer}" does not appear in the passage or script`);
        }
        const words = String(q.answer).trim().split(/\s+/).length;
        if (q.maxWords && words > q.maxWords) {
          fail(file, `${q.id} answer is longer than its own ${q.maxWords}-word limit`);
        }
      }
    } else {
      fail(file, `${q.id ?? "a question"} has an unknown type: ${q.type}`);
    }
  }

  // A True/False/Not Given set that never uses one of the three answers trains
  // the wrong instinct.
  if (tfngAnswers.size > 0 && tfngAnswers.size < 3) {
    fail(file, `True/False/Not Given answers only cover ${[...tfngAnswers].join(", ")}`);
  }
}

// ---- Placement ----
const placement = load("placement.json");
if (placement) {
  const questions = placement.questions ?? [];
  if (questions.length !== 18) fail("placement.json", `expected 18 questions, found ${questions.length}`);
  const perLevel = {};
  for (const q of questions) {
    perLevel[q.level] = (perLevel[q.level] ?? 0) + 1;
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      fail("placement.json", `${q.id} must have exactly four options`);
    } else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
      fail("placement.json", `${q.id} has an answer index outside its options`);
    }
    if (!["grammar", "vocabulary", "reading"].includes(q.skill)) {
      fail("placement.json", `${q.id} has an unknown skill: ${q.skill}`);
    }
    if (!["A1", "A2", "B1", "B2", "C1", "C2"].includes(q.level)) {
      fail("placement.json", `${q.id} has an unknown CEFR level: ${q.level}`);
    }
  }
  // The band estimate assumes an even spread of difficulty.
  for (const level of ["A1", "A2", "B1", "B2", "C1", "C2"]) {
    if (perLevel[level] !== 3) {
      fail("placement.json", `level ${level} has ${perLevel[level] ?? 0} questions, expected 3`);
    }
  }
}

// ---- Reading ----
for (const name of ["reading-1.json", "reading-2.json"]) {
  const test = load(name);
  if (!test) continue;
  const words = (test.passage ?? "").split(/\s+/).filter(Boolean).length;
  if (words < 600 || words > 1100) {
    fail(name, `passage is ${words} words; IELTS passages run roughly 700-1000`);
  }
  checkQuestions(name, test.questions, test.passage, 13);
}

// ---- Listening ----
for (const name of ["listening-1.json", "listening-2.json"]) {
  const test = load(name);
  if (!test) continue;
  const script = (test.script ?? []).map((turn) => turn.text).join(" ");
  const words = script.split(/\s+/).filter(Boolean).length;
  if (words < 400 || words > 1100) fail(name, `script is ${words} words`);
  for (const turn of test.script ?? []) {
    if (!(test.speakers ?? []).includes(turn.speaker)) {
      // An undeclared speaker gets no voice of its own during playback.
      fail(name, `script uses speaker "${turn.speaker}" which is not declared`);
    }
  }
  checkQuestions(name, test.questions, script, 10);
}

// ---- Writing ----
const writing = load("writing-tasks.json");
if (writing) {
  const tasks = writing.tasks ?? [];
  if (tasks.length < 4) fail("writing-tasks.json", `only ${tasks.length} tasks`);
  for (const task of tasks) {
    if (![1, 2].includes(task.task)) fail("writing-tasks.json", `${task.id} has an invalid task number`);
    if (!task.prompt || !task.title) fail("writing-tasks.json", `${task.id} is missing a prompt or title`);
    if (task.task === 1 && task.variant === "academic" && !task.dataTable) {
      fail("writing-tasks.json", `${task.id} is an academic Task 1 with no data to describe`);
    }
    if (task.dataTable) {
      const { headers, rows } = task.dataTable;
      if (!Array.isArray(headers) || !Array.isArray(rows)) {
        fail("writing-tasks.json", `${task.id} has a malformed data table`);
      } else {
        for (const [i, row] of rows.entries()) {
          if (row.length !== headers.length) {
            fail("writing-tasks.json", `${task.id} row ${i + 1} does not match its headers`);
          }
        }
      }
    }
  }
}

// ---- Speaking ----
const speaking = load("speaking-topics.json");
if (speaking) {
  for (const part of ["part1", "part2", "part3"]) {
    if (!Array.isArray(speaking[part]) || speaking[part].length === 0) {
      fail("speaking-topics.json", `${part} is empty`);
    }
  }
  for (const card of speaking.part2 ?? []) {
    if (!card.cueCard) fail("speaking-topics.json", `${card.id} has no cue card`);
    if ((card.bullets ?? []).length !== 4) {
      fail("speaking-topics.json", `${card.id} needs exactly four bullet points`);
    }
  }
  // Part 3 extends the Part 2 topic, so every set needs a card to follow.
  const cardTopics = new Set((speaking.part2 ?? []).map((c) => c.topic));
  for (const set of speaking.part3 ?? []) {
    if (!cardTopics.has(set.topic)) {
      fail("speaking-topics.json", `part 3 topic "${set.topic}" has no matching cue card`);
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) in the content bank:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Content bank OK: every answer key is reachable and well formed.");
