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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "data");
const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

// Mirrors lib/band.ts's LEVELS — kept as a literal here because the validator
// only imports node:fs and must not reach into app code to get it.
const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

/*
  Every piece of practice content now carries a CEFR level alongside its
  difficulty, so a learner can place it on the same scale their placement
  result already speaks. A missing or bogus level is as unshippable as a
  missing explanation.
*/
function checkLevel(file, item, label) {
  if (!CEFR_LEVELS.includes(item?.level)) {
    fail(file, `${label} has an unknown CEFR level: ${item?.level}`);
  }
}

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
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

/*
  Whether two answers differ only in how a number is written.

  The rule above — every accepted answer must appear in the source — exists to
  catch an invented answer, and it should keep doing that. But it also caught
  the tolerances a human marker gives for free: a passage says 9.30 and a
  candidate writes 930, which is the same answer written differently and is not
  in the text as such. Before the normaliser learned to keep a decimal point,
  those two collapsed to one string and the question never arose.

  So a variant is allowed past the source check when it is the key with its
  decimal points removed — traceable to the text, and unable to smuggle in an
  answer the passage does not support, because the digits have to match.
*/
function sameNumber(variant, answer) {
  const digits = (s) => normalise(String(s)).replace(/\./g, "");
  return digits(variant) === digits(answer);
}

