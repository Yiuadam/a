"use client";

import TestQuestions from "@/components/TestQuestions";
import { TallyList } from "@/components/exam/ModuleSection";
import {
  talliesByPaper,
  talliesByType,
  type MarkedQuestion,
  type SittingPaper,
} from "@/lib/exam/breakdown";
import type { QuestionGroup, ScriptTurn } from "@/lib/types";

/*
  Listening or Reading, marked question by question.

  ---------------------------------------------------------------------------
  Why this renders the paper again rather than a list of mistakes

  The review after a practice test lists what went wrong. That is the right
  shape for a fifteen-minute test somebody has just read; it is the wrong shape
  for a forty-question paper sat two hours ago, because a mistake shown on its
  own has lost the block it belonged to — the rubric above it, the bank of
  headings it chose from, the four questions around it that were about the same
  part of the recording.

  So the paper comes back whole, in `TestQuestions` with `submitted` set, which
  is the same component and the same green-and-red the app has always used to
  say right and wrong. A candidate who has marked a practice test here already
  knows how to read this, and there is no second visual language for the same
  idea.

  Above it, two tallies. They exist because forty verdicts do not add up to a
  pattern by themselves: seeing 4/10 against Part 3 and 3/6 against True /
  False / Not Given is the whole diagnosis, and scrolling eighty cards to
  assemble it by eye is not something anyone will do.
*/

/** One paper of a module, with everything the report needs to redraw it. */
export interface ObjectivePaper extends SittingPaper {
  id: string;
  /** The paper's blocks, renamed for the sitting so ids match the answers. */
  groups: QuestionGroup[];
  /** What this paper's first question is called in the forty. */
  start: number;
  source: { kind: "reading"; passage: string } | { kind: "listening"; script: ScriptTurn[] };
}

/* The paper is over; nothing here can change an answer. */
const noop = () => {};

export default function ObjectiveReport({
  papers,
  marked,
  answers,
}: {
  papers: ObjectivePaper[];
  marked: MarkedQuestion[];
  answers: Record<string, string | number>;
}) {
  const byPaper = talliesByPaper(marked, papers);
  const byType = talliesByType(marked);

  return (
    <>
      <div className="card grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Where the marks went
          </h3>
          <TallyList tallies={byPaper} />
        </div>
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            By question type
          </h3>
          <TallyList tallies={byType} />
        </div>
      </div>

      {papers.map((paper, index) => {
        const tally = byPaper[index];
        const last = paper.start + paper.questions.length - 1;
        return (
          <div key={paper.id} className="space-y-4">
            <div className="card">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                {paper.label}
              </p>
              <h3 className="mt-1 text-base font-semibold text-slate-900">{paper.title}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Questions {paper.start}–{last} · {tally.right} of {tally.total} right
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-indigo-600">
                  {paper.source.kind === "reading" ? "Read the passage again" : "Read the transcript"}
                </summary>
                {paper.source.kind === "reading" ? (
                  <div className="prose-reading mt-4 whitespace-pre-line">
                    {paper.source.passage}
                  </div>
                ) : (
                  <div className="mt-4 space-y-2">
                    {paper.source.script.map((turn, at) => (
                      <p key={at} className="text-sm leading-6 text-slate-700">
                        <strong className="text-slate-900">{turn.speaker}:</strong> {turn.text}
                      </p>
                    ))}
                  </div>
                )}
              </details>
            </div>

            <TestQuestions
              questions={paper.groups}
              answers={answers}
              onAnswer={noop}
              submitted
              mode="exam"
              startNumber={paper.start}
            />
          </div>
        );
      })}
    </>
  );
}
