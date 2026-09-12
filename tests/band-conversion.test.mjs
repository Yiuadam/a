/*
  The raw-to-band table, pinned score by score.

  A mutation run over lib/band.ts killed only a quarter of its mutants, and
  almost every survivor was a boundary in this table: turn one `>=` into `>`
  and a candidate on exactly 30 raw drops from 7 to 6.5, with every test still
  green. That is the worst class of bug this app can have — it is silent, it is
  wrong by half a band, and nothing on the screen looks broken.

  So the table is written out here as a specification rather than sampled. Each
  entry is the band for that exact raw score out of 40; the boundaries are the
  published conversions these papers are marked against, and the point of
  listing all forty-one is that an off-by-one anywhere in the ladder now fails
  loudly and names the score it broke on.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { rawToBand } = await import(
  pathToFileURL(join(process.cwd(), "lib", "band.ts")).href
);

/* Index is the raw score out of 40. */
const LISTENING = [
  2, 2, 2, 2, 2.5, 2.5, 3, 3, 3.5, 3.5, 4, 4, 4, 4.5, 4.5, 4.5, 5, 5, 5.5,
  5.5, 5.5, 5.5, 5.5, 6, 6, 6, 6.5, 6.5, 6.5, 6.5, 7, 7, 7.5, 7.5, 7.5, 8, 8,
  8.5, 8.5, 9, 9,
];

const READING = [
  2, 2, 2, 2, 2.5, 2.5, 3, 3, 3.5, 3.5, 4, 4, 4, 4.5, 4.5, 5, 5, 5, 5, 5.5,
  5.5, 5.5, 5.5, 6, 6, 6, 6, 6.5, 6.5, 6.5, 7, 7, 7, 7.5, 7.5, 8, 8, 8.5, 8.5,
  9, 9,
];

test("every raw score converts to the band the table says", () => {
  assert.equal(LISTENING.length, 41);
  assert.equal(READING.length, 41);
  for (let raw = 0; raw <= 40; raw += 1) {
    assert.equal(
      rawToBand(raw, 40, "listening"),
      LISTENING[raw],
      `listening ${raw}/40`,
    );
    assert.equal(rawToBand(raw, 40, "reading"), READING[raw], `reading ${raw}/40`);
  }
});

/*
  A boundary is the first score that earns its band, not the last score below
  it. Stated separately from the table because this is the property a `>=`
  turned into a `>` breaks, and naming it means the failure says what went
  wrong rather than only where.
*/
test("each band starts at the score the table gives it, inclusively", () => {
  for (const [module, table] of [["listening", LISTENING], ["reading", READING]]) {
    for (let raw = 1; raw <= 40; raw += 1) {
      if (table[raw] === table[raw - 1]) continue;
      assert.equal(
        rawToBand(raw, 40, module),
        table[raw],
        `${module}: ${raw}/40 is the first score at band ${table[raw]}`,
      );
      assert.ok(
        rawToBand(raw - 1, 40, module) < table[raw],
        `${module}: ${raw - 1}/40 must be below band ${table[raw]}`,
      );
    }
  }
});

/*
  A short paper is scaled to forty before conversion, so a thirteen-question
  reading passage sat on its own reports the same band a full paper would for
  the same proportion. Pinned because the scaling is a multiplication that a
  mutation can silently invert.
*/
test("a short paper is scaled to forty rather than marked out of its own length", () => {
  assert.equal(rawToBand(13, 13, "reading"), rawToBand(40, 40, "reading"));
  assert.equal(rawToBand(0, 13, "reading"), rawToBand(0, 40, "reading"));
  /* Half of a ten-question paper is twenty of forty. */
  assert.equal(rawToBand(5, 10, "listening"), rawToBand(20, 40, "listening"));
  /* No questions at all cannot divide by zero into a band nobody earned. */
  assert.equal(rawToBand(0, 0, "listening"), rawToBand(0, 40, "listening"));
});

