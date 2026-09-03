"use client";

import type { ReactNode } from "react";
import ExplainText from "@/components/ExplainText";
import { isCorrect, marksEarned } from "@/lib/band";
import { numberedGroups } from "@/lib/questions";
import type {
  QuestionGroup,
  QuestionLayout,
  QuestionSet,
  SharedOption,
  TestMode,
  TestQuestion,
} from "@/lib/types";

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

/*
  The rubric, with the part that decides a mark set in bold.

  The paper does this, and it is not decoration: "Write NO MORE THAN TWO WORDS
  AND/OR A NUMBER" is the sentence a candidate loses marks by skimming, and on
  the real screen the limit is the only bold text in the instruction. BandUp
  printed the whole rubric in one weight, so the limit read as ordinary prose
  and the thing worth noticing was the least noticeable part of it.

  Bolding is worked out from the text rather than authored into it, so every
  paper in the bank gained it at once and no rubric has to carry markup. The
  rule is the one the exam uses: the parts written in capitals — the limit, the
  letters to choose from, TRUE/FALSE/NOT GIVEN — plus the small words that hold
  a run of them together, so "A, B or C" does not come out as three bold
  letters with a plain word wedged between them.
*/
const RUBRIC_JOINERS = new Set(["or", "and", "AND/OR", "AND", "OR", "A"]);

function isCapsWord(word: string): boolean {
  const bare = word.replace(/[.,;:]+$/, "");
  return bare.length > 0 && /^[A-Z][A-Z/\u2013-]*$/.test(bare);
}

function Rubric({ text }: { text: string }) {
  const words = text.split(" ");
  const runs: Array<{ bold: boolean; words: string[] }> = [];
  for (const word of words) {
    const caps = isCapsWord(word);
    const joins =
      RUBRIC_JOINERS.has(word.replace(/[.,;:]+$/, "")) &&
      runs.length > 0 &&
      runs[runs.length - 1].bold;
    const bold = caps || joins;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.words.push(word);
    else runs.push({ bold, words: [word] });
  }
  /*
    A run that ended on a joiner was never emphasis — it is "…A, B or C" with
    nothing after the "or", or a sentence that happens to end in "A". Trailing
    joiners are handed back to the plain run beside them so the bold stops at
    the last capital.
  */
  for (const run of runs) {
    if (!run.bold) continue;
    while (run.words.length > 0 && !isCapsWord(run.words[run.words.length - 1])) {
      const spilled = run.words.pop() as string;
      const at = runs.indexOf(run);
      const after = runs[at + 1];
      if (after && !after.bold) after.words.unshift(spilled);
      else runs.splice(at + 1, 0, { bold: false, words: [spilled] });
    }
  }

  return (
    <p className="mt-1 text-sm leading-6 text-slate-700">
      {runs
        .filter((run) => run.words.length > 0)
        .map((run, index, kept) => (
          <span key={index} className={run.bold ? "font-semibold text-slate-900" : undefined}>
            {run.words.join(" ")}
            {index < kept.length - 1 ? " " : ""}
          </span>
        ))}
    </p>
  );
}

/**
 * The notes page a block of gaps already is, whether or not one was authored.
 *
 * Every completion block in the bank was written as a list of sentences with
 * `___` in them, and rendered as a numbered card each. The real paper renders
 * the same block as a page of notes with the boxes set into the lines — which
 * is not a nicer way to draw it but a different reading task: the candidate
 * sees the shape of what they are listening for before the recording starts.
 *
 * Rather than rewrite thirty papers to say so, a block that is nothing but
 * gaps is drawn as notes automatically, with each sentence's `___` replaced by
 * its own box. An authored `layout` always wins — it can do things this cannot,
 * like a table with columns or a heading over a group of lines — so this is the
 * floor, not the ceiling.
 *
 * A sentence with no `___` in it gets its gap at the end, which is where the
 * sentence was going to be answered anyway.
 */
function impliedNotes(group: QuestionGroup): QuestionLayout | undefined {
  const gaps = group.questions.every((q) => q.type === "completion");
  if (!gaps || group.questions.length === 0) return undefined;
  return {
    kind: "notes",
    sections: [
      {
        bullets: group.questions.map((q) => {
          const sentence = (q as { sentence: string }).sentence;
          const authored = q.id.split(":").pop() ?? q.id;
          return sentence.includes("___")
            ? sentence.replace("___", `{{${authored}}}`)
            : `${sentence} {{${authored}}}`;
        }),
      },
    ],
  };
}

/** One numbered question, as `numberedGroups` hands it over. */
type Numbered = { question: TestQuestion; number: number; to: number };

