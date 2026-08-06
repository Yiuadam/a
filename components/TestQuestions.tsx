"use client";

import ExplainText from "@/components/ExplainText";
import { isCorrect } from "@/lib/band";
import type { TestQuestion } from "@/lib/types";

export type AnswerMap = Record<string, string | number | undefined>;
/** Ids the learner has asked to have marked before submitting. */
export type CheckedMap = Record<string, true | undefined>;

function answerText(q: TestQuestion): string {
  return q.type === "mcq"
    ? `${String.fromCharCode(65 + q.answer)}. ${q.options[q.answer]}`
    : q.answer;
}

export default function TestQuestions({
  questions,
  answers,
  onAnswer,
  submitted,
  checked = {},
  onCheck,
}: {
  questions: TestQuestion[];
  answers: AnswerMap;
  onAnswer: (id: string, value: string | number) => void;
  submitted: boolean;
  checked?: CheckedMap;
  /** Omit to hide the per-question check button entirely. */
  onCheck?: (id: string) => void;
}) {
  return (
    <ol className="space-y-5" data-lookupable>
      {questions.map((q, i) => {
        const given = answers[q.id];
        // A checked question is locked, so its verdict is final either way.
        const revealed = submitted || checked[q.id] === true;
        const correct = revealed ? isCorrect(q, given) : undefined;
        const answered = given !== undefined && given !== "";
        return (
          <li
            key={q.id}
            className={`card ${
              revealed
                ? correct
                  ? "border-emerald-300 bg-emerald-50/50"
                  : "border-rose-300 bg-rose-50/50"
                : ""
            }`}
          >
            <div className="mb-3 flex items-start gap-2 text-sm font-medium text-slate-800">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-600">
                {i + 1}
              </span>
              <span>
                {q.type === "tfng" && q.statement}
                {q.type === "mcq" && q.question}
                {q.type === "completion" && (
                  <>
                    {q.sentence}
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      (max {q.maxWords} word{q.maxWords > 1 ? "s" : ""})
                    </span>
                  </>
                )}
              </span>
            </div>

            {q.type === "tfng" && (
              <div className="flex flex-wrap gap-2">
                {(["TRUE", "FALSE", "NOT GIVEN"] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    disabled={revealed}
                    onClick={() => onAnswer(q.id, opt)}
                    className={`btn border text-xs ${
                      given === opt
                        ? "border-indigo-600 bg-indigo-600 text-accent-fg"
                        : "border-slate-300 bg-surface text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {q.type === "mcq" && (
              <div className="space-y-2">
                {q.options.map((opt, idx) => (
                  <label
                    key={idx}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                      given === idx
                        ? "border-indigo-500 bg-indigo-50"
                        : "border-slate-200 bg-surface hover:bg-slate-50"
                    } ${revealed ? "cursor-default" : ""}`}
                  >
                    <input
                      type="radio"
                      name={q.id}
                      checked={given === idx}
                      disabled={revealed}
                      onChange={() => onAnswer(q.id, idx)}
                      className="accent-indigo-600"
                    />
                    <span className="text-slate-700">
                      <span className="mr-1 font-medium">{String.fromCharCode(65 + idx)}.</span>
                      {opt}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {q.type === "completion" && (
              <input
                type="text"
                value={(given as string) ?? ""}
                disabled={revealed}
                onChange={(e) => onAnswer(q.id, e.target.value)}
                placeholder="Type your answer"
                className="input w-full max-w-sm"
              />
            )}

            {/*
              Marking one question mid-test is how people actually learn from a
              practice paper: you find out you have misread a question type
              while the passage is still fresh, rather than twenty questions
              later. Checking locks that answer, so the band stays honest.
            */}
            {!submitted && onCheck && !revealed && (
              <button
                type="button"
                onClick={() => onCheck(q.id)}
                disabled={!answered}
                className="mt-3 text-xs font-medium text-indigo-600 underline underline-offset-4 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
              >
                {answered ? "Check this answer" : "Answer it to check"}
              </button>
            )}

            {revealed && (
              <div className="mt-3 space-y-2">
                <p
                  className={`text-sm font-medium ${
                    correct ? "text-emerald-700" : "text-rose-700"
                  }`}
                >
                  {correct ? "✓ Correct" : `✗ Answer: ${answerText(q)}`}
                </p>
                {q.explanation && (
                  <ExplainText
                    text={q.explanation}
                    className="block text-sm leading-relaxed text-slate-600"
                  />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
