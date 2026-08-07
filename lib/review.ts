import type { ReviewItem } from "@/components/Review";
import { isCorrect } from "./band";
import { flatQuestions } from "./questions";
import type { QuestionSet, TestQuestion } from "./types";

const TYPE_LABEL: Record<TestQuestion["type"], string> = {
  tfng: "true / false / not given",
  mcq: "multiple choice",
  completion: "sentence completion",
};

function prompt(q: TestQuestion): string {
  if (q.type === "tfng") return q.statement;
  if (q.type === "mcq") return q.question;
  return q.sentence;
}

function shown(q: TestQuestion, value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  if (q.type === "mcq") {
    const idx = Number(value);
    return q.options[idx] ?? String(value);
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
        q.type === "mcq" ? q.options[q.answer] : String(q.answer),
      explanation: q.explanation,
      tag: TYPE_LABEL[q.type],
    }));
}
