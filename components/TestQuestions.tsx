"use client";

import type { TestQuestion } from "@/lib/types";
import { isCorrect } from "@/lib/band";

export type AnswerMap = Record<string, string | number | undefined>;

export default function TestQuestions({
  questions,
  answers,
  onAnswer,
  submitted,
}: {
  questions: TestQuestion[];
  answers: AnswerMap;
  onAnswer: (id: string, value: string | number) => void;
  submitted: boolean;
}) {
  return (
    <ol className="space-y-5">
      {questions.map((q, i) => {
        const given = answers[q.id];
        const correct = submitted ? isCorrect(q, given) : undefined;
        return (
          <li
            key={q.id}
            className={`card ${
              submitted
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
                    disabled={submitted}
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
                    } ${submitted ? "cursor-default" : ""}`}
                  >
                    <input
                      type="radio"
                      name={q.id}
                      checked={given === idx}
                      disabled={submitted}
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
                disabled={submitted}
                onChange={(e) => onAnswer(q.id, e.target.value)}
                placeholder="Type your answer"
                className="input w-full max-w-sm"
              />
            )}

            {submitted && !correct && (
              <p className="mt-3 text-sm text-rose-700">
                Correct answer:{" "}
                <span className="font-semibold">
                  {q.type === "mcq"
                    ? `${String.fromCharCode(65 + q.answer)}. ${q.options[q.answer]}`
                    : q.answer}
                </span>
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
