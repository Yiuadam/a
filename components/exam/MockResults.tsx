"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import Review from "@/components/Review";
import { postJSON } from "@/lib/api";
import { bandLabel } from "@/lib/band";
import {
  MODULE_NAMES,
  listeningQuestions,
  markObjective,
  overallFrom,
  readingQuestions,
  writingBand,
  writingTask,
  type MockMarks,
  type MockSession,
} from "@/lib/exam/mock";
import { testAdvice } from "@/lib/advice";
import { buildReview } from "@/lib/review";
import { addResult } from "@/lib/store";
import type { WritingGrade } from "@/lib/types";

/*
  The report at the end of a sitting: four bands, an overall, and everything
  that was wrong.

  ---------------------------------------------------------------------------
  The overall band is withheld rather than approximated

  Writing and Speaking need a model. On a plan without AI marking, or with the
  key missing, they cannot be marked — and the temptation is to average the two
  bands that do exist and call it an overall. That would be a number a learner
  carries around and quotes, produced from half an exam.

  So the two objective bands are reported in full, the modules that could not be
  marked are named, and the overall is absent with a sentence saying why. A
  report that admits a gap is worth more than one that fills it.
*/

export default function MockResults({
  session,
  onMarks,
  onRestart,
}: {
  session: MockSession;
  onMarks: (marks: MockMarks) => void;
  onRestart: () => void;
}) {
  const [grading, setGrading] = useState(session.marks === null);
  const [writingGrades, setWritingGrades] = useState<(WritingGrade | null)[]>([]);
  const started = useRef(false);

  const mark = useCallback(async () => {
    const objective = markObjective(session.paper, session.answers);

    /*
      Both essays, in parallel, and a failure on either is a null rather than a
      thrown error. The commonest reason to land here is a plan without AI
      marking, which answers 402 — an ordinary state of affairs, not a fault,
      and one the report is built to describe.
    */
    const tasks = session.paper.writing.map((id) => writingTask(id)).filter((t) => t !== undefined);
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
        } catch {
          return null;
        }
      }),
    );
    setWritingGrades(grades);

    /*
      A writing band needs at least one marked task. Two nulls means the module
      was not marked at all, which is different from a candidate who wrote
      nothing — that one gets a band, and it is a low one.
    */
    const anyMarked = grades.some((g) => g !== null);
    const wrote = tasks.some((t) => (session.essays[t.id] ?? "").trim().length > 0);
    const writing =
      anyMarked || !wrote
        ? { band: writingBand(grades[0]?.overallBand ?? null, grades[1]?.overallBand ?? null) }
        : null;

    const speaking =
      session.speakingBand === undefined || session.speakingBand === null
        ? null
        : { band: session.speakingBand };

    const marks = overallFrom({ ...objective, writing, speaking });
    setGrading(false);
    onMarks(marks);

    /*
      One history entry per module rather than one for the sitting.

      A single "mock exam" result would be the tidier record and the less useful
      one. The study plan decides what to work on next by reading a band per
      module (lib/plan.ts) and the history graphs plot the same way, so a
      sitting recorded as one number would be the most informative thing a
      learner has ever done here and invisible to both. Recorded per module, a
      mock exam moves the study plan the way it should.

      An unmarked module records nothing, which is the same rule as everywhere
      else: no band, no entry.
    */
    const date = new Date().toISOString();
    const entries = [
      { module: "listening" as const, mark: marks.listening },
      { module: "reading" as const, mark: marks.reading },
      { module: "writing" as const, mark: marks.writing },
      { module: "speaking" as const, mark: marks.speaking },
    ];
    for (const { module, mark } of entries) {
      if (!mark) continue;
      addResult({
        module,
        testId: `${session.id}-${module}`,
        testTitle: `Mock exam — ${MODULE_NAMES[module]}`,
        band: mark.band,
        raw: mark.raw,
        total: mark.total,
        date,
      });
    }
  }, [session, onMarks]);

  useEffect(() => {
    if (session.marks !== null || started.current) return;
    started.current = true;
    void mark();
  }, [session.marks, mark]);

  if (grading || session.marks === null) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 py-10 text-center">
        <h1 className="text-[22px] font-semibold text-slate-900">Marking your exam</h1>
        <p className="text-sm leading-6 text-slate-600">
          Listening and Reading are marked already. The examiner is reading both writing tasks —
          this takes a few seconds.
        </p>
      </div>
    );
  }

  const marks = session.marks;
  const rows = [
    { key: "listening" as const, mark: marks.listening },
    { key: "reading" as const, mark: marks.reading },
    { key: "writing" as const, mark: marks.writing },
    { key: "speaking" as const, mark: marks.speaking },
  ];

  /*
    The sitting's papers flattened back into one question list per module, which
    is what the candidate actually sat. `buildReview` and `testAdvice` both take
    a QuestionSet, and a flat array is one.

    Through `listeningQuestions`/`readingQuestions` so the ids are the renamed
    ones the answers were stored under. Flattening the papers directly here was
    the first version and it was wrong twice: three passages each contributing a
    `q1` gave React duplicate keys, and every lookup into `answers` missed — so
    the report told a candidate they had got every question wrong, including the
    ones it had just counted as right.
  */
  const listeningSet = listeningQuestions(session.paper);
  const readingSet = readingQuestions(session.paper);
  const listeningReview = buildReview(listeningSet, session.answers);
  const readingReview = buildReview(readingSet, session.answers);

  return (
    <div className="space-y-5">
      <section className="card flex flex-col items-center gap-5 py-7 sm:flex-row sm:justify-center sm:gap-10">
        {marks.overall !== null ? (
          <BandBadge band={marks.overall} caption={bandLabel(marks.overall)} />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-center text-xs leading-4 text-slate-400">
            no overall band
          </div>
        )}
        <div className="max-w-md space-y-2 text-sm leading-6 text-slate-600">
          {marks.overall !== null ? (
            <p>
              Your overall band is <span className="font-semibold">{marks.overall}</span>, the mean
              of the four modules rounded to the nearest half band — the official rule.
            </p>
          ) : (
            <p>
              {marks.unmarked.map((m) => MODULE_NAMES[m]).join(" and ")}{" "}
              {marks.unmarked.length > 1 ? "were" : "was"} not marked, so there is no overall band.
              An overall band is the mean of four, and averaging the two that exist would give you a
              number that looks like an IELTS score and is not one. Your Listening and Reading bands
              below are complete and real.
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className="btn-secondary" onClick={onRestart}>
              Sit another
            </button>
            <Link href="/plan" className="btn-primary">
              Study plan
            </Link>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Band by module</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map(({ key, mark }) => (
            <li
              key={key}
              className="flex items-baseline justify-between rounded-lg border border-slate-200 px-3 py-2"
            >
              <span className="text-sm text-slate-700">{MODULE_NAMES[key]}</span>
              {mark ? (
                <span className="text-sm font-semibold tabular-nums text-slate-900">
                  {mark.band}
                  {mark.total !== undefined && (
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {mark.raw}/{mark.total}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-xs text-slate-400">not marked</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {writingGrades.some((g) => g !== null) && (
        <section className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">What the examiner said</h2>
          {writingGrades.map((grade, i) =>
            grade === null ? null : (
              <div key={i} className="space-y-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
                <p className="text-sm font-medium text-slate-800">
                  Task {i + 1} — band {grade.overallBand}
                </p>
                <ul className="space-y-1">
                  {grade.criteria.map((c) => (
                    <li key={c.name} className="text-sm leading-6 text-slate-600">
                      <span className="font-medium text-slate-800">
                        {c.name} {c.band}
                      </span>{" "}
                      — {c.comment}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </section>
      )}

      {/*
        Every question that was wrong, with the explanation. One review per
        module rather than one per recording, because the candidate sat one
        forty-question listening paper — splitting it into four would restate
        the numbering problem the sitting exists to avoid.
      */}
      <Review
        items={listeningReview}
        advice={testAdvice("listening", listeningSet, listeningReview.map((r) => r.id), marks.listening.band)}
        total={marks.listening.total ?? listeningSet.length}
      />
      <Review
        items={readingReview}
        advice={testAdvice("reading", readingSet, readingReview.map((r) => r.id), marks.reading.band)}
        total={marks.reading.total ?? readingSet.length}
      />
    </div>
  );
}