/*
  The two ladders that turn a band into a word, pinned at their own boundaries.

  These are read by learners on the results page and by the placement report,
  and they are the same shape as the conversion table above — a run of `>=`
  where one wrong comparison quietly moves somebody from "Good user" to
  "Competent user", or from B2 to B1. The mutation run found every one of them
  unguarded.
*/
const { bandLabel, cefrEstimate } = await import(
  pathToFileURL(join(process.cwd(), "lib", "band.ts")).href
);

test("a band's label starts at its own boundary", () => {
  const boundaries = [
    [9, "Expert user"], [8.5, "Expert user"], [8, "Very good user"],
    [7.5, "Very good user"], [7, "Good user"], [6.5, "Good user"],
    [6, "Competent user"], [5.5, "Competent user"], [5, "Modest user"],
    [4.5, "Modest user"], [4, "Limited user"], [3.5, "Limited user"],
    [3, "Extremely limited user"], [2, "Extremely limited user"],
  ];
  for (const [band, label] of boundaries) {
    assert.equal(bandLabel(band), label, `band ${band}`);
  }
  /* And the step below a boundary is not the same word. */
  assert.notEqual(bandLabel(8.5), bandLabel(8));
  assert.notEqual(bandLabel(7.5), bandLabel(7));
  assert.notEqual(bandLabel(6.5), bandLabel(6));
  assert.notEqual(bandLabel(5.5), bandLabel(5));
  assert.notEqual(bandLabel(4.5), bandLabel(4));
  assert.notEqual(bandLabel(3.5), bandLabel(3));
});

test("a band's CEFR estimate starts at its own boundary", () => {
  for (const [band, level] of [
    [9, "C2"], [8.5, "C2"], [8, "C1"], [7, "C1"], [6.5, "B2"], [5.5, "B2"],
    [5, "B1"], [4, "B1"], [3.5, "A2"], [3, "A2"], [2.5, "A1"], [2, "A1"],
  ]) {
    assert.equal(cefrEstimate(band), level, `band ${band}`);
  }
  assert.notEqual(cefrEstimate(8.5), cefrEstimate(8));
  assert.notEqual(cefrEstimate(7), cefrEstimate(6.5));
  assert.notEqual(cefrEstimate(5.5), cefrEstimate(5));
  assert.notEqual(cefrEstimate(4), cefrEstimate(3.5));
  assert.notEqual(cefrEstimate(3), cefrEstimate(2.5));
});

/*
  Spoken numbers, and the band the AI examiner is allowed to report.

  Two more clusters the mutation run walked straight through. The first is the
  parser that lets "twenty-five" mark the same as "25" — a listening answer is
  spoken, and a learner who writes the words has not got it wrong. Its rules
  are a chain of `&&`s about what may be added to what, and inverting any one
  of them silently merges two separate numbers into one ("one and five" → 15)
  or refuses to join a compound ("twenty five" → 20).

  The second is `clampBand`, which exists because the examiner returns a number
  and not necessarily a sensible one.
*/
const { isCorrect: marks, clampBand, marksEarned } = await import(
  pathToFileURL(join(process.cwd(), "lib", "band.ts")).href
);

const spoken = (given, answer) =>
  marks({ id: "q", type: "short-answer", question: "?", answer, maxWords: 4 }, given);

test("a number written in words marks the same as its digits", () => {
  for (const [words, digits] of [
    ["twenty-five", "25"],
    ["twenty five", "25"],
    ["one hundred", "100"],
    ["two thousand", "2000"],
    ["thirty", "30"],
    ["nineteen", "19"],
  ]) {
    assert.equal(spoken(words, digits), true, `${words} should mark as ${digits}`);
  }
});

test("two separate numbers are not merged into one", () => {
  /* "one and five" is two numbers in a row, not fifteen — the `and` rule. */
  assert.equal(spoken("one and five", "15"), false);
  /* And a compound that genuinely is one number still joins. */
  assert.equal(spoken("one hundred and five", "105"), true);
});