/**
 * A cell's text, cut at every `{{id}}` placeholder.
 *
 * Returned as an alternating run of prose and gaps rather than as a template
 * to interpolate, because a gap is an input element and cannot be spliced into
 * a string. Odd positions of the split are the captured ids — a property of
 * `String.split` with a capturing group, and the reason the pattern has one.
 */
function cellParts(text: string): Array<{ text: string } | { gap: string }> {
  return text
    .split(/\{\{([A-Za-z0-9_-]+)\}\}/)
    .map((piece, index) => (index % 2 === 1 ? { gap: piece } : { text: piece }))
    .filter((part) => ("gap" in part ? true : part.text !== ""));
}

/**
 * The gap itself: its number, and the box the candidate types in.
 *
 * It carries `data-question-id` for the same reason the list items do — the
 * exam palette scrolls to a question by that attribute and has no other way to
 * find one, so a gap inside a table has to be findable the same way a gap in a
 * list is.
 */
function LayoutGap({
  entry,
  given,
  revealed,
  correct,
  locked,
  onAnswer,
}: {
  entry: Numbered;
  given: Given;
  revealed: boolean;
  correct: boolean | undefined;
  locked: boolean;
  onAnswer: (id: string, value: string | number) => void;
}) {
  const q = entry.question;
  return (
    /*
      The number lives inside the box, which is how the computer-delivered
      paper draws it: an empty numbered field in the line of text, replaced by
      whatever the candidate types. A badge outside the box would be a second
      thing to read on the line, and in a table cell there is no room for one.
    */
    <span className="inline-flex align-middle" data-question-id={q.id}>
      <input
        type="text"
        value={(given as string) ?? ""}
        disabled={locked}
        onChange={(e) => onAnswer(q.id, e.target.value)}
        aria-label={`Question ${entry.number}`}
        placeholder={String(entry.number)}
        className={`exam-gap ${
          revealed ? (correct ? "exam-gap-right" : "exam-gap-wrong") : ""
        }`}
      />
    </span>
  );
}

/**
 * A block drawn as the figure it is on the paper.
 *
 * Table completion and flow-chart completion put their gaps *inside* something
 * — a row of a timetable, a box in a process — and the position is half of
 * what the candidate reads. So this replaces the numbered list for those
 * blocks rather than sitting beside it, and the verdicts move underneath: a
 * table with an explanation wedged into every cell would be unreadable, and
 * the explanation is the part a learner actually needs after the mark.
 *
 * Checking is per block rather than per gap for the same reason. One gap in a
 * table is rarely a self-contained thought — the row above it is what makes it
 * answerable — and a check button in every cell would double the width of the
 * narrowest column.
 */
