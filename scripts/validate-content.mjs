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

/*
  Same normalisation the app uses when marking a typed answer, including
  spelled-out numbers — a script that says "sixty-two" must satisfy a key of
  "62", exactly as it does for a learner typing either form.
*/
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

function normalise(value) {
  const base = String(value)
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"£$€%]/g, "")
    .replace(/[-–—]/g, " ")
    // "6.30pm" and "6.30 pm" are the same answer to a candidate.
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = base.split(" ").filter((t) => t !== "a");
  const out = [];
  let running = null;

  const flush = () => {
    if (running !== null) out.push(String(running));
    running = null;
  };

  for (const token of tokens) {
    // "and" joins only within a number ("a hundred and twenty-five"); between
    // two separate numbers ("one and five per cent") it must not merge them.
    if (token === "and") {
      if (running === null || running % 100 !== 0) flush();
      continue;
    }
    const digits = NUMBER_WORDS[token];
    if (digits === undefined) {
      flush();
      out.push(token);
      continue;
    }
    const value = digits;
    const isTens = running !== null && running >= 20 && running % 10 === 0;
    const isHundreds = running !== null && running % 100 === 0;
    if (value === 100 && running !== null && running < 100) running *= 100;
    else if (isTens && value < 10) running += value;
    else if (isHundreds && value < 100) running += value;
    else {
      flush();
      running = value;
    }
  }
  flush();
  return out.join(" ");
}

/*
  Every question carries an explanation, because the post-test review is where
  the learning happens — a question the learner got wrong and cannot find out
  why is worse than no question at all. The length floor exists to catch
  placeholders like "See the passage."
*/
function checkExplanation(file, q) {
  const text = typeof q.explanation === "string" ? q.explanation.trim() : "";
  if (text.length < 40) {
    fail(file, `${q.id ?? "a question"} needs an explanation for the post-test review`);
  }
}

/*
  A paper's questions are either a flat list or blocks with a shared rubric.
  Both are valid; everything below works on the flattened list, so a grouped
  paper is held to exactly the same standard as a flat one.
*/
function checkGroups(file, set) {
  const grouped = set.length > 0 && set[0] && Array.isArray(set[0].questions);
  if (!grouped) return set;

  const flat = [];
  for (const [i, group] of set.entries()) {
    const where = `group ${i + 1}`;
    if (!Array.isArray(group.questions) || group.questions.length === 0) {
      fail(file, `${where} has no questions`);
      continue;
    }
    // The rubric is the whole reason a block exists; without it the block is
    // just a flat list wearing a wrapper.
    if (!group.instruction || group.instruction.trim().length < 10) {
      fail(file, `${where} needs an instruction telling the candidate what to do`);
    }
    if (group.sharedOptions !== undefined) {
      if (!Array.isArray(group.sharedOptions) || group.sharedOptions.length === 0) {
        fail(file, `${where} has a malformed sharedOptions bank`);
      } else {
        const keys = new Set();
        for (const opt of group.sharedOptions) {
          if (!opt?.key || !opt?.text) {
            fail(file, `${where} has a shared option missing its key or text`);
          } else if (keys.has(opt.key)) {
            // Two options under one key make the answer ambiguous.
            fail(file, `${where} reuses the shared-option key "${opt.key}"`);
          } else {
            keys.add(opt.key);
          }
        }
        // Real papers carry more options than questions, so that eliminating
        // the others cannot hand a candidate the last answer for free.
        if (group.sharedOptions.length <= group.questions.length) {
          fail(
            file,
            `${where} has ${group.sharedOptions.length} options for ${group.questions.length} questions; a bank needs distractors`,
          );
        }
      }
    }
    flat.push(...group.questions);
  }
  return flat;
}

