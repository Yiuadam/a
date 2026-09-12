import { isCorrect, rawToBand } from "@/lib/band";
import type { TestQuestion } from "@/lib/types";

/*
  What a marked sitting says about the candidate, past the band.

  ---------------------------------------------------------------------------
  Why every suggestion here is counted rather than written

  The easy version of "what to work on" is a paragraph chosen by band: skim
  faster, read the questions first, practise every day. It can be written
  before the candidate sits down, it is the same for everybody who lands on the
  same number, and somebody who has just spent two and three-quarter hours on a
  paper can tell.

  So nothing is said here unless this sitting said it. Every observation is a
  count of the candidate's own marks — this question type, this part of the
  paper, these blanks — and the only prose attached to one is the habit that
  fixes that particular task. Where the marks do not gather anywhere, this
  module returns nothing and the screen says so, because a report that admits
  it found no pattern is worth more than one that invents a pattern to fill the
  space with.

  ---------------------------------------------------------------------------
  What counts as a pattern

  A group is worth naming only when it is worse than the rest of the same
  paper. A candidate at band 5 gets roughly half of everything wrong, and
  listing every question type they dropped marks on would be their band read
  back to them in six lines — true, useless, and indistinguishable from the
  generic advice this exists to avoid. The comparison is against the rest of
  the module rather than against the whole of it, so a group is never measured
  against an average it is itself dragging down.

  The floors underneath that — four questions in the group, two marks lost —
  are there because a contrast drawn across three questions is not a contrast.
  It is one unlucky guess.
*/

/** One paper inside a module, as the candidate met it. */
export interface SittingPaper {
  /** "Part 1", "Passage 2" — what the exam calls it. */
  label: string;
  title: string;
  /** Renamed for the sitting, so the ids match the stored answers. */
  questions: TestQuestion[];
}

export interface MarkedQuestion {
  id: string;
  type: TestQuestion["type"];
  /** Which paper of the module this question belongs to, by index. */
  paper: number;
  correct: boolean;
  /** False for a question left empty, which is not the same as a wrong guess. */
  answered: boolean;
}

/** A score out of a group of questions, named for the candidate. */
export interface Tally {
  key: string;
  label: string;
  right: number;
  total: number;
}

/**
 * An observation, and the habit that answers it.
 *
 * `fact` is arithmetic on the candidate's own paper and is always safe to
 * print. `fix` is the one thing that reliably fixes that task, and it is
 * attached only where a fact named a specific question type or a specific part
 * of the paper — never on its own.
 */
export interface Observation {
  id: string;
  fact: string;
  fix?: string;
}

export const QUESTION_TYPE_NAMES: Record<TestQuestion["type"], string> = {
  tfng: "True / False / Not Given",
  ynng: "Yes / No / Not Given",
  mcq: "Multiple choice",
  "multi-select": "Multiple choice (more than one answer)",
  matching: "Matching",
  completion: "Sentence completion",
  "short-answer": "Short answer",
};

/*
  The single habit that recovers most of the marks lost on each task.

  Written for somebody whose English is the thing being taught: short
  sentences, no grammar vocabulary, and each one describes an action to take on
  the paper rather than a quality to acquire.
*/
const TYPE_FIX: Record<TestQuestion["type"], string> = {
  tfng:
    "NOT GIVEN means the passage does not say. Choose FALSE only when the passage says the opposite. If you are hunting for the sentence that disagrees and cannot find it, that is usually NOT GIVEN.",
  ynng:
    "These ask what the writer thinks, not what is true. Look for the words that carry an opinion — believes, argues, unfortunately — and answer from those.",
  mcq:
    "Find the line in the text that answers the question before you read the options. Wrong options are written to sound like the text, so an option that feels familiar is not evidence.",
  "multi-select":
    "Choose exactly the number of letters asked for. Ticking one extra loses every mark in the group, so if you are unsure, drop your least confident letter rather than add another.",
  completion:
    "Copy the word from the text exactly as it is written, and count the words the instruction allows. A right answer one word too long is marked wrong.",
  matching:
    "Read the whole paragraph before you choose. The answer has to cover all of it, not only the sentence that shares a word with it.",
  "short-answer":
    "Answer in the words of the text and stay inside the word limit. Extra words you added yourself are what turns a correct answer into a lost mark.",
};

/*
  A habit tied to the shape of the module rather than to a question type, for
  the case where the marks gather in one part of the paper. Both are facts
  about how the exam is built, so neither becomes untrue for a particular
  candidate.
*/
const SECTION_FIX: Record<"listening" | "reading", string> = {
  listening:
    "You hear each part once, and the questions come in the same order as the recording. Read the questions for a part before it starts, and if you miss one, go to the next question rather than staying with the one that has gone.",
  reading:
    "The three passages carry roughly the same number of marks, so the minutes you spend on one are minutes taken from another. The last passage is the hardest, which is what makes finishing the first two quickly worth doing.",
};

const BLANK_FIX: Record<"listening" | "reading", string> = {
  listening:
    "The recording does not wait. When you miss an answer, write anything and move on — a guess costs nothing, and staying behind costs the questions that follow.",
  reading:
    "An empty box and a wrong answer score the same, so fill in every question before the time ends, even where you are guessing.",
};

/* Below four questions a group is too small for a share to mean anything. */
const MIN_GROUP = 4;
/* One mistake is a mistake. Two is the smallest thing that can be a pattern. */
const MIN_WRONG = 2;
/* How much worse than the rest of the paper a group has to be to be named. */
const CONTRAST = 0.25;