test("a band from the examiner is clamped onto the real scale", () => {
  assert.equal(clampBand(7.5), 7.5);
  assert.equal(clampBand(0), 1, "below the scale");
  assert.equal(clampBand(12), 9, "above the scale");
  assert.equal(clampBand(Number.NaN), 1, "not a number at all");
  assert.equal(clampBand("7"), 1, "a string is not a band");
  assert.equal(clampBand(undefined), 1);
});

/*
  The rest of the spoken-number rules, one case per rule.

  Each `&&` in that chain is a separate claim about what may be added to what,
  and the mutation run walked through all of them because the cases above only
  exercised the happy path. These are the inputs where inverting one clause
  changes the answer:

    running >= 20        "nineteen five" must not become 24
    running % 10 === 0   "twenty-one five" must not become 26
    value < 10           "twenty twenty" must not become 40
    running % 100 === 0  "hundred and fifty six" joins; "150 6" does not
    value < 100          "one hundred two hundred" is two numbers
*/
test("a compound number only joins where the rules allow it", () => {
  /* Joins: a round ten or hundred followed by something smaller. */
  assert.equal(spoken("twenty one", "21"), true);
  assert.equal(spoken("one hundred and fifty", "150"), true);

  /* Does not join: the left side is not a round ten. */
  assert.equal(spoken("nineteen five", "24"), false);
  /* Does not join: the right side is not smaller than the step. */
  assert.equal(spoken("twenty twenty", "40"), false);
  assert.equal(spoken("one hundred two hundred", "300"), false);
});

/*
  Multi-select answers, decoded from the string they are stored as.

  `selectedIndices` returns nothing for an unanswered question and a list for
  an answered one, and the difference decides whether a group scores zero or is
  marked. An inverted guard here marks an empty answer as a selection.
*/
test("an unanswered multi-select is no selection, not an empty one", () => {
  const q = {
    id: "m",
    type: "multi-select",
    question: "?",
    options: ["A", "B", "C", "D"],
    numAnswers: 2,
    answer: [0, 2],
  };
  assert.equal(marksEarned(q, undefined), 0);
  assert.equal(marksEarned(q, ""), 0);
  assert.equal(marksEarned(q, "0,2"), 2);
  assert.equal(marksEarned(q, "0"), 1);
  /* Over-selection is the rule that surprises people: it scores zero. */
  assert.equal(marksEarned(q, "0,1,2"), 0);
});

/*
  Placement scoring: the weights, the ratio, and the two ends of the scale.

  `scorePlacement` decides the band a learner is first shown and the plan built
  around it, and the mutation run walked through all of it — the level weights
  are six bare numbers and nothing checked that a C2 item is worth more than an
  A1 one, so a transposed pair would quietly place everybody wrong.

  Pinned by behaviour rather than by reading the constants back: what has to be
  true is that harder items count for more, that an empty sitting cannot divide
  by zero into a band, and that the two ends of the run land where the comment
  above the mapping says they do.
*/
const { scorePlacement } = await import(
  pathToFileURL(join(process.cwd(), "lib", "band.ts")).href
);

const item = (id, level, skill = "grammar") => ({
  id,
  level,
  skill,
  question: "?",
  options: ["a", "b"],
  answer: 0,
});

test("a placement run lands at the ends of the scale it claims", () => {
  const questions = ["A1", "A2", "B1", "B2", "C1", "C2"].map((l, i) => item(`q${i}`, l));
  const allRight = Object.fromEntries(questions.map((q) => [q.id, 0]));
  const allWrong = Object.fromEntries(questions.map((q) => [q.id, 1]));

  assert.equal(scorePlacement(questions, allRight).band, 9, "everything right");
  /* Nothing right is the floor, not zero: the scale starts at 1. */
  assert.equal(scorePlacement(questions, allWrong).band, 1.5, "nothing right");
  /* And an unanswered question is not a correct one. */
  assert.equal(scorePlacement(questions, {}).band, 1.5, "nothing answered");
});

