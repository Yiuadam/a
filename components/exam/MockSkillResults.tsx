"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import Review from "@/components/Review";
import { ApiError, postJSON } from "@/lib/api";
import { bandLabel } from "@/lib/band";
import {
  MODULE_NAMES,
  listeningPaper,
  listeningQuestions,
  markObjective,
  readingPaper,
  readingQuestions,
  writingBand,
  writingTask,
  type MockSession,
  type ModuleMark,
} from "@/lib/exam/mock";
import { testAdvice } from "@/lib/advice";
import { buildReview } from "@/lib/review";
import { addResult } from "@/lib/store";
import { savedAnswers } from "@/lib/results";
import type { ModuleResultReview, WritingGrade } from "@/lib/types";

/*
  What a standalone single-skill exam reports, which is neither a full
  sitting's report nor a retake's.

  ---------------------------------------------------------------------------
  Why this is its own screen rather than a flag on MockRetakeResults

  A retake's whole reason for existing is the sentence "this replaced what
  your report said before" — the before-band, the delta, the recomputed
  overall. None of that has a subject here: a standalone sitting has no report
  behind it, because it was never part of a full sitting in the first place.
  Threading "is there a report to compare against" through every paragraph of
  MockRetakeResults would turn a screen that currently says one thing clearly
  into one that has to hedge throughout — and tests/marking-retry.test.mjs
  already pins that screen's exact shape, so growing it to do a second job
  would be the riskier change as well as the muddier one.

  So this screen says the plainer thing a standalone sitting actually earns:
  one band, saved as one more entry in the learner's ordinary history, with no
  claim about the three skills it did not just measure.

  ---------------------------------------------------------------------------
  What it deliberately does not do

  It never calls `recordRetake` and never touches `MockExamReport` or
  `MockRetake` — see lib/exam/mock.ts and lib/exam/report.ts for what those
  own and why a retake must never be confused with this. The only write this
  screen makes is the same `addResult` a practice session or a full sitting's
  module would make, which is what lets history, the study plan and the
  dashboard read a standalone sitting exactly as they read any other completed
  paper — and what stops this screen ever producing something that looks like
  an overall IELTS band. That takes four modules, measured together, and this
  is deliberately one.
*/

function markLabel(mark: ModuleMark): string {
  return mark.raw !== undefined && mark.total !== undefined
    ? `${mark.raw}/${mark.total} correct`
    : bandLabel(mark.band);
}

