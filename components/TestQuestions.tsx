"use client";

import type { ReactNode } from "react";
import ExplainText from "@/components/ExplainText";
import { isCorrect, marksEarned } from "@/lib/band";
import { numberedGroups } from "@/lib/questions";
import type { QuestionSet, SharedOption, TestMode, TestQuestion } from "@/lib/types";

export type AnswerMap = Record<string, string | number | undefined>;
/** Ids the learner has asked to have marked before submitting. */
export type CheckedMap = Record<string, true | undefined>;

type Given = string | number | undefined;

/**
 * The option indices a candidate has ticked for a multi-select question,
 * decoded from the comma-joined string its answer is stored as.
 *
 * `AnswerMap` holds one `string | number` per question id, which has nowhere
 * to put more than one tick mark on its own — so a multi-select's live
 * selection is kept as a sorted, comma-joined string of option indices, and
 * this is the one place that reading is done. `lib/band.ts` decodes the same
 * string independently for marking; both have to read a stored answer the
 * same way, which is why this stays a plain parse rather than growing rules
 * of its own.
 */
function chosenIndices(given: Given): number[] {
  if (given === undefined || given === "") return [];
  return String(given)
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

/**
 * The branch reached only if a question type has no case above.
 *
 * The parameter is typed `never`, so the call compiles only while every member
 * of the union has been handled — add a type to `TestQuestion` without a case
 * and the build fails here. That is the whole point: the guard chains this
 * replaced would render an empty card for an unhandled type and TypeScript
 * would not say a word.
 */
function unhandledType(question: never): ReactNode {
  const type = (question as { type?: string }).type ?? "unknown";
  return (
    <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
      This question could not be displayed (type: {type}). Please report it.
    </p>
  );
}

function answerText(q: TestQuestion, options?: SharedOption[]): string {
  if (q.type === "mcq") return `${String.fromCharCode(65 + q.answer)}. ${q.options[q.answer]}`;
  if (q.type === "multi-select") {
    return q.answer
      .map((idx) => `${String.fromCharCode(65 + idx)}. ${q.options[idx]}`)
      .join("; ");
  }
  if (q.type === "matching") {
    /*
      A revealed answer of "vii" teaches nothing once the heading list has
      scrolled off, so the key is expanded back into the thing it stood for.
    */
    const match = options?.find((o) => o.key.toUpperCase() === q.answer.toUpperCase());
    return match ? `${match.key}. ${match.text}` : q.answer;
  }
  if (q.type === "short-answer" && q.accept?.length) {
    return `${q.answer} (also accepted: ${q.accept.join(", ")})`;
  }
  return q.answer;
}

/** The prompt shown above the inputs, whatever kind of question it is. */
function QuestionPrompt({ q }: { q: TestQuestion }) {
  switch (q.type) {
    case "tfng":
    case "ynng":
      return <>{q.statement}</>;
    case "mcq":
      return <>{q.question}</>;
    case "multi-select":
      return (
        <>
          {q.question}
          <span className="ml-2 text-xs font-normal text-slate-400">
            (choose {q.numAnswers})
          </span>
        </>
      );
    case "matching":
      return <>{q.prompt}</>;
    case "short-answer":
      return (
        <>
          {q.question}
          <span className="ml-2 text-xs font-normal text-slate-400">
            (max {q.maxWords} word{q.maxWords > 1 ? "s" : ""})
          </span>
        </>
      );
    case "completion":
      return (
        <>
          {q.sentence}
          <span className="ml-2 text-xs font-normal text-slate-400">
            (max {q.maxWords} word{q.maxWords > 1 ? "s" : ""})
          </span>
        </>
      );
    default:
      return <>{unhandledType(q)}</>;
  }
}

/** The controls a candidate answers with. */
function QuestionInput({
  q,
  given,
  locked,
  onAnswer,
  sharedOptions,
}: {
  q: TestQuestion;
  given: Given;
  locked: boolean;
  onAnswer: (id: string, value: string | number) => void;
  /* Matching answers come from the block's bank, not from the question. */
  sharedOptions?: SharedOption[];
}) {
  switch (q.type) {
    case "tfng":
    case "ynng":
      return (
        <div className="flex flex-wrap gap-2">
          {(q.type === "ynng"
            ? (["YES", "NO", "NOT GIVEN"] as const)
            : (["TRUE", "FALSE", "NOT GIVEN"] as const)
          ).map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={locked}
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
      );

    case "mcq":
      return (
        <div className="space-y-2">
          {q.options.map((opt, idx) => (
            <label
              key={idx}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                given === idx
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-slate-200 bg-surface hover:bg-slate-50"
              } ${locked ? "cursor-default" : ""}`}
            >
              <input
                type="radio"
                name={q.id}
                checked={given === idx}
                disabled={locked}
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
      );

    case "multi-select": {
      const chosen = chosenIndices(given);
      const toggle = (idx: number) => {
        const next = chosen.includes(idx) ? chosen.filter((i) => i !== idx) : [...chosen, idx];
        /*
          Sorted before it is stored, so "B then D" and "D then B" become the
          same string. Order is not part of the answer — the group scores B,D
          exactly as it scores D,B — and a stored value that varied with tick
          order would make two identical answers compare unequal everywhere
          downstream that reads it back rather than only where it is marked.
        */
        onAnswer(q.id, [...next].sort((a, b) => a - b).join(","));
      };
      return (
        <div className="space-y-2">
          {/*
            Never disabled past the limit. The real exam's rule is that
            choosing more letters than asked for scores zero for the whole
            group — not that a candidate is physically stopped from doing it —
            and blocking the tick here would make that rule impossible to
            meet in practice, which is the one place meeting it costs nothing.
            The count below is the running warning a paper answer sheet
            cannot give.
          */}
          <p
            className={`text-xs font-medium ${
              chosen.length > q.numAnswers ? "text-rose-600" : "text-slate-400"
            }`}
          >
            {chosen.length} of {q.numAnswers} chosen
            {chosen.length > q.numAnswers
              ? " — more than this scores zero for the whole group"
              : ""}
          </p>
          {q.options.map((opt, idx) => {
            const isChecked = chosen.includes(idx);
            const isKey = q.answer.includes(idx);
            /*
              Once revealed, a correct letter is shown in green whether or not
              it was ticked — a missed correct letter is exactly what a
              candidate needs to see — and a ticked wrong letter is shown in
              rose. Untouched wrong letters stay neutral; there is nothing to
              say about an option nobody chose and that was never going to be
              right.
            */
            const cls = locked
              ? isKey
                ? "border-emerald-400 bg-emerald-50"
                : isChecked
                  ? "border-rose-400 bg-rose-50"
                  : "border-slate-200 bg-surface"
              : isChecked
                ? "border-indigo-500 bg-indigo-50"
                : "border-slate-200 bg-surface hover:bg-slate-50";
            return (
              <label
                key={idx}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${cls} ${
                  locked ? "cursor-default" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={locked}
                  onChange={() => toggle(idx)}
                  className="accent-indigo-600"
                />
                <span className="text-slate-700">
                  <span className="mr-1 font-medium">{String.fromCharCode(65 + idx)}.</span>
                  {opt}
                </span>
              </label>
            );
          })}
        </div>
      );
    }

    case "completion":
    case "short-answer":
      return (
        <input
          type="text"
          value={(given as string) ?? ""}
          disabled={locked}
          onChange={(e) => onAnswer(q.id, e.target.value)}
          placeholder="Type your answer"
          className="input w-full max-w-sm"
        />
      );

    case "matching":
      /*
        Buttons rather than a text field. The bank is printed above the block,
        and a candidate who has to retype "vii" loses marks to typing rather
        than to reading — which measures the wrong thing.

        Deliberately not disabled once used elsewhere in the block: some
        matching tasks reuse an option and some do not, the rubric says which,
        and a UI that enforced the stricter rule everywhere would silently make
        the looser tasks unanswerable.
      */
      return (
        <div className="flex flex-wrap gap-2">
          {(sharedOptions ?? []).map((opt) => (
            <button
              key={opt.key}
              type="button"
              disabled={locked}
              onClick={() => onAnswer(q.id, opt.key)}
              title={opt.text}
              className={`btn border text-xs ${
                String(given).toUpperCase() === opt.key.toUpperCase()
                  ? "border-indigo-600 bg-indigo-600 text-accent-fg"
                  : "border-slate-300 bg-surface text-slate-700 hover:bg-slate-50"
              }`}
            >
              {opt.key}
            </button>
          ))}
        </div>
      );

    default:
      return unhandledType(q);
  }
}

export default function TestQuestions({
  questions,
  answers,
  onAnswer,
  submitted,
  checked = {},
  onCheck,
  mode = "practice",
  startNumber = 1,
}: {
  questions: QuestionSet;
  answers: AnswerMap;
  onAnswer: (id: string, value: string | number) => void;
  submitted: boolean;
  checked?: CheckedMap;
  /** Omit to hide the per-question check button entirely. */
  onCheck?: (id: string) => void;
  /** Practice reveals as you go; the exam reveals nothing until it ends. */
  mode?: TestMode;
  /**
   * What to call this paper's first question.
   *
   * 1 everywhere except inside a mock sitting, where four listening recordings
   * or three reading passages are rendered one after another as a single
   * 40-question paper. See `numberedGroups`.
   */
  startNumber?: number;
}) {
  const groups = numberedGroups(questions, startNumber);
  const practising = mode === "practice";

  return (
    <div className="space-y-6" data-lookupable>
      {groups.map((block, blockIndex) => (
        <section key={blockIndex} className="space-y-5">
          {/*
            A block's rubric and its bank of answers are printed once above it,
            as the paper does. A flat test has neither, and renders nothing here.
          */}
          {(block.group.instruction || block.group.sharedOptions) && (
            <div className="card border-indigo-200 bg-indigo-50/40">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                {block.to > block.from
                  ? `Questions ${block.from}–${block.to}`
                  : `Question ${block.from}`}
              </p>
              {block.group.instruction && (
                <p className="mt-1 text-sm leading-6 text-slate-700">
                  {block.group.instruction}
                </p>
              )}
              {block.group.sharedOptions && (
                <ul className="mt-3 space-y-1">
                  {block.group.sharedOptions.map((opt) => (
                    <li key={opt.key} className="text-sm leading-6 text-slate-700">
                      <span className="mr-2 font-semibold text-slate-900">{opt.key}</span>
                      {opt.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <ol className="space-y-5">
            {block.questions.map(({ question: q, number, to }) => {
              const given = answers[q.id];
              /*
                A checked question is locked, so its verdict is final. In exam
                mode `checked` is never populated, and the guard is repeated
                here rather than trusted: nothing may be revealed early because
                of a stray entry left over from a practice run.
              */
              const revealed = submitted || (practising && checked[q.id] === true);
              const correct = revealed ? isCorrect(q, given) : undefined;
              const answered = given !== undefined && given !== "";

              return (
                <li
                  key={q.id}
                  /*
                    The anchor the exam palette scrolls to. Clicking 23 along
                    the bottom of the screen has to land on question 23, and the
                    palette has no other way to find it — see
                    lib/exam/navigation.ts.
                  */
                  data-question-id={q.id}
                  className={`card ${
                    revealed
                      ? correct
                        ? "border-emerald-300 bg-emerald-50/50"
                        : "border-rose-300 bg-rose-50/50"
                      : ""
                  }`}
                >
                  <div className="mb-3 flex items-start gap-2 text-sm font-medium text-slate-800">
                    {/*
                      A wider pill rather than the usual circle whenever a
                      question claims more than one number — a multi-select's
                      single prompt is "Questions 15 and 16" on the real paper,
                      and a badge that could only ever hold one digit would
                      quietly drop the second number the candidate is meant to
                      write an answer against.
                    */}
                    <span
                      className={`mt-0.5 flex h-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-600 ${
                        to > number ? "w-auto min-w-6 px-1.5" : "w-6"
                      }`}
                    >
                      {to > number ? `${number}–${to}` : number}
                    </span>
                    <span>
                      <QuestionPrompt q={q} />
                    </span>
                  </div>

                  <QuestionInput
                    q={q}
                    given={given}
                    locked={revealed}
                    onAnswer={onAnswer}
                    sharedOptions={block.group.sharedOptions}
                  />

                  {/*
                    Marking one question mid-test is how people actually learn
                    from a practice paper: you find out you have misread a
                    question type while the passage is still fresh. It has no
                    place in a sitting being used to measure anything, so under
                    exam mode the control is not rendered at all.
                  */}
                  {practising && !submitted && onCheck && !revealed && (
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
                        {correct ? "✓ Correct" : `✗ Answer: ${answerText(q, block.group.sharedOptions)}`}
                      </p>
                      {/*
                        A multi-select that is not fully correct still earned
                        some of its two or three marks unless it was
                        over-selected, and "✗" alone would read as "zero"
                        either way. This is the one place that difference is
                        shown — nowhere else can a single question earn more
                        than one mark or less than all of it.
                      */}
                      {!correct && q.type === "multi-select" && (
                        <p className="text-sm text-slate-600">
                          {marksEarned(q, given)} of {q.numAnswers} marks for this group
                          {chosenIndices(given).length > q.numAnswers
                            ? ` — ${chosenIndices(given).length} letters were chosen, and choosing more than ${q.numAnswers} scores zero`
                            : "."}
                        </p>
                      )}
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
        </section>
      ))}
    </div>
  );
}