function LayoutFigure({
  layout,
  entries,
  answers,
  submitted,
  practising,
  checked,
  onCheck,
  onAnswer,
}: {
  layout: QuestionLayout;
  entries: Numbered[];
  answers: AnswerMap;
  submitted: boolean;
  practising: boolean;
  checked: CheckedMap;
  onCheck?: (id: string) => void;
  onAnswer: (id: string, value: string | number) => void;
}) {
  /*
    Placeholders are resolved by the id the paper was authored with, not by the
    id the question is carrying at the time.

    Inside a mock sitting every question is renamed `listening-12:q1`, because
    four papers are concatenated into one forty-question exam and `q1` would
    otherwise name four different questions (lib/exam/mock.ts). The layout in
    the JSON says `{{q1}}` and always will — a paper cannot know which sitting
    it will be drawn into — so the trailing segment is indexed alongside the
    full id. Without this the notes rendered the literal text `{{q1}}` in the
    exam while working perfectly in practice, which is the worst place for a
    difference between the two to show up.
  */
  const byId = new Map<string, Numbered>();
  for (const entry of entries) {
    byId.set(entry.question.id, entry);
    const authored = entry.question.id.split(":").pop();
    if (authored && !byId.has(authored)) byId.set(authored, entry);
  }

  const renderCell = (text: string) =>
    cellParts(text).map((part, index) => {
      if (!("gap" in part)) return <span key={index}>{part.text}</span>;
      const entry = byId.get(part.gap);
      /*
        A placeholder naming nothing renders as the plain text it was. The
        validator fails the build on this, so it cannot reach a learner — but a
        renderer that threw would take the whole paper down over one typo.
      */
      if (!entry) return <span key={index}>{`{{${part.gap}}}`}</span>;
      const given = answers[entry.question.id];
      const revealed = submitted || (practising && checked[entry.question.id] === true);
      return (
        <LayoutGap
          key={index}
          entry={entry}
          given={given}
          revealed={revealed}
          correct={revealed ? isCorrect(entry.question, given) : undefined}
          locked={revealed}
          onAnswer={onAnswer}
        />
      );
    });

  const unchecked = entries.filter(({ question }) => checked[question.id] !== true);
  const answeredAll = entries.every(({ question }) => {
    const given = answers[question.id];
    return given !== undefined && given !== "";
  });

  return (
    <div className="space-y-4">
      <div className="card overflow-x-auto">
        {layout.kind === "table" ? (
          <table className="w-full min-w-[28rem] border-collapse text-sm leading-6 text-slate-700">
            {layout.columns && (
              <thead>
                <tr>
                  {layout.columns.map((column, index) => (
                    <th
                      key={index}
                      scope="col"
                      /* Centred and in the paper's own case, as the exam prints
                         a column head — not the small-caps label the rest of
                         the app uses for a table. */
                      className="border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-semibold text-slate-800"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {layout.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="border border-slate-200 px-3 py-2 align-middle"
                    >
                      {renderCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : layout.kind === "notes" ? (
          <div className="space-y-4 text-sm leading-7 text-slate-700">
            {layout.title && (
              <p className="text-center text-base font-semibold text-slate-900">
                {layout.title}
              </p>
            )}
            {layout.sections.map((section, sectionIndex) => (
              <div key={sectionIndex} className="space-y-1.5">
                {section.heading && (
                  <p className="font-semibold text-slate-900">{section.heading}</p>
                )}
                <ul className="space-y-1.5">
                  {section.bullets.map((bullet, bulletIndex) => {
                    const line = typeof bullet === "string" ? bullet : bullet.text;
                    const sub = typeof bullet === "string" ? [] : bullet.sub;
                    return (
                      <li key={bulletIndex}>
                        {/*
                          The bullet is punctuation the paper prints rather than
                          a marker carrying meaning, and a screen reader is
                          already told this is a list — so it is drawn and not
                          announced.
                        */}
                        <span aria-hidden className="mr-2 text-slate-400">
                          ·
                        </span>
                        {renderCell(line)}
                        {sub.length > 0 && (
                          <ul className="ml-6 mt-1.5 space-y-1.5">
                            {sub.map((subLine, subIndex) => (
                              <li key={subIndex}>
                                <span aria-hidden className="mr-2 text-slate-400">
                                  –
                                </span>
                                {renderCell(subLine)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <ol className="space-y-1">
            {layout.steps.map((step, index) => (
              <li key={index} className="space-y-1">
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm leading-6 text-slate-700">
                  {renderCell(step)}
                </div>
                {/*
                  The arrow between two boxes, and nothing after the last one.
                  It is decoration — the order is already carried by the list —
                  so it is hidden from a screen reader rather than read out as
                  a character between every stage.
                */}
                {index < layout.steps.length - 1 && (
                  <div aria-hidden className="text-center text-slate-400">
                    ↓
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {practising && !submitted && onCheck && unchecked.length > 0 && (
        <button
          type="button"
          onClick={() => unchecked.forEach(({ question }) => onCheck(question.id))}
          disabled={!answeredAll}
          className="text-xs font-medium text-indigo-600 underline underline-offset-4 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
        >
          {answeredAll ? "Check these answers" : "Fill every gap to check"}
        </button>
      )}

      {entries.some(({ question }) => submitted || (practising && checked[question.id] === true)) && (
        <ol className="space-y-2">
          {entries.map((entry) => {
            const revealed = submitted || (practising && checked[entry.question.id] === true);
            if (!revealed) return null;
            const given = answers[entry.question.id];
            const correct = isCorrect(entry.question, given);
            return (
              <li key={entry.question.id} className="text-sm leading-relaxed">
                <span className={correct ? "text-emerald-700" : "text-rose-700"}>
                  <span className="font-medium">{entry.number}.</span>{" "}
                  {correct ? "✓ Correct" : `✗ Answer: ${answerText(entry.question)}`}
                </span>
                {entry.question.explanation && (
                  <ExplainText
                    text={entry.question.explanation}
                    className="block text-slate-600"
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
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
      {groups.map((block, blockIndex) => {
        const blockLayout = block.group.layout ?? impliedNotes(block.group);
        return (
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
              {block.group.instruction && <Rubric text={block.group.instruction} />}
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

          {/*
            The block's shape. A table or flow-chart completion is drawn as the
            figure it is on the paper; every other block is the numbered list
            it has always been.
          */}
          {blockLayout ? (
            <LayoutFigure
              layout={blockLayout}
              entries={block.questions}
              answers={answers}
              submitted={submitted}
              practising={practising}
              checked={checked}
              onCheck={onCheck}
              onAnswer={onAnswer}
            />
          ) : (
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
          )}
        </section>
        );
      })}
    </div>
  );
}