test("a harder item is worth more than an easier one", () => {
  const easy = [item("a", "A1"), item("b", "C2")];
  const onlyEasy = scorePlacement(easy, { a: 0, b: 1 }).band;
  const onlyHard = scorePlacement(easy, { a: 1, b: 0 }).band;
  assert.ok(
    onlyHard > onlyEasy,
    `getting the C2 item right (${onlyHard}) must beat getting the A1 one right (${onlyEasy})`,
  );

  /*
    And the exact band for each single-correct run, not merely an increasing
    one. "Increasing" is satisfied by any six ascending numbers, so a weight
    changed from 1 to 2 slipped through it — these are the bands the current
    weights produce over one item of each level, and a change to any weight
    moves at least one of them.
  */
  const questions = ["A1", "A2", "B1", "B2", "C1", "C2"].map((l, i) => item(`q${i}`, l));
  const bandWithOnly = (level) => {
    const answers = Object.fromEntries(
      questions.map((q) => [q.id, q.level === level ? 0 : 1]),
    );
    return scorePlacement(questions, answers).band;
  };
  assert.deepEqual(
    Object.fromEntries(
      ["A1", "A2", "B1", "B2", "C1", "C2"].map((l) => [l, bandWithOnly(l)]),
    ),
    { A1: 2, A2: 2, B1: 2.5, B2: 3, C1: 3.5, C2: 3.5 },
  );
  assert.ok(bandWithOnly("C2") > bandWithOnly("A1"), "C2 must outweigh A1");
});

test("an empty placement sitting cannot divide by zero into a band", () => {
  const result = scorePlacement([], {});
  assert.ok(Number.isFinite(result.band));
  assert.equal(result.band, 1.5);
});

/*
  Nothing written is wrong, whatever the question type. The guard is three
  clauses joined by `||` and the mutation run inverted each of them.
*/
test("an unanswered question is never correct", () => {
  const q = { id: "q", type: "short-answer", question: "?", answer: "yes", maxWords: 2 };
  for (const given of [undefined, null, ""]) {
    assert.equal(marks(q, given), false, `given ${JSON.stringify(given)}`);
  }
  assert.equal(marks(q, "yes"), true);
});

/*
  Every number word, and the scaling factor itself.

  The last two clusters the mutation run walked through. `NUMBER_WORDS` is a
  table of thirty-odd literals and the cases above only used five of them, so
  "three" could have mapped to "4" with everything green. And the scale to
  forty is one multiplication: at 12 out of 13 the difference between ×40 and
  ×41 is the difference between band 8 and band 8.5, which is the whole reason
  a short paper is scaled at all.
*/
test("every number word marks as its own digits", () => {
  const words = {
    zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
    six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11",
    twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
    sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
    twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
    seventy: "70", eighty: "80", ninety: "90",
  };
  for (const [word, digits] of Object.entries(words)) {
    assert.equal(spoken(word, digits), true, `${word} should mark as ${digits}`);
    /* And not as its neighbour, which is what a transposed table would do. */
    assert.equal(
      spoken(word, String(Number(digits) + 1)),
      false,
      `${word} must not mark as ${Number(digits) + 1}`,
    );
  }
});

test("a short paper is scaled by exactly forty", () => {
  /*
    12 of 13 is 36.9 of 40 — band 8 in both modules. Scaled by anything larger
    it reaches 37 and reports 8.5, which is the mutation this pins.
  */
  assert.equal(rawToBand(12, 13, "reading"), 8);
  assert.equal(rawToBand(12, 13, "listening"), 8);
  /* And by anything smaller it falls to 7.5. */
  assert.equal(rawToBand(11, 13, "reading"), 7.5);
});

