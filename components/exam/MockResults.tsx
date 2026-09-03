"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import { SpeakingReport, WritingReport } from "@/components/exam/ExaminerReport";
import ImprovementPlan, { type PlanGroup } from "@/components/exam/ImprovementPlan";
import ModuleSection from "@/components/exam/ModuleSection";
import ObjectiveReport, { type ObjectivePaper } from "@/components/exam/ObjectiveReport";
import { ApiError, postJSON } from "@/lib/api";
import {
  MODULE_NAMES,
  listeningPaper,
  listeningQuestions,
  markObjective,
  overallFrom,
  readingPaper,
  readingQuestions,
  sittingGroups,
  writingBand,
  writingTask,
  type MockMarks,
  type MockSession,
} from "@/lib/exam/mock";
import {
  markPapers,
  marksToNextBand,
  observations,
  type MarkedQuestion,
  type Observation,
} from "@/lib/exam/breakdown";
import { testAdvice } from "@/lib/advice";
import { buildReview } from "@/lib/review";
import { useProfile } from "@/lib/hooks";
import { addMockReport, addResult } from "@/lib/store";
import { savedAnswers } from "@/lib/results";
import type {
  ModuleResultReview,
  WritingGrade,
  WritingResultAttempt,
} from "@/lib/types";

/*
  The report at the end of a sitting: four bands, an overall, and everything
  behind all five.

  ---------------------------------------------------------------------------
  The overall band is withheld rather than approximated

  Writing and Speaking need a model. On a plan without AI marking, or with the
  key missing, they cannot be marked — and the temptation is to average the two
  bands that do exist and call it an overall. That would be a number a learner
  carries around and quotes, produced from half an exam.

  So the two objective bands are reported in full, the modules that could not be
  marked are named, and the overall is absent with a sentence saying why. A
  report that admits a gap is worth more than one that fills it.

  ---------------------------------------------------------------------------
  Why the report is this long

  Because the sitting is two and three-quarter hours and this is what it was
  for. A band on its own says where a candidate is; it says nothing about how
  to move, and the app already owns the thing that does — every question in the
  bank carries an explanation, and the content validator fails the build
  without one. This screen is the moment those exist for, so all eighty are
  here, right ones as well as wrong, with what the candidate put beside what
  the answer was.

  Length is the cost of that, and it is paid with folds rather than with
  cutting: each module is closed until it is asked for, and its heading carries
  the band, the raw score and the distance to the next half band, which is what
  most candidates came for.

  ---------------------------------------------------------------------------
  Why the writing feedback is read from the archive rather than held here

  The marking runs once, in an effect that is skipped when the session already
  has marks. That is right — nobody should pay to have the same essay read
  twice — but it used to mean that a candidate who reloaded the results screen
  found the examiner's four criteria gone, because they had only ever lived in
  this component's state.

  The sitting writes them into the results archive as it marks, so they are
  read back from there instead, through the store this app already subscribes
  to everywhere else. Marking populates it and a reload finds it populated, so
  there is one path rather than two, and no re-marking and no invention on
  either.
*/

/** One module's papers, with everything the report needs to draw them again. */
function objectivePapers(
  ids: string[],
  kind: "listening" | "reading",
): ObjectivePaper[] {
  const out: ObjectivePaper[] = [];
  let start = 1;
  ids.forEach((id, index) => {
    const test = kind === "listening" ? listeningPaper(id) : readingPaper(id);
    if (!test) return;
    const groups = sittingGroups(test.id, test.questions);
    const questions = groups.flatMap((group) => group.questions);
    out.push({
      id: test.id,
      label: kind === "listening" ? `Part ${index + 1}` : `Passage ${index + 1}`,
      title: test.title,
      questions,
      groups,
      start,
      source:
        "passage" in test
          ? { kind: "reading", passage: test.passage }
          : { kind: "listening", script: test.script },
    });
    start += questions.length;
  });
  return out;
}

/**
 * The line under a module's heading: what the paper was, and how close the
 * next half band came to being the one on the badge.
 */