function checkQuestions(file, set, source, expectedCount) {
  if (!Array.isArray(set)) return fail(file, "questions is not an array");

  const questions = checkGroups(file, set);
  if (questions.length !== expectedCount) {
    fail(file, `expected ${expectedCount} questions, found ${questions.length}`);
  }

  const seenIds = new Set();
  const tfngAnswers = new Set();

  for (const q of questions) {
    if (!q.id) fail(file, "a question is missing its id");
    if (seenIds.has(q.id)) fail(file, `duplicate question id ${q.id}`);
    seenIds.add(q.id);
    checkExplanation(file, q);

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
  const ids = new Set();
  for (const q of questions) {
    if (ids.has(q.id)) fail("placement.json", `duplicate question id ${q.id}`);
    ids.add(q.id);
  }
  // The longest sitting asks 25, and three consecutive sittings must share no
  // question — so the bank has to carry 75 before it starts repeating.
  const LONGEST_SITTING = 25;
  if (questions.length < LONGEST_SITTING * 3) {
    fail(
      "placement.json",
      `${questions.length} questions cannot fill three non-repeating sittings of ${LONGEST_SITTING}`,
    );
  }
  const perLevel = {};
  for (const q of questions) {
    perLevel[q.level] = (perLevel[q.level] ?? 0) + 1;
    checkExplanation("placement.json", q);
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
  // The adaptive test can dwell at a level for several questions in a row, so
  // each level needs real depth or item selection has to keep drifting away
  // from the difficulty it actually wants.
  for (const level of ["A1", "A2", "B1", "B2", "C1", "C2"]) {
    const count = perLevel[level] ?? 0;
    if (count < 12) {
      fail(
        "placement.json",
        `level ${level} has only ${count} questions; the adaptive engine needs at least 12`,
      );
    }
  }
}

// ---- Reading ----
for (const name of ["reading-1.json", "reading-2.json", "reading-3.json", "reading-4.json"]) {
  const test = load(name);
  if (!test) continue;
  const words = (test.passage ?? "").split(/\s+/).filter(Boolean).length;
  if (words < 600 || words > 1100) {
    fail(name, `passage is ${words} words; IELTS passages run roughly 700-1000`);
  }
  checkQuestions(name, test.questions, test.passage, 13);
}

// ---- Listening ----
for (const name of ["listening-1.json", "listening-2.json", "listening-3.json", "listening-4.json"]) {
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
    if (task.task === 1 && task.variant === "academic" && !task.dataTable && !task.chart) {
      fail("writing-tasks.json", `${task.id} is an academic Task 1 with no data to describe`);
    }
    if (task.dataTable && task.chart) {
      // Both would let a candidate read the figures off the table and never
      // interpret the chart, which is the skill Task 1 is testing.
      fail("writing-tasks.json", `${task.id} has both a table and a chart; it should have one`);
    }
    if (task.chart) {
      const { kind, categories, series } = task.chart;
      if (!["line", "bar", "pie"].includes(kind)) {
        fail("writing-tasks.json", `${task.id} has an unknown chart kind: ${kind}`);
      }
      if (!Array.isArray(categories) || categories.length === 0) {
        fail("writing-tasks.json", `${task.id} has a chart with no categories`);
      }
      if (!Array.isArray(series) || series.length === 0) {
        fail("writing-tasks.json", `${task.id} has a chart with no series`);
      } else {
        if (kind === "pie" && series.length !== 1) {
          fail("writing-tasks.json", `${task.id} is a pie chart with ${series.length} series; it needs exactly one`);
        }
        for (const s of series) {
          if (!s.name) fail("writing-tasks.json", `${task.id} has a chart series with no name`);
          if (!Array.isArray(s.values) || s.values.length !== categories.length) {
            // A short series silently drops its last categories from the chart.
            fail("writing-tasks.json", `${task.id} series "${s.name}" has ${s.values?.length} values for ${categories.length} categories`);
          }
        }
      }
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

// ---- Grammar and vocabulary drills ----
for (const name of ["grammar.json", "vocabulary.json"]) {
  const data = load(name);
  if (!data) continue;
  const topics = data.topics ?? [];
  if (topics.length < 6) fail(name, `only ${topics.length} topics`);

  const topicIds = new Set();
  for (const topic of topics) {
    if (!topic.id) fail(name, "a topic has no id");
    if (topicIds.has(topic.id)) fail(name, `duplicate topic id ${topic.id}`);
    topicIds.add(topic.id);

    if (!topic.title) fail(name, `${topic.id} has no title`);
    if (!["A1", "A2", "B1", "B2", "C1", "C2"].includes(topic.level)) {
      fail(name, `${topic.id} has an unknown CEFR level: ${topic.level}`);
    }
    // The teaching note is what makes this study rather than a quiz.
    if (!topic.summary || topic.summary.length < 40) {
      fail(name, `${topic.id} needs a summary explaining why the topic matters`);
    }
    if (!Array.isArray(topic.points) || topic.points.length < 3) {
      fail(name, `${topic.id} needs at least three teaching points`);
    }

    const questions = topic.questions ?? [];
    if (questions.length < 6) fail(name, `${topic.id} has only ${questions.length} questions`);

    const seen = new Set();
    for (const q of questions) {
      if (seen.has(q.id)) fail(name, `${topic.id} has a duplicate question id ${q.id}`);
      seen.add(q.id);
      if (!q.prompt) fail(name, `${topic.id}/${q.id} has no prompt`);
      if (!Array.isArray(q.options) || q.options.length !== 4) {
        fail(name, `${topic.id}/${q.id} must have exactly four options`);
      } else if (new Set(q.options).size !== q.options.length) {
        // Two identical options make one of them unmarkable.
        fail(name, `${topic.id}/${q.id} has duplicate options`);
      } else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
        fail(name, `${topic.id}/${q.id} has an answer index outside its options`);
      }
      checkExplanation(name, { id: `${topic.id}/${q.id}`, explanation: q.explanation });
    }
  }
}

// ---- Glossary ----
const glossary = load("glossary.json");
if (glossary) {
  const terms = glossary.terms ?? [];
  if (terms.length < 30) fail("glossary.json", `only ${terms.length} terms`);
  const seen = new Set();
  for (const entry of terms) {
    if (!entry.term) fail("glossary.json", "an entry has no term");
    for (const key of [entry.term, ...(entry.aliases ?? [])]) {
      const k = String(key).toLowerCase();
      // A duplicate key would make which entry wins depend on load order.
      if (seen.has(k)) fail("glossary.json", `"${key}" is defined twice`);
      seen.add(k);
    }
    // The whole point is a plain-English answer, so an empty or stub
    // definition is worse than having no entry at all.
    if (!entry.short || entry.short.trim().length < 25) {
      fail("glossary.json", `"${entry.term}" has no usable definition`);
    }
    const words = String(entry.short).trim().split(/\s+/).length;
    if (words > 45) {
      fail("glossary.json", `"${entry.term}" definition is ${words} words; keep it short`);
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