/** Mark one module's papers against the answers the candidate gave. */
export function markPapers(
  papers: SittingPaper[],
  answers: Record<string, string | number | undefined>,
): MarkedQuestion[] {
  return papers.flatMap((paper, index) =>
    paper.questions.map((q) => {
      const given = answers[q.id];
      return {
        id: q.id,
        type: q.type,
        paper: index,
        correct: isCorrect(q, given),
        answered: given !== undefined && given !== "",
      };
    }),
  );
}

export function talliesByPaper(marked: MarkedQuestion[], papers: SittingPaper[]): Tally[] {
  return papers.map((paper, index) => {
    const mine = marked.filter((m) => m.paper === index);
    return {
      key: `paper-${index}`,
      label: paper.label,
      right: mine.filter((m) => m.correct).length,
      total: mine.length,
    };
  });
}

/**
 * Scores by question type, in the order the types first appear in the paper.
 *
 * Ordered by the paper rather than alphabetically or by score, so the table
 * reads in the same direction as the sitting the candidate remembers.
 */
export function talliesByType(marked: MarkedQuestion[]): Tally[] {
  const order: TestQuestion["type"][] = [];
  for (const m of marked) if (!order.includes(m.type)) order.push(m.type);
  return order.map((type) => {
    const mine = marked.filter((m) => m.type === type);
    return {
      key: type,
      label: QUESTION_TYPE_NAMES[type],
      right: mine.filter((m) => m.correct).length,
      total: mine.length,
    };
  });
}

/**
 * How many more marks this paper needed for the next half band.
 *
 * The reason a raw score is printed beside every band. Two candidates on band
 * 7 can be one mark and six marks away from 7.5, and only one of them should
 * be told the next half band is within reach of a single question.
 *
 * Walks the conversion table by asking it rather than reading it, so it cannot
 * disagree with `rawToBand` — including about the scaling `rawToBand` applies
 * when a paper is not exactly forty questions long.
 */
export function marksToNextBand(
  raw: number,
  total: number,
  module: "listening" | "reading",
): { marks: number; band: number } | null {
  const current = rawToBand(raw, total, module);
  for (let next = raw + 1; next <= total; next++) {
    const band = rawToBand(next, total, module);
    if (band > current) return { marks: next - raw, band };
  }
  return null;
}

function share(wrong: number, total: number): number {
  return total > 0 ? wrong / total : 0;
}

/**
 * How much worse this group is than everything outside it, or null when there
 * is nothing outside it to compare against.
 */
function contrast(
  groupWrong: number,
  groupTotal: number,
  allWrong: number,
  allTotal: number,
): number | null {
  const restTotal = allTotal - groupTotal;
  if (restTotal === 0) return null;
  return share(groupWrong, groupTotal) - share(allWrong - groupWrong, restTotal);
}

interface Group {
  key: string;
  label: string;
  wrong: number;
  total: number;
  gap: number;
}

function notableGroups(tallies: Tally[], allWrong: number, allTotal: number): Group[] {
  const groups: Group[] = [];
  for (const t of tallies) {
    const wrong = t.total - t.right;
    const gap = contrast(wrong, t.total, allWrong, allTotal);
    if (gap === null) continue;
    if (t.total < MIN_GROUP || wrong < MIN_WRONG || gap < CONTRAST) continue;
    groups.push({ key: t.key, label: t.label, wrong, total: t.total, gap });
  }
  return groups.sort((a, b) => b.gap - a.gap);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Everything this module's marks will support saying, and nothing else.
 *
 * The order is deliberate: a question type is the most actionable thing a
 * candidate can be told, a part of the paper is next, and blanks are last
 * because they are about the clock rather than about English.
 */
export function observations(
  module: "listening" | "reading",
  marked: MarkedQuestion[],
  papers: SittingPaper[],
): Observation[] {
  if (marked.length === 0) return [];
  const wrong = marked.filter((m) => !m.correct).length;
  if (wrong === 0) return [];

  const out: Observation[] = [];

  /*
    Two question types at most. A third is either a real third weakness — in
    which case the candidate's problem is the paper rather than a task — or it
    is the list padding itself out, and neither is worth a line.
  */
  for (const group of notableGroups(talliesByType(marked), wrong, marked.length).slice(0, 2)) {
    out.push({
      id: `type-${group.key}`,
      fact: `${group.label} cost you ${group.wrong} of its ${group.total} marks. You got ${
        marked.length - group.total - (wrong - group.wrong)
      } of the other ${marked.length - group.total} right.`,
      fix: TYPE_FIX[group.key as TestQuestion["type"]],
    });
  }

  const worstPaper = notableGroups(talliesByPaper(marked, papers), wrong, marked.length)[0];
  if (worstPaper) {
    out.push({
      id: `paper-${worstPaper.key}`,
      fact: `${worstPaper.label} cost you ${worstPaper.wrong} of its ${worstPaper.total} marks, against ${
        wrong - worstPaper.wrong
      } across the rest of the paper.`,
      fix: SECTION_FIX[module],
    });
  }

  /*
    Blanks are counted rather than inferred from being wrong, because they are
    a different failure with a different repair: a wrong answer is English, an
    empty box is the clock or a lost place in the recording. Where most of them
    fall in the last part of the paper, that is said too — but only where they
    actually do.
  */
  const blanks = marked.filter((m) => !m.answered);
  if (blanks.length >= MIN_WRONG) {
    const last = papers.length - 1;
    const inLast = blanks.filter((b) => b.paper === last).length;
    const trailing = last >= 0 && inLast >= 2 && inLast * 2 >= blanks.length;
    out.push({
      id: "blanks",
      fact: `You left ${blanks.length} ${plural(blanks.length, "question", "questions")} empty${
        trailing ? `, ${inLast} of them in ${papers[last].label}` : ""
      }.`,
      fix: BLANK_FIX[module],
    });
  }

  return out;
}
