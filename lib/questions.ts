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
 * Every set as blocks.
 *
 * A flat list becomes a single block with no rubric of its own, which is what
 * lets the renderer have one code path instead of two.
 */
export function toGroups(set: QuestionSet): QuestionGroup[] {
  if (isGrouped(set)) return set;
  return [{ instruction: "", questions: set as TestQuestion[] }];
}

/** Every question in order, blocks flattened away. */
export function flatQuestions(set: QuestionSet): TestQuestion[] {
  if (!isGrouped(set)) return set as TestQuestion[];
  return set.flatMap((group) => group.questions);
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
 */
export function numberedGroups(set: QuestionSet): NumberedGroup[] {
  let next = 1;
  return toGroups(set).map((group) => {
    const questions = group.questions.map((question) => ({ question, number: next++ }));
    return {
      group,
      questions,
      from: questions[0]?.number ?? next,
      to: questions[questions.length - 1]?.number ?? next,
    };
  });
}
