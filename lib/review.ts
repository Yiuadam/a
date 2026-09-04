import type { ReviewItem } from "@/components/Review";
import { isCorrect } from "./band";
import { flatQuestions } from "./questions";
import type { QuestionSet, TestQuestion } from "./types";

const TYPE_LABEL: Record<TestQuestion["type"], string> = {
  tfng: "true / false / not given",
  mcq: "multiple choice",
  // Named apart from plain "multiple choice" on purpose: it is marked by a
  // different rule (more than one mark, zero for choosing too many), and a
  // learner reviewing a mistake needs to see which task actually cost them.
  "multi-select": "multiple choice — choose more than one",
  completion: "sentence completion",
  // Named apart from true/false on purpose: a learner reviewing a mistake
  // needs to see which of the two tasks they were actually doing.
  ynng: "yes / no / not given",
  matching: "matching",
  "short-answer": "short answer",
};

/**
 * The question types a paper actually contains, named for a candidate.
 *
 * The reading page used to state its three types in hardcoded prose. That was
 * true of every paper in the bank until one arrived with matching headings in
 * it, at which point the sentence became a confident lie on the screen the
 * candidate reads before starting. Deriving it means the sentence cannot
 * disagree with the paper again.
 */
export function questionTypeNames(questions: QuestionSet): string[] {
  const seen = new Set<TestQuestion["type"]>();
  for (const q of flatQuestions(questions)) seen.add(q.type);
  // A stable order, so the sentence does not reshuffle between papers.
  const order: TestQuestion["type"][] = [
    "mcq",
    "multi-select",
    "tfng",
    "ynng",
    "matching",
    "completion",
    "short-answer",
  ];
  return order.filter((t) => seen.has(t)).map((t) => TYPE_LABEL[t]);
}

/** "a, b and c" — the Oxford-comma-free list English prose actually uses. */
export function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function prompt(q: TestQuestion): string {
  switch (q.type) {
    case "tfng":
    case "ynng":
      return q.statement;
    case "mcq":
    case "multi-select":
    case "short-answer":
      return q.question;
    case "matching":
      return q.prompt;
    case "completion":
      return q.sentence;
  }
}

/** A multi-select answer's stored indices, back into the letters a learner recognises. */
function letters(q: { options: string[] }, indices: number[]): string {
  return indices
    .map((idx) => `${String.fromCharCode(65 + idx)}. ${q.options[idx] ?? "?"}`)
    .join("; ");
}

function shown(q: TestQuestion, value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  if (q.type === "mcq") {
    const idx = Number(value);
    return q.options[idx] ?? String(value);
  }
  if (q.type === "multi-select") {
    const chosen = String(value)
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n));
    // Falls back to the raw stored value on a malformed answer rather than
    // showing nothing, which would read as "left blank" to a learner who did
    // in fact answer.
    return chosen.length > 0 ? letters(q, chosen) : String(value);
  }
  return String(value);
}

/** The questions a learner got wrong, packaged for the post-test review. */
export function buildReview(
  questions: QuestionSet,
  answers: Record<string, string | number | undefined>,
): ReviewItem[] {
  return flatQuestions(questions)
    .filter((q) => !isCorrect(q, answers[q.id]))
    .map((q) => ({
      id: q.id,
      prompt: prompt(q),
      yourAnswer: shown(q, answers[q.id]),
      correctAnswer:
        q.type === "mcq"
          ? q.options[q.answer]
          : q.type === "multi-select"
            ? letters(q, q.answer)
            : String(q.answer),
      explanation: q.explanation,
      tag: TYPE_LABEL[q.type],
    }));
}
