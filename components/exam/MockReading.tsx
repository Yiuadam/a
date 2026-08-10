"use client";

import { useCallback, useMemo, useState } from "react";
import TestQuestions, { type AnswerMap } from "@/components/TestQuestions";
import ExamShell from "@/components/exam/ExamShell";
import SplitPanes, { useIsWide } from "@/components/exam/SplitPanes";
import {
  MODULE_MINUTES,
  readingPaper,
  readingQuestions,
  sittingGroups,
  type MockPaper,
} from "@/lib/exam/mock";
import { useExamNavigation } from "@/lib/exam/navigation";
import { questionCount } from "@/lib/questions";

/*
  The reading paper of a mock sitting: three passages, one hour, and no
  instruction about how to divide it.

  ---------------------------------------------------------------------------
  One clock for three passages, deliberately

  The exam gives sixty minutes for the whole paper and says nothing about
  twenty each. Managing that is part of what reading is testing — passage three
  is the hardest and the candidate who has spent forty minutes on passage one
  has already lost, and has to find that out for themselves. So there is one
  clock and a passage switcher, and no per-passage timer, no nudge, no
  suggestion.

  The practice pages take the opposite view and give twenty minutes per passage,
  which is right for practice: a learner working on one passage should not be
  failing a time-management exercise they did not sign up for.
*/

export default function MockReading({
  paper,
  answers,
  onAnswer,
  deadline,
  onFinish,
}: {
  paper: MockPaper;
  answers: AnswerMap;
  onAnswer: (id: string, value: string | number) => void;
  deadline: number | null;
  onFinish: () => void;
}) {
  const tests = useMemo(
    () => paper.reading.map((id) => readingPaper(id)).filter((t) => t !== undefined),
    [paper.reading],
  );

  const starts = useMemo(
    () =>
      tests.map((_, i) =>
        tests.slice(0, i).reduce((n, t) => n + questionCount(t.questions), 1),
      ),
    [tests],
  );

  const [active, setActive] = useState(0);
  const wide = useIsWide();

  const groups = useMemo(
    () => tests.map((t) => sittingGroups(t.id, t.questions)),
    [tests],
  );
  /* The palette spans the whole paper, because the numbering does. */
  const flat = useMemo(() => readingQuestions(paper), [paper]);
  const nav = useExamNavigation(
    useMemo(
      () => flat.map((q) => ({ id: q.id, answered: answers[q.id] !== undefined })),
      [flat, answers],
    ),
  );

  /*
    Jumping to a question in another passage has to bring the passage with it.

    Without this the palette silently does nothing for two thirds of its
    buttons: the element it wants to scroll to is not mounted, so the click
    lands nowhere and the candidate concludes the numbers are decorative. The
    switch happens first and the scroll is deferred a frame, because the anchor
    does not exist until the new passage has rendered.
  */
  const jump = useCallback(
    (id: string) => {
      const owner = groups.findIndex((blocks) =>
        blocks.some((b) => b.questions.some((q) => q.id === id)),
      );
      if (owner !== -1 && owner !== active) {
        setActive(owner);
        requestAnimationFrame(() => nav.jump(id));
        return;
      }
      nav.jump(id);
    },
    [groups, active, nav],
  );

  const test = tests[active];
  if (!test) return null;

  const passage = (
    <>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-muted)]">
          Passage {active + 1}
        </h2>
        <span className="text-[11px] text-[color:var(--exam-muted)]">{test.title}</span>
      </div>
      {test.passage.split(/\n\n+/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );

  const questions = (
    <TestQuestions
      questions={groups[active]}
      answers={answers}
      onAnswer={onAnswer}
      submitted={false}
      mode="exam"
      startNumber={starts[active]}
    />
  );

  return (
    <ExamShell
      section="Reading"
      paper={`Passage ${active + 1} of ${tests.length}`}
      minutes={MODULE_MINUTES.reading}
      running
      endsAt={deadline}
      onExpire={onFinish}
      palette={nav.items}
      currentId={nav.currentId}
      onJump={jump}
      onPrev={nav.prev}
      onNext={nav.next}
      onToggleReview={nav.toggleReview}
      onNextFlagged={nav.nextFlagged}
      topRight={
        /*
          The passage switcher, where the exam puts its part tabs. Numbers only
          — a title here would be a hint about the passage you have not read.
        */
        <div className="flex items-center gap-1">
          {tests.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(i)}
              aria-current={i === active}
              className={`h-6 w-6 rounded text-[11px] font-semibold ${
                i === active
                  ? "border-[1.5px] border-[color:var(--exam-accent)] bg-[color:var(--exam-bg)]"
                  : "border border-[color:var(--exam-line)] hover:bg-[color:var(--exam-hover)]"
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      }
    >
      {wide ? (
        <SplitPanes
          className="h-full"
          left={<div className="prose-reading">{passage}</div>}
          right={
            <>
              {questions}
              <FinishButton onFinish={onFinish} />
            </>
          }
        />
      ) : (
        <>
          <p className="shrink-0 pb-1 text-center text-[11px] text-[color:var(--exam-muted)]">
            Swipe sideways to move between the passage and the questions
          </p>
          <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto">
            <div className="prose-reading w-[86vw] shrink-0 snap-start overflow-y-auto">
              {passage}
            </div>
            <div className="w-[86vw] shrink-0 snap-start overflow-y-auto">
              {questions}
              <FinishButton onFinish={onFinish} />
            </div>
          </div>
        </>
      )}
    </ExamShell>
  );
}

function FinishButton({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="mt-5">
      <button type="button" className="btn-primary w-full" onClick={onFinish}>
        Finish the reading paper
      </button>
      <p className="mt-1 text-center text-[11px] text-[color:var(--exam-muted)]">
        This ends all three passages. You cannot come back.
      </p>
    </div>
  );
}