export default function MockSkillResults({
  session,
  onLeave,
}: {
  session: MockSession;
  /** Ends the session, exactly as "Sit another" does after a full sitting. */
  onLeave: () => void;
}) {
  const skill = session.retake;

  const [marking, setMarking] = useState(true);
  const [mark, setMark] = useState<ModuleMark | null>(null);
  const [writingGrades, setWritingGrades] = useState<(WritingGrade | null)[]>([]);
  /*
    Why marking produced nothing, when the reason is one that asking again
    could change. A plan without AI marking answers 402 and is left alone: that
    is not a failure and there is nothing behind a retry button.
  */
  const [markingFailure, setMarkingFailure] = useState<string | null>(null);
  const started = useRef(false);

  const listeningSet = useMemo(() => listeningQuestions(session.paper), [session.paper]);
  const readingSet = useMemo(() => readingQuestions(session.paper), [session.paper]);

  const run = useCallback(async () => {
    if (!skill) return;
    const at = new Date().toISOString();
    let scored: ModuleMark | null = null;
    let review: ModuleResultReview | undefined;

    if (skill.module === "listening" || skill.module === "reading") {
      /*
        The same function a full sitting and a retake are marked with, so a
        band earned here means exactly what the same band means everywhere
        else in the app.
      */
      scored = markObjective(session.paper, session.answers)[skill.module];
      const set = skill.module === "listening" ? listeningSet : readingSet;
      const items = buildReview(set, session.answers);
      review = {
        kind: "objective",
        questions: set,
        answers: savedAnswers(session.answers),
        advice: testAdvice(skill.module, set, items.map((item) => item.id), scored.band),
        source:
          skill.module === "listening"
            ? {
                kind: "listening",
                script: session.paper.listening.flatMap((id) => listeningPaper(id)?.script ?? []),
              }
            : {
                kind: "reading",
                passage: session.paper.reading
                  .map((id) => readingPaper(id)?.passage ?? "")
                  .filter(Boolean)
                  .join("\n\n"),
              },
      };
    } else if (skill.module === "writing") {
      let failure: string | null = null;
      const tasks = session.paper.writing
        .map((id) => writingTask(id))
        .filter((task) => task !== undefined);
      const grades = await Promise.all(
        tasks.map(async (task) => {
          const essay = session.essays[task.id] ?? "";
          if (essay.trim().length === 0) return null;
          try {
            return await postJSON<WritingGrade>("/api/grade/writing", {
              task: task.task,
              prompt: task.prompt,
              essay,
              minWords: task.minWords,
            });
          } catch (err) {
            if (err instanceof ApiError && err.retryable) failure = err.message;
            return null;
          }
        }),
      );
      setWritingGrades(grades);
      setMarkingFailure(failure);
      /*
        One marked task is enough for a band; two nulls means the module was
        not marked at all, which is different from a candidate who wrote
        nothing — that one gets a band, and it is a low one.
      */
      const anyMarked = grades.some((grade) => grade !== null);
      const wrote = tasks.some((task) => (session.essays[task.id] ?? "").trim().length > 0);
      scored =
        anyMarked || !wrote
          ? { band: writingBand(grades[0]?.overallBand ?? null, grades[1]?.overallBand ?? null) }
          : null;
      if (scored) {
        review = {
          kind: "writing",
          attempts: tasks.flatMap((task, index) => {
            const grade = grades[index];
            return grade ? [{ task, response: session.essays[task.id] ?? "", grade }] : [];
          }),
        };
      }
    } else {
      /*
        Not reachable from the "One skill" chooser on /exam today — Speaking
        there links straight to /speaking, which already is this exact
        standalone sitting. Handled here anyway rather than assumed away,
        because `session.retake.module` is typed as any of the four and a
        session built by hand (a test, a future entry point) must still mark
        honestly rather than fall through to nothing.
      */
      scored =
        session.speakingBand === undefined || session.speakingBand === null
          ? null
          : { band: session.speakingBand };
      if (scored && session.speakingGrade && session.speakingTranscript) {
        review = {
          kind: "speaking",
          transcript: session.speakingTranscript,
          grade: session.speakingGrade,
        };
      }
    }

    setMark(scored);
    setMarking(false);

    /*
      Recorded exactly as any other completed module is — see addResult in
      lib/store.ts. There is no `recordRetake` here and no `addMockReport`: a
      standalone sitting has no `MockExamReport` to update and must never grow
      one of its own, because a single module's band is not an overall band
      and this screen must never let one be mistaken for the other.
    */
    if (!scored) return;
    addResult({
      module: skill.module,
      testId: `${session.id}-${skill.module}`,
      testTitle: `One skill exam — ${MODULE_NAMES[skill.module]}`,
      band: scored.band,
      raw: scored.raw,
      total: scored.total,
      date: at,
      review,
    });
  }, [skill, session, listeningSet, readingSet]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  /*
    Marking again after it failed, which here is simply running the same pass
    a second time — safe because this callback writes nothing at all unless it
    produced a band, so a failed first pass leaves nothing for a second pass to
    duplicate.
  */
  const remark = useCallback(() => {
    setMarking(true);
    setMarkingFailure(null);
    void run();
  }, [run]);

  if (!skill) return null;

  if (marking) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 py-10 text-center">
        <h1 className="text-[1.375rem] font-semibold text-slate-900">
          <LoadingIndicator label={`Marking your ${MODULE_NAMES[skill.module]} exam`} />
        </h1>
        <p className="text-sm leading-6 text-slate-600">
          One skill, sat on its own — the band lands in your history as soon as marking finishes.
        </p>
      </div>
    );
  }

  /*
    Held as the narrowed module rather than a boolean, because `testAdvice` and
    `buildReview` only speak the two objective modules and a boolean does not
    narrow a union for the compiler.
  */
  const objective: "listening" | "reading" | null =
    skill.module === "listening" || skill.module === "reading" ? skill.module : null;
  const set = objective === "reading" ? readingSet : listeningSet;
  const items = objective ? buildReview(set, session.answers) : [];

  return (
    <div className="space-y-5">
      {markingFailure !== null && mark === null && (
        <div
          role="alert"
          className="card flex flex-col gap-2 !p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm leading-6 text-slate-700">
            Your sitting was not marked. {markingFailure} Your answers are still here, and nothing
            has been added to your history.
          </p>
          <button
            type="button"
            className="btn-primary shrink-0 !min-h-9 !px-4 !py-1.5 text-sm"
            onClick={remark}
          >
            Mark it now
          </button>
        </div>
      )}

      <section className="card flex flex-col items-center gap-5 py-7 sm:flex-row sm:justify-center sm:gap-10">
        {/* No caption on a real band: BandBadge prints its own CEFR estimate,
            which is honest here in a way an "overall" caption would not be —
            this disc is one module, not four. */}
        {mark !== null ? (
          <BandBadge band={mark.band} />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-center text-xs leading-4 text-slate-400">
            not marked
          </div>
        )}
        <div className="max-w-md space-y-2 text-sm leading-6 text-slate-600">
          <h1 className="text-lg font-semibold text-slate-900">
            {MODULE_NAMES[skill.module]} exam
          </h1>
          {mark === null ? (
            <p>
              This sitting could not be marked, so nothing has been saved. You can sit it again
              whenever marking is available.
            </p>
          ) : (
            <>
              <p>
                Your {MODULE_NAMES[skill.module]} band is{" "}
                <span className="font-semibold">{mark.band}</span>. {markLabel(mark)}.
              </p>
              <p>
                One skill on its own does not produce an overall IELTS band — that takes all four
                together — so this has been saved to your history as its own result rather than to
                a Test Report Form.
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Link href="/history" className="btn-primary" onClick={onLeave}>
              See your record
            </Link>
            <button type="button" className="btn-secondary" onClick={onLeave}>
              Done
            </button>
          </div>
        </div>
      </section>

      {writingGrades.some((grade) => grade !== null) && (
        <section className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">What the examiner said</h2>
          {writingGrades.map((grade, index) =>
            grade === null ? null : (
              <div
                key={index}
                className="space-y-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0"
              >
                <p className="text-sm font-medium text-slate-800">
                  Task {index + 1} — band {grade.overallBand}
                </p>
                <ul className="space-y-1">
                  {grade.criteria.map((criterion) => (
                    <li key={criterion.name} className="text-sm leading-6 text-slate-600">
                      <span className="font-medium text-slate-800">
                        {criterion.name} {criterion.band}
                      </span>{" "}
                      — {criterion.comment}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </section>
      )}

      {objective && mark && (
        <Review
          items={items}
          advice={testAdvice(objective, set, items.map((item) => item.id), mark.band)}
          total={mark.total ?? set.length}
        />
      )}
    </div>
  );
}