function objectiveNote(
  module: "listening" | "reading",
  papers: ObjectivePaper[],
  raw: number,
  total: number,
): string {
  const shape =
    module === "listening"
      ? `${papers.length} recordings`
      : `${papers.length} passages`;
  const next = marksToNextBand(raw, total, module);
  const reach = next
    ? ` ${next.marks} more ${next.marks === 1 ? "mark" : "marks"} would have been band ${next.band}.`
    : "";
  return `${shape}, ${total} questions.${reach}`;
}

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
  /*
    Set when the essays went unmarked for a reason that asking again could
    change — the model timing out, a 5xx, a connection that dropped between the
    last full stop and the Submit. It is deliberately *not* set for a 402: that
    means the plan does not include marking, nothing is wrong, and a button
    offering to try again would be a button that cannot work.
  */
  const [markingFailure, setMarkingFailure] = useState<string | null>(null);
  const [remarking, setRemarking] = useState(false);
  const profile = useProfile();
  const started = useRef(false);
  const listeningSet = useMemo(() => listeningQuestions(session.paper), [session.paper]);
  const readingSet = useMemo(() => readingQuestions(session.paper), [session.paper]);
  const tasks = useMemo(
    () => session.paper.writing.map((id) => writingTask(id)).filter((t) => t !== undefined),
    [session.paper.writing],
  );

  /*
    Both essays, in parallel, and a failure on either is a null rather than a
    thrown error. The commonest reason to land here is a plan without AI
    marking, which answers 402 — an ordinary state of affairs, not a fault, and
    one the report is built to describe.

    What it now also does is say *which* kind of failure it was, so the report
    can tell a candidate whose plan does not include marking from one whose
    marking simply fell over. The second one gets offered another go; before
    this, both were told the same thing and neither was.
  */
  const gradeEssays = useCallback(async () => {
    let failure: string | null = null;
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
          if (err instanceof ApiError && err.retryable && failure === null) failure = err.message;
          return null;
        }
      }),
    );
    return { grades, failure };
  }, [tasks, session.essays]);

  const mark = useCallback(async () => {
    const objective = markObjective(session.paper, session.answers);
    const { grades, failure } = await gradeEssays();
    setMarkingFailure(failure);

    const attempts: WritingResultAttempt[] = tasks.flatMap((task, index) => {
      const grade = grades[index];
      return grade ? [{ task, response: session.essays[task.id] ?? "", grade }] : [];
    });

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
      let review: ModuleResultReview | undefined;
      if (module === "listening") {
        const items = buildReview(listeningSet, session.answers);
        review = {
          kind: "objective",
          questions: listeningSet,
          answers: savedAnswers(session.answers),
          advice: testAdvice("listening", listeningSet, items.map((item) => item.id), mark.band),
          source: {
            kind: "listening",
            script: session.paper.listening.flatMap((id) => listeningPaper(id)?.script ?? []),
          },
        };
      } else if (module === "reading") {
        const items = buildReview(readingSet, session.answers);
        review = {
          kind: "objective",
          questions: readingSet,
          answers: savedAnswers(session.answers),
          advice: testAdvice("reading", readingSet, items.map((item) => item.id), mark.band),
          source: {
            kind: "reading",
            passage: session.paper.reading
              .map((id) => readingPaper(id)?.passage ?? "")
              .filter(Boolean)
              .join("\n\n"),
          },
        };
      } else if (module === "writing") {
        review = { kind: "writing", attempts };
      }
      addResult({
        module,
        testId: `${session.id}-${module}`,
        testTitle: `Mock exam — ${MODULE_NAMES[module]}`,
        band: mark.band,
        raw: mark.raw,
        total: mark.total,
        date,
        review,
      });
    }

    addMockReport({
      id: session.id,
      startedAt: session.startedAt,
      completedAt: date,
      marks,
    });
  }, [session, tasks, onMarks, listeningSet, readingSet, gradeEssays]);

  useEffect(() => {
    if (session.marks !== null || started.current) return;
    started.current = true;
    void mark();
  }, [session.marks, mark]);

  /*
    Mark the essays again, after marking failed the first time.

    Deliberately not a re-run of mark(). That would re-mark the objective
    papers, which did not fail and cost nothing to keep, and it would call
    addResult a second time for listening and reading — and addResult prepends
    rather than replaces, because a learner sitting the same practice paper
    twice should see two entries in their history. Two entries for one sitting
    is a different thing, and a wrong one.

    So this adds only what is missing. A failed first pass recorded no writing
    mark and no writing entry at all, so there is nothing to replace: the
    essays are graded, the overall band is recomputed from the objective marks
    that were already good, and the sitting's report is written again — that
    one does replace, by id.
  */
  const remark = useCallback(async () => {
    if (session.marks === null) return;
    setRemarking(true);
    try {
      const { grades, failure } = await gradeEssays();
      const attempts: WritingResultAttempt[] = tasks.flatMap((task, index) => {
        const grade = grades[index];
        return grade ? [{ task, response: session.essays[task.id] ?? "", grade }] : [];
      });
      if (attempts.length === 0) {
        setMarkingFailure(failure ?? "Marking is still unavailable. Please try again shortly.");
        return;
      }
      setMarkingFailure(null);

      const writing = {
        band: writingBand(grades[0]?.overallBand ?? null, grades[1]?.overallBand ?? null),
      };
      const next = overallFrom({
        listening: session.marks.listening,
        reading: session.marks.reading,
        writing,
        speaking: session.marks.speaking,
      });
      onMarks(next);

      const date = new Date().toISOString();
      addResult({
        module: "writing",
        testId: `${session.id}-writing`,
        testTitle: `Mock exam — ${MODULE_NAMES.writing}`,
        band: writing.band,
        date,
        review: { kind: "writing", attempts },
      });
      addMockReport({
        id: session.id,
        startedAt: session.startedAt,
        completedAt: date,
        marks: next,
      });
    } finally {
      setRemarking(false);
    }
  }, [session, tasks, onMarks, gradeEssays]);

  /*
    The examiner's report on the two essays, from the archive the marking wrote
    it to — see the note at the top of the file. Empty is a real answer: it is
    what an unmarked writing module looks like, and what a candidate who wrote
    nothing looks like.
  */
  const writingAttempts = useMemo<WritingResultAttempt[]>(() => {
    const saved = profile.results.find((r) => r.testId === `${session.id}-writing`);
    return saved?.review?.kind === "writing" ? saved.review.attempts : [];
  }, [profile.results, session.id]);

  const listeningPapersList = useMemo(
    () => objectivePapers(session.paper.listening, "listening"),
    [session.paper.listening],
  );
  const readingPapersList = useMemo(
    () => objectivePapers(session.paper.reading, "reading"),
    [session.paper.reading],
  );
  const listeningMarked = useMemo(
    () => markPapers(listeningPapersList, session.answers),
    [listeningPapersList, session.answers],
  );
  const readingMarked = useMemo(
    () => markPapers(readingPapersList, session.answers),
    [readingPapersList, session.answers],
  );

  /*
    Everything the sitting will support saying about what to do next, and
    nothing beyond it. The writing line is the examiner's own words about the
    criterion it marked lowest, and it appears only where one criterion really
    is lower than another — four bands of 6 have no weakest of the four, and
    naming one anyway would be inventing a finding.
  */
  const plan = useMemo<PlanGroup[]>(() => {
    const groups: PlanGroup[] = [];
    const listening = observations("listening", listeningMarked, listeningPapersList);
    if (listening.length > 0) groups.push({ title: "Listening", observations: listening });
    const reading = observations("reading", readingMarked, readingPapersList);
    if (reading.length > 0) groups.push({ title: "Reading", observations: reading });

    const criteria = writingAttempts.flatMap((attempt) =>
      attempt.grade.criteria.map((c) => ({ ...c, task: attempt.task.task })),
    );
    const ranked = [...criteria].sort((a, b) => a.band - b.band);
    const lowest = ranked[0];
    const highest = ranked[ranked.length - 1];
    if (lowest && highest && lowest.band < highest.band) {
      const writing: Observation[] = [
        {
          id: "writing-lowest",
          fact: `On Task ${lowest.task} the examiner marked ${lowest.name} lowest, at band ${lowest.band}.`,
          fix: lowest.comment,
        },
      ];
      groups.push({ title: "Writing", observations: writing });
    }
    return groups;
  }, [listeningMarked, readingMarked, listeningPapersList, readingPapersList, writingAttempts]);

  if (grading || session.marks === null) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 py-10 text-center">
        <h1 className="text-[1.375rem] font-semibold text-slate-900"><LoadingIndicator label="Marking your exam" /></h1>
        <p className="text-sm leading-6 text-slate-600">
          Listening and Reading are marked already. The examiner is reading both writing tasks —
          this takes a few seconds.
        </p>
      </div>
    );
  }

  const marks = session.marks;
  /* An unmarked module and an empty one look the same in the report; only the
     first has anything to mark again. */
  const wroteSomething = tasks.some((t) => (session.essays[t.id] ?? "").trim().length > 0);
  const wrongOverall = countWrong(listeningMarked) + countWrong(readingMarked);
  const fallback =
    wrongOverall === 0
      ? "You did not lose a mark in Listening or Reading, so there is nothing here for your mistakes to point at."
      : "Your mistakes are spread across the question types and the parts of the paper rather than gathering in any one of them, so there is no single task to work on. The question-by-question review below, one explanation at a time, is where the marks are.";

  return (
    <div className="space-y-5">
      <section className="card flex flex-col items-center gap-5 py-7 sm:flex-row sm:justify-center sm:gap-10">
        {marks.overall !== null ? (
          /*
            No caption, so the badge prints its own — the CEFR level this band
            sits at. It used to be handed `bandLabel`, which is the line the
            badge already prints above it, so the disc said "Good user" twice.
          */
          <BandBadge band={marks.overall} />
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
            <Link href={`/exam/report?id=${encodeURIComponent(session.id)}`} className="btn-primary">
              Certificate and report
            </Link>
            <button type="button" className="btn-secondary" onClick={onRestart}>
              Sit another
            </button>
            <Link href="/plan" className="btn-secondary">
              Study plan
            </Link>
          </div>
        </div>
      </section>

      <ImprovementPlan groups={plan} fallback={fallback} />

      <ModuleSection
        title="Listening"
        band={marks.listening.band}
        raw={marks.listening.raw}
        total={marks.listening.total}
        note={objectiveNote(
          "listening",
          listeningPapersList,
          marks.listening.raw ?? 0,
          marks.listening.total ?? listeningMarked.length,
        )}
      >
        <ObjectiveReport
          papers={listeningPapersList}
          marked={listeningMarked}
          answers={session.answers}
        />
      </ModuleSection>

      <ModuleSection
        title="Reading"
        band={marks.reading.band}
        raw={marks.reading.raw}
        total={marks.reading.total}
        note={objectiveNote(
          "reading",
          readingPapersList,
          marks.reading.raw ?? 0,
          marks.reading.total ?? readingMarked.length,
        )}
      >
        <ObjectiveReport
          papers={readingPapersList}
          marked={readingMarked}
          answers={session.answers}
        />
      </ModuleSection>

      {/*
        The one thing a candidate could not do after three hours: ask again.

        When marking fell over — the model timing out, a 5xx, a connection that
        dropped — the report simply said Writing was not marked and stopped
        there. Sixty minutes of essay writing, two essays still sitting in the
        session, and no button. This is that button, and it appears only when
        all three things are true: the failure was the kind that asking again
        can fix, the module really is unmarked, and there is an essay to mark.
        A plan without AI marking answers 402 and is not offered a retry,
        because there is nothing on the other side of it.
      */}
      {markingFailure !== null && marks.writing === null && wroteSomething && (
        <div
          role="alert"
          className="card flex flex-col gap-2 !p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm leading-6 text-slate-700">
            Your essays were not marked. {markingFailure} They are still here, so nothing has been
            lost.
          </p>
          <button
            type="button"
            className="btn-primary shrink-0 !min-h-9 !px-4 !py-1.5 text-sm"
            onClick={() => void remark()}
            disabled={remarking}
          >
            {remarking ? (
              <LoadingIndicator label="Marking…" announce={false} />
            ) : (
              "Mark them now"
            )}
          </button>
        </div>
      )}

      <ModuleSection
        title="Writing"
        band={marks.writing?.band ?? null}
        note={writingNote(marks.writing !== null, writingAttempts)}
        openLabel="See the examiner's marking"
      >
        <WritingReport
          tasks={tasks}
          attempts={writingAttempts}
          essays={session.essays}
          unmarked={marks.writing === null}
        />
      </ModuleSection>

      <ModuleSection
        title="Speaking"
        band={marks.speaking?.band ?? null}
        note={
          marks.speaking === null
            ? "A three-part interview. It was not marked for this sitting."
            : "A three-part interview, marked by the AI examiner."
        }
        openLabel="See what was marked"
      >
        <SpeakingReport band={marks.speaking?.band ?? null} />
      </ModuleSection>
    </div>
  );
}

function countWrong(marked: MarkedQuestion[]): number {
  return marked.filter((m) => !m.correct).length;
}

function writingNote(marked: boolean, attempts: WritingResultAttempt[]): string {
  if (!marked) return "Two tasks. They were not marked for this sitting.";
  if (attempts.length === 0) return "Two tasks, marked by the AI examiner.";
  const bands = attempts
    .map((a) => `Task ${a.task.task} band ${a.grade.overallBand}`)
    .join(", ");
  return `${bands}. Task 2 counts double, which is the official weighting.`;
}
