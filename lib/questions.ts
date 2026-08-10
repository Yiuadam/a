import type { QuestionGroup, QuestionSet, TestQuestion } from "./types";

/*
  A paper's questions arrive in one of two shapes — a flat list, or blocks with
  a shared rubric — and nothing downstream should have to care which. These
  helpers normalise at the boundary so scoring, review, advice and the
  validator all work on the same thing.
*/

/** True for a block, false for a bare question. */
function isGroup(item: TestQuestion | QuestionGroup): item is QuestionGroup {
  // A question never carries a `questions` field, so its presence is decisive.
  return "questions" in item && Array.isArray((item as QuestionGroup).questions);
}

/** Whether a set is already grouped. Empty sets count as flat. */
export function isGrouped(set: QuestionSet): set is QuestionGroup[] {
  return set.length > 0 && isGroup(set[0]);
}

/**
 * Every set as blocks, in order.
 *
 * A flat list becomes a single block with no rubric of its own, which is what
 * lets the renderer have one code path instead of two.
 *
 * Each entry is classified on its own rather than the whole array being judged
 * by its first element. The type forbids mixing the two, and the validator
 * rejects it in CI, but hand-authored JSON is how every question type from here
 * on arrives — and a stray bare question among the blocks should render as
 * itself rather than crash the page while its author waits for CI to explain
 * why. Consecutive loose questions collect into one block, so order is kept.
 */
export function toGroups(set: QuestionSet): QuestionGroup[] {
  const out: QuestionGroup[] = [];
  let loose: TestQuestion[] | null = null;

  for (const item of set as Array<TestQuestion | QuestionGroup>) {
    if (isGroup(item)) {
      loose = null;
      out.push(item);
    } else {
      if (!loose) {
        loose = [];
        out.push({ instruction: "", questions: loose });
      }
      loose.push(item);
    }
  }

  // An empty paper still needs a block, so the renderer has something to map.
  return out.length > 0 ? out : [{ instruction: "", questions: [] }];
}

/** Every question in order, blocks flattened away. */
export function flatQuestions(set: QuestionSet): TestQuestion[] {
  return toGroups(set).flatMap((group) => group.questions);
}

/** How many questions a paper asks, however it is arranged. */
export function questionCount(set: QuestionSet): number {
  return flatQuestions(set).length;
}

export interface NumberedQuestion {
  question: TestQuestion;
  /** Position in the paper as a whole, starting at 1. */
  number: number;
}

export interface NumberedGroup {
  group: QuestionGroup;
  questions: NumberedQuestion[];
  /** Inclusive range this block covers, for a "Questions 14-19" heading. */
  from: number;
  to: number;
}

/**
 * Blocks with their questions numbered continuously across the whole paper.
 *
 * IELTS numbers 1-40 straight through a paper regardless of how many blocks it
 * is divided into, and candidates transfer those numbers to an answer sheet.
 * Restarting the count at each block would be a quiet fidelity bug: the
 * on-screen number would stop matching the number the question is known by.
 *
 * `from` exists because the mock exam's papers are not the exam's papers. A
 * sitting's listening module is four recordings and its reading module three
 * passages, each a separate `ReadingTest`/`ListeningTest` in this app and each
 * numbered 1-13 on its own — but the candidate is sitting one paper numbered
 * 1-40, and the second passage starts at 14. Without this the palette shows
 * three questions called 1 and a candidate who says "I'm stuck on 23" is
 * talking about a number that appears nowhere.
 */
export function numberedGroups(set: QuestionSet, from = 1): NumberedGroup[] {
  let next = from;
  return toGroups(set).map((group) => {
    const questions = group.questions.map((question) => ({ question, number: next++ }));
    // An empty block owns no numbers at all. Reporting `next` would claim the
    // number the following block is about to use, and print it as a heading.
    return {
      group,
      questions,
      from: questions[0]?.number ?? 0,
      to: questions[questions.length - 1]?.number ?? 0,
    };
  });
}