/*
  The per-skill and per-level tallies the placement report is built from.

  Nothing checked them, so every counter in `scorePlacement` could have started
  at one or counted in twos with the band still coming out right — and those
  tallies are what the results page turns into "your weakest skill" and what
  the study plan is ordered by. A band that is correct and a breakdown that is
  not is the worst of both: the number looks trustworthy and the advice under
  it is wrong.
*/
test("the placement breakdown counts what was actually asked and answered", () => {
  const questions = [
    { ...item("a", "A1", "grammar"), answer: 0 },
    { ...item("b", "A1", "grammar"), answer: 0 },
    { ...item("c", "B2", "reading"), answer: 0 },
  ];
  const result = scorePlacement(questions, { a: 0, b: 1, c: 0 });

  assert.equal(result.bySkill.grammar.total, 2, "two grammar items were asked");
  assert.equal(result.bySkill.grammar.correct, 1, "one of them was right");
  assert.equal(result.bySkill.reading.total, 1);
  assert.equal(result.bySkill.reading.correct, 1);
  /* A skill nothing was asked about is zero and zero, not absent. */
  assert.equal(result.bySkill.vocabulary.total, 0);
  assert.equal(result.bySkill.vocabulary.correct, 0);

  assert.equal(result.byLevel.A1.total, 2);
  assert.equal(result.byLevel.A1.correct, 1);
  assert.equal(result.byLevel.B2.total, 1);
  assert.equal(result.byLevel.B2.correct, 1);
  assert.equal(result.byLevel.C2.total, 0);
  assert.equal(result.byLevel.C2.correct, 0);
});

/*
  C1 and C2 are worth different amounts. They land on the same band in the
  single-correct table above — a rounded half-band hides a difference of one
  weight — so this asks the question in a run where they cannot tie.
*/
test("C2 is worth more than C1", () => {
  const pair = [item("x", "C1"), item("y", "C2"), item("z", "A1")];
  const onlyC1 = scorePlacement(pair, { x: 0, y: 1, z: 1 }).band;
  const onlyC2 = scorePlacement(pair, { x: 1, y: 0, z: 1 }).band;
  assert.ok(onlyC2 > onlyC1, `C2 alone (${onlyC2}) must beat C1 alone (${onlyC1})`);
});

/*
  Ordinals, the one-question paper, and the digit/letter split.

  The last cluster the mutation run reached. Ordinals are half the number table
  and nothing touched them, so "third" could have marked as 4 — and a listening
  answer is as likely to be "the third of May" as "3 May". The one-question
  guard is the `total > 0` that stops a division by zero; mutated to `> 1` a
  single-question paper silently scores nothing. And the normaliser splits a
  number from the letters stuck to it, which is what lets "25kg" mark against
  "25 kg".
*/
test("ordinals mark as their own digits", () => {
  const ordinals = {
    first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
    seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11",
    twelfth: "12", thirteenth: "13", fourteenth: "14", fifteenth: "15",
    sixteenth: "16", seventeenth: "17", eighteenth: "18", nineteenth: "19",
    twentieth: "20", thirtieth: "30",
  };
  for (const [word, digits] of Object.entries(ordinals)) {
    assert.equal(spoken(word, digits), true, `${word} should mark as ${digits}`);
    assert.equal(
      spoken(word, String(Number(digits) + 1)),
      false,
      `${word} must not mark as ${Number(digits) + 1}`,
    );
  }
});

test("a one-question paper still converts", () => {
  assert.equal(rawToBand(1, 1, "reading"), rawToBand(40, 40, "reading"));
  assert.equal(rawToBand(0, 1, "reading"), rawToBand(0, 40, "reading"));
});

test("a number stuck to its unit is still the number", () => {
  assert.equal(spoken("25kg", "25 kg"), true);
  assert.equal(spoken("25 kg", "25kg"), true);
});

/*
  A placement of one question still scores.

  `max > 0` is the guard that stops a division by zero, and one A1 item is the
  smallest run where it can be got wrong — raise the threshold by one and a
  single-question sitting reports the floor however it was answered.
*/
test("a single-question placement is scored, not floored", () => {
  const one = [item("a", "A1")];
  assert.notEqual(
    scorePlacement(one, { a: 0 }).band,
    scorePlacement(one, { a: 1 }).band,
    "getting the only question right must not score the same as getting it wrong",
  );
});