function normalise(value) {
  const base = String(value)
    .trim()
    .toLowerCase()
    // A full stop flanked by digits is a decimal point, not punctuation.
    // Stripping it turned the key "3.8" into "38", so a candidate who read the
    // passage correctly and typed 3.8 was marked wrong while one who typed 38
    // was marked right. Every other dot still goes.
    .replace(/(?<!\d)[.](?!\d)|(?<=\d)[.](?!\d)|(?<!\d)[.](?=\d)/g, "")
    .replace(/[,!?;:'"£$€%]/g, "")
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
    // Mirrors lib/band.ts: a multiplier, not an addend, so a script that says
    // "four thousand" satisfies a key of "4000".
    if (value === 1000 && running !== null) running *= 1000;
    else if (value === 100 && running !== null && running < 100) running *= 100;
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
function checkGroups(file, set, groupOf) {
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
    /*
      A plan or map the block is answered against.

      The failures worth catching are the ones that look fine in the JSON. A
      letter offered in the bank with no marker on the drawing is a choice the
      candidate cannot make; a marker whose letter is not in the bank is a
      position they cannot name. Two markers on top of each other are one
      illegible character where the task needs two, and a marker outside the
      0-100 square is simply not on the picture.
    */
    if (group.figure !== undefined) {
      const figure = group.figure;
      if (figure?.kind !== "plan") {
        fail(file, `${where} has a figure that is not a plan`);
      } else {
        const inSquare = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
        if (!Array.isArray(figure.areas) || figure.areas.length === 0) {
          fail(file, `${where} has a plan with nothing drawn on it`);
        } else {
          for (const area of figure.areas) {
            if (
              !inSquare(area?.x) || !inSquare(area?.y) ||
              !inSquare(area?.w) || !inSquare(area?.h) ||
              area.x + area.w > 100 || area.y + area.h > 100
            ) {
              fail(file, `${where} has a plan block that falls outside the drawing`);
              break;
            }
          }
        }

        const markers = Array.isArray(figure.markers) ? figure.markers : [];
        if (markers.length === 0) {
          fail(file, `${where} has a plan with no lettered positions on it`);
        }
        for (const marker of markers) {
          if (!inSquare(marker?.x) || !inSquare(marker?.y)) {
            fail(file, `${where} places ${marker?.key} outside the drawing`);
          }
        }
        for (let i = 0; i < markers.length; i += 1) {
          for (let j = i + 1; j < markers.length; j += 1) {
            const a = markers[i];
            const b = markers[j];
            if (a?.key === b?.key) {
              fail(file, `${where} uses the letter ${a.key} twice on the same plan`);
            } else if (Math.hypot(a.x - b.x, a.y - b.y) < 8) {
              fail(
                file,
                `${where} puts ${a.key} and ${b.key} too close together to tell apart`,
              );
            }
          }
        }

        /*
          The bank and the drawing have to name the same set of letters. Either
          direction of mismatch leaves the candidate with a question that has
          no answer they can give.
        */
        const bank = (group.sharedOptions ?? []).map((o) => o?.key);
        if (bank.length === 0) {
          fail(file, `${where} has a plan but no bank of letters to answer it from`);
        }
        for (const marker of markers) {
          if (!bank.includes(marker?.key)) {
            fail(file, `${where} marks ${marker?.key} on the plan but does not offer it`);
          }
        }
        for (const key of bank) {
          if (!markers.some((m) => m?.key === key)) {
            fail(file, `${where} offers ${key} but never puts it on the plan`);
          }
        }
        for (const q of group.questions) {
          if (q?.type !== "matching") {
            fail(
              file,
              `${where} is a labelling task but ${q?.id} is a ${q?.type} question; a place on a plan is named by choosing its letter`,
            );
          }
        }
      }
    }

    /*
      A table or flow-chart completion, whose gaps live in cells rather than in
      a numbered list.

      Two ways to get this wrong, and both are silent at runtime. A placeholder
      naming a question that is not in this block draws literal `{{q5}}` text
      where a box should be, and a question in the block that no cell places
      never gets a box at all — the candidate is asked for forty answers and
      given thirty-nine places to write one. So the two sets have to match
      exactly, and each question may be placed once. The renderer degrades
      rather than throws on a bad placeholder (components/TestQuestions.tsx),
      which is why the build is where this has to be caught.
    */
    if (group.layout !== undefined) {
      const layout = group.layout;
      let cells = null;
      if (layout?.kind === "table") {
        if (!Array.isArray(layout.rows) || layout.rows.length === 0) {
          fail(file, `${where} has a table layout with no rows`);
        } else if (layout.rows.some((row) => !Array.isArray(row))) {
          fail(file, `${where} has a table layout whose rows are not arrays of cells`);
        } else {
          cells = layout.rows.flat();
          if (layout.columns !== undefined) {
            if (!Array.isArray(layout.columns) || layout.columns.length === 0) {
              fail(file, `${where} has a table layout with malformed columns`);
            } else if (layout.rows.some((row) => row.length !== layout.columns.length)) {
              // A short row shifts every cell after it into the wrong column,
              // which changes what the question is asking.
              fail(
                file,
                `${where} has a table layout with ${layout.columns.length} columns and a row that does not match`,
              );
            }
          }
        }
      } else if (layout?.kind === "flow-chart") {
        if (!Array.isArray(layout.steps) || layout.steps.length === 0) {
          fail(file, `${where} has a flow-chart layout with no steps`);
        } else {
          cells = layout.steps;
        }
      } else if (layout?.kind === "notes") {
        if (!Array.isArray(layout.sections) || layout.sections.length === 0) {
          fail(file, `${where} has a notes layout with no sections`);
        } else {
          cells = [];
          for (const section of layout.sections) {
            if (section?.heading !== undefined) cells.push(section.heading);
            if (!Array.isArray(section?.bullets) || section.bullets.length === 0) {
              fail(file, `${where} has a notes section with no bullets`);
              cells = null;
              break;
            }
            for (const bullet of section.bullets) {
              if (typeof bullet === "string") {
                cells.push(bullet);
              } else if (bullet && typeof bullet.text === "string" && Array.isArray(bullet.sub)) {
                cells.push(bullet.text, ...bullet.sub);
              } else {
                fail(file, `${where} has a notes bullet that is neither a line nor a line with sub-lines`);
                cells = null;
                break;
              }
            }
            if (!cells) break;
          }
        }
      } else {
        fail(file, `${where} has a layout that is none of a table, a flow chart or a page of notes`);
      }

      if (cells) {
        if (cells.some((cell) => typeof cell !== "string")) {
          fail(file, `${where} has a layout cell that is not a string`);
          cells = null;
        }
      }
      if (cells) {
        const placed = [];
        for (const cell of cells) {
          for (const match of cell.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g)) placed.push(match[1]);
        }
        const ids = new Set(group.questions.map((q) => q?.id));
        for (const id of placed) {
          if (!ids.has(id)) {
            fail(file, `${where} places a gap for ${id}, which is not a question in that block`);
          }
        }
        for (const id of ids) {
          const times = placed.filter((placedId) => placedId === id).length;
          if (times === 0) {
            fail(file, `${where} has a layout but never places ${id} in it`);
          } else if (times > 1) {
            fail(file, `${where} places ${id} ${times} times; a gap belongs in one cell`);
          }
        }
        /*
          Only a typed gap can be drawn into a cell. Everything else in the
          exam — a matching key, a set of radio buttons — needs controls a
          table cell has no room for, and none of the real figure tasks ask
          for one.
        */
        for (const q of group.questions) {
          if (q?.type !== "completion" && q?.type !== "short-answer") {
            fail(
              file,
              `${where} is drawn as a ${layout.kind} but ${q?.id} is a ${q?.type} question; only gaps can sit in a cell`,
            );
          }
        }
      }
    }
    for (const q of group.questions) {
      // Matching questions answer against their group's bank, so the checks
      // below need to find their way back from a question to its block.
      if (q?.id) groupOf.set(q.id, group);
    }
    flat.push(...group.questions);
  }
  return flat;
}

/*
  How many paper numbers one question claims — 1 for every type but
  multi-select, whose single prompt is worth `numAnswers` marks and claims
  that many consecutive numbers ("Questions 15 and 16" for one item). Mirrors
  `questionWidth` in lib/questions.ts; kept as a literal here for the same
  reason CEFR_LEVELS is — this script must not import app code.
*/
function questionWidth(q) {
  return q.type === "multi-select" && Number.isInteger(q.numAnswers) ? q.numAnswers : 1;
}

function checkQuestions(file, set, source, expectedCount) {
  if (!Array.isArray(set)) return fail(file, "questions is not an array");

  const groupOf = new Map();
  const questions = checkGroups(file, set, groupOf);
  // Numbers claimed, not questions held — a multi-select claims two or three
  // numbers from a single JSON entry, so counting entries would under-count
  // the paper the moment one is used.
  const claimedNumbers = questions.reduce((n, q) => n + questionWidth(q), 0);
  const allowed = Array.isArray(expectedCount) ? expectedCount : [expectedCount];
  if (!allowed.includes(claimedNumbers)) {
    fail(file, `expected ${allowed.join(" or ")} questions, found ${claimedNumbers}`);
  }

  const seenIds = new Set();
  const tfngAnswers = new Set();
  const ynngAnswers = new Set();

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
    } else if (q.type === "multi-select") {
      if (!q.question) fail(file, `${q.id} has no question text`);
      // Real IELTS never asks for anything but two or three letters — not a
      // style choice, the whole "Choose TWO letters" rubric depends on it.
      if (q.numAnswers !== 2 && q.numAnswers !== 3) {
        fail(file, `${q.id} must choose 2 or 3 letters, not ${q.numAnswers}`);
      }
      if (!Array.isArray(q.options) || q.options.length < (q.numAnswers ?? 0) + 2) {
        // At least two spare options, so eliminating the others is not free —
        // the same reasoning `checkGroups` applies to a matching bank.
        fail(file, `${q.id} needs at least ${(q.numAnswers ?? 0) + 2} options for ${q.numAnswers} correct letters`);
      }
      if (!Array.isArray(q.answer) || q.answer.length !== q.numAnswers) {
        fail(file, `${q.id} answer must list exactly ${q.numAnswers} letters, found ${q.answer?.length}`);
      } else {
        const seenIdx = new Set();
        for (const idx of q.answer) {
          if (
            !Number.isInteger(idx) ||
            idx < 0 ||
            (Array.isArray(q.options) && idx >= q.options.length)
          ) {
            fail(file, `${q.id} has an answer index outside its options`);
          } else if (seenIdx.has(idx)) {
            // The same letter cannot be "correct" twice; order is the only
            // thing this type does not care about, not repetition.
            fail(file, `${q.id} lists the same letter twice in its answer`);
          }
          seenIdx.add(idx);
        }
      }
      /*
        The "Choose TWO letters, A-E" rubric lives on the enclosing group's
        instruction, not on the question itself — there is nowhere else for it
        to be printed. A multi-select with no group, or a group with no real
        instruction, would show a candidate a list of letters and never say
        how many to pick.
      */
      const group = groupOf.get(q.id);
      if (!group || !group.instruction || group.instruction.trim().length < 10) {
        fail(file, `${q.id} is a multi-select question but has no group instruction telling the candidate how many letters to choose`);
      }
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
    } else if (q.type === "ynng") {
      if (!["YES", "NO", "NOT GIVEN"].includes(q.answer)) {
        fail(file, `${q.id} has an invalid Yes/No/Not Given answer: ${q.answer}`);
      }
      ynngAnswers.add(q.answer);
      if (!q.statement) fail(file, `${q.id} has no statement`);
    } else if (q.type === "matching") {
      if (!q.prompt) fail(file, `${q.id} has nothing to match`);
      if (!q.answer) fail(file, `${q.id} has no answer`);
      /*
        The bank lives on the group, so a matching question outside one has no
        options to choose from and is unanswerable. `groupOf` is built by
        checkGroups for exactly this.
      */
      const group = groupOf.get(q.id);
      const bank = group?.sharedOptions;
      if (!Array.isArray(bank) || bank.length === 0) {
        fail(file, `${q.id} is a matching question but its group has no sharedOptions`);
      } else {
        const keys = bank.map((o) => String(o.key).toUpperCase());
        if (!keys.includes(String(q.answer).toUpperCase())) {
          fail(file, `${q.id} answers "${q.answer}", which is not one of its group's options`);
        }
      }
    } else if (q.type === "short-answer") {
      if (!q.question) fail(file, `${q.id} has no question text`);
      if (!q.answer) {
        fail(file, `${q.id} has no answer`);
      } else {
        for (const a of [q.answer, ...(q.accept ?? [])]) {
          if (source && !normalise(source).includes(normalise(a)) && !sameNumber(a, q.answer)) {
            fail(file, `${q.id} answer "${a}" does not appear in the passage or script`);
          }
          const words = String(a).trim().split(/\s+/).length;
          if (q.maxWords && words > q.maxWords) {
            fail(file, `${q.id} answer "${a}" is longer than its own ${q.maxWords}-word limit`);
          }
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
  // The same trap, and worth catching separately: a Yes/No set that never uses
  // NOT GIVEN teaches candidates to never choose it.
  if (ynngAnswers.size > 0 && ynngAnswers.size < 3) {
    fail(file, `Yes/No/Not Given answers only cover ${[...ynngAnswers].join(", ")}`);
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

/*
  Found on disk rather than listed here.

  The list used to be written out by hand and it went stale the moment somebody
  added a paper: listening-5 and listening-6 were written, committed and never
  validated, because the loop only knew about four. A directory listing cannot
  forget.
*/
function papers(prefix) {
  return readdirSync(DATA)
    .filter((f) => new RegExp(`^${prefix}-\\d+\\.json$`).test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

// ---- Reading ----
const readingPapers = papers("reading");
if (readingPapers.length === 0) fail("data/", "no reading papers found at all");
for (const name of readingPapers) {
  const test = load(name);
  if (!test) continue;
  const words = (test.passage ?? "").split(/\s+/).filter(Boolean).length;
  if (words < 600 || words > 1100) {
    fail(name, `passage is ${words} words; IELTS passages run roughly 700-1000`);
  }
  checkLevel(name, test, "the paper");
  /*
    Thirteen or fourteen, because a real Academic Reading paper is three
    passages of 13, 13 and 14 — forty numbers split unevenly, with the longest
    set on the last passage. A bank of uniform papers cannot produce that
    total from three of them, which is exactly what happened when every paper
    was extended to fourteen: the sitting came to 42 and said so on its own
    start screen. `composeMock` draws two of one size and one of the other;
    this is the check that keeps both pools stocked with papers it can use.
  */
  checkQuestions(name, test.questions, test.passage, [13, 14]);
}

// ---- Listening ----
const listeningPapers = papers("listening");
if (listeningPapers.length === 0) fail("data/", "no listening papers found at all");
for (const name of listeningPapers) {
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
  checkLevel(name, test, "the paper");
  checkQuestions(name, test.questions, script, 10);
}

/*
  What a writing task asks the candidate to produce.

  This used to be the vocabulary the chooser's filter bar ran on; the bar runs
  on `task` (1 or 2) now, a field that needs no validating because it is
  either the number the type is derived from or it is rejected below. The type
  stays and is still checked, because it is still true independent of any bar:
  an essay has to be a Task 2, a letter a General Training Task 1, and a chart
  or a table the one the task actually carries.

  Mirrors WRITING_TASK_TYPES in lib/types.ts, kept as a literal for the same
  reason CEFR_LEVELS above is: this script imports node:fs and nothing else,
  so that it can run before the app builds rather than after it.

  Two things are checked, and the second is the one worth having. A type
  outside the set is simply wrong. A type that its own content contradicts is
  worse, because it reads as correct to anyone who does not check — so the
  build checks. That way the field cannot drift away from the paper it
  describes without the build saying so.
*/
const WRITING_TASK_TYPES = ["chart", "table", "plan", "process", "letter", "essay"];

function checkWritingType(task) {
  const id = task.id ?? "a task";
  if (!WRITING_TASK_TYPES.includes(task.type)) {
    fail("writing-tasks.json", `${id} has an unknown task type: ${task.type}`);
    return;
  }
  const expected = task.task === 2
    ? "essay"
    : task.dataTable
      ? "table"
      : task.chart
        ? "chart"
        : task.plans
          ? "plan"
          : task.process
            ? "process"
            : task.variant === "general"
              ? "letter"
              : null;
  /*
    Null means the task carries no evidence either way — an academic Task 1
    with neither a table nor a chart. That is already a failure a few lines
    below, and reporting it twice in different words would send whoever fixes
    it looking for two problems.
  */
  if (expected !== null && task.type !== expected) {
    fail(
      "writing-tasks.json",
      `${id} is typed "${task.type}" but its content is a ${expected}`,
    );
  }
}

// ---- Writing ----
const writing = load("writing-tasks.json");
if (writing) {
  const tasks = writing.tasks ?? [];
  if (tasks.length < 4) fail("writing-tasks.json", `only ${tasks.length} tasks`);
  for (const task of tasks) {
    if (![1, 2].includes(task.task)) fail("writing-tasks.json", `${task.id} has an invalid task number`);
    if (!task.prompt || !task.title) fail("writing-tasks.json", `${task.id} is missing a prompt or title`);
    checkLevel("writing-tasks.json", task, task.id ?? "a task");
    checkWritingType(task);
    if (
      task.task === 1 && task.variant === "academic" &&
      !task.dataTable && !task.chart && !task.plans && !task.process
    ) {
      fail("writing-tasks.json", `${task.id} is an academic Task 1 with nothing to describe`);
    }
    if ([task.dataTable, task.chart, task.plans, task.process].filter(Boolean).length > 1) {
      // Two views of the same thing would let a candidate read the figures off
      // one and never interpret the other, which is the skill Task 1 tests.
      fail("writing-tasks.json", `${task.id} carries more than one figure; it should have one`);
    }
    /*
      A process is a sequence, and a sequence of one or two is not one. Three
      is the fewest that has a middle — which is where the language the task is
      really testing lives, since "first" and "finally" come free and "the pulp
      is then pressed" does not.
    */
    if (task.process !== undefined) {
      const stages = task.process?.stages;
      if (!Array.isArray(stages) || stages.length < 3) {
        fail("writing-tasks.json", `${task.id} needs at least three stages to be a process`);
      } else if (stages.some((stage) => !stage?.label)) {
        fail("writing-tasks.json", `${task.id} has a process stage with no label`);
      }
    }
    /*
      A map task is a *pair* of plans, because the writing it asks for is what
      changed between them. One plan on its own leaves nothing to compare and
      turns a change description into a list of what is there.
    */
    if (task.plans !== undefined) {
      if (!Array.isArray(task.plans) || task.plans.length < 2) {
        fail("writing-tasks.json", `${task.id} needs at least two plans to compare`);
      } else {
        for (const plan of task.plans) {
          if (!plan?.caption) {
            fail("writing-tasks.json", `${task.id} has a plan with no caption saying when it is`);
          }
          const figure = plan?.figure;
          if (figure?.kind !== "plan" || !Array.isArray(figure.areas) || figure.areas.length === 0) {
            fail("writing-tasks.json", `${task.id} has a plan with nothing drawn on it`);
            continue;
          }
          for (const area of figure.areas) {
            const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
            if (!ok(area?.x) || !ok(area?.y) || !ok(area?.w) || !ok(area?.h) ||
                area.x + area.w > 100 || area.y + area.h > 100) {
              fail("writing-tasks.json", `${task.id} has a plan block that falls outside the drawing`);
              break;
            }
          }
          if (Array.isArray(figure.markers) && figure.markers.length > 0) {
            // Letters are for choosing between, and nothing is chosen here.
            fail("writing-tasks.json", `${task.id} puts lettered markers on a plan that is only described`);
          }
        }
      }
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
  for (const topic of speaking.part1 ?? []) {
    checkLevel("speaking-topics.json", topic, `part 1 topic "${topic.topic}"`);
  }
  for (const card of speaking.part2 ?? []) {
    if (!card.cueCard) fail("speaking-topics.json", `${card.id} has no cue card`);
    if ((card.bullets ?? []).length !== 4) {
      fail("speaking-topics.json", `${card.id} needs exactly four bullet points`);
    }
    checkLevel("speaking-topics.json", card, card.id ?? "a cue card");
  }
  // Part 3 extends the Part 2 topic, so every set needs a card to follow.
  const cardTopics = new Set((speaking.part2 ?? []).map((c) => c.topic));
  for (const set of speaking.part3 ?? []) {
    if (!cardTopics.has(set.topic)) {
      fail("speaking-topics.json", `part 3 topic "${set.topic}" has no matching cue card`);
    }
    checkLevel("speaking-topics.json", set, `part 3 topic "${set.topic}"`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) in the content bank:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Content bank OK: every answer key is reachable and well formed.");
