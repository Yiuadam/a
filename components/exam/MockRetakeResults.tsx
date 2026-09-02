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
  recordRetake,
  writingBand,
  writingTask,
  type MockModule,
  type MockSession,
  type ModuleMark,
} from "@/lib/exam/mock";
import { standingFor, type StandingRecord } from "@/lib/exam/report";
import { testAdvice } from "@/lib/advice";
import { useProfile } from "@/lib/hooks";
import { buildReview } from "@/lib/review";
import { addResult } from "@/lib/store";
import { savedAnswers } from "@/lib/results";
import type { ModuleResultReview, WritingGrade } from "@/lib/types";

/*
  What a One Skill Retake reports, which is not what a full sitting reports.

  ---------------------------------------------------------------------------
  Why this is its own screen rather than a flag on MockResults

  A full sitting's report is a document: four bands, an overall, a certificate,
  and every question that was wrong across two forty-question papers. A retake
  produces one band, and the only interesting thing about it is what it did to
  the report the learner already had — did Listening go up, and did the overall
  move with it. Rendering that through a four-module report would mean three
  panels reading "not sat" and an overall drawn from numbers this sitting never
  measured. Two different questions, two screens.

  The separation earns its keep in the marking as well. This screen scores
  exactly the module in `session.retake`, so a retake can never write a band for
  a paper nobody opened — which is the mistake that would be invisible while it
  happened and permanent afterwards.
*/

function markLabel(mark: ModuleMark): string {
  return mark.raw !== undefined && mark.total !== undefined
    ? `${mark.raw}/${mark.total} correct`
    : bandLabel(mark.band);
}

/** The band this skill carried before today, or null if it had none. */
function bandBefore(standing: StandingRecord | null, module: MockModule): number | null {
  const entry = standing?.modules.find((item) => item.module === module);
  if (!entry) return null;
  return entry.original ?? entry.band;
}

export default function MockRetakeResults({
  session,
  onLeave,
}: {
  session: MockSession;
  /** Ends the session, exactly as "Sit another" does after a full sitting. */
  onLeave: () => void;
}) {
  const profile = useProfile();
  const retake = session.retake;

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

  /*
    The report as it stood *before* this retake was recorded, computed once on
    the first render and never again.

    It has to be frozen, because recording the retake changes the profile this
    would otherwise be derived from — read live, "your Listening was 6.0" would
    become "your Listening was 7.0" the instant the 7.0 landed, and the one
    sentence this screen exists to say would say nothing. A lazy `useState`
    initialiser rather than a ref: both freeze the value, and only one of them
    is a value React is allowed to read while rendering.
  */
  const [before] = useState<StandingRecord | null>(() => {
    if (!retake) return null;
    const report = profile.mockReports?.find((item) => item.id === retake.of);
    return report ? standingFor(report, profile.mockRetakes) : null;
  });

  const listeningSet = useMemo(() => listeningQuestions(session.paper), [session.paper]);
  const readingSet = useMemo(() => readingQuestions(session.paper), [session.paper]);

  const run = useCallback(async () => {
    if (!retake) return;
    const at = new Date().toISOString();
    let scored: ModuleMark | null = null;
    let review: ModuleResultReview | undefined;

    if (retake.module === "listening" || retake.module === "reading") {
      /*
        Both objective papers are scored and one is kept. `markObjective` is the
        function a full sitting is marked with, and marking a retake through the
        same code is the point: a band earned in a retake has to mean exactly
        what the same band meant in the sitting it replaces, or the standing
        report is averaging two different scales.
      */
      scored = markObjective(session.paper, session.answers)[retake.module];
      const set = retake.module === "listening" ? listeningSet : readingSet;
      const items = buildReview(set, session.answers);
      review = {
        kind: "objective",
        questions: set,
        answers: savedAnswers(session.answers),
        advice: testAdvice(retake.module, set, items.map((item) => item.id), scored.band),
        source:
          retake.module === "listening"
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
    } else if (retake.module === "writing") {
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
        The same rule a full sitting uses: one marked task is enough for a band,
        two nulls means the module was not marked at all — which is different
        from a candidate who wrote nothing, and they do get a band, and it is a
        low one.
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
      scored =
        session.speakingBand === undefined || session.speakingBand === null
          ? null
          : { band: session.speakingBand };
      /*
        The interview and what the examiner said about it, saved on exactly the
        terms standalone speaking already saves them (SpeakingSession.tsx writes
        the same `SpeakingResultReview`, and app/privacy/page.tsx describes it).
        Same shape rather than a new one, so a retaken interview is reopenable
        like any other — and so the tutor, which reads saved results rather
        than any record of its own, sees this one on the same terms as a
        practice interview and on no other terms. (There used to be a switch
        governing that; there is not one now, and clearing history is what
        withholds it.)

        Both halves are required before anything is written. A grade with no
        transcript is feedback about words nobody can see, and a transcript
        with no grade is a record with nothing said about it; the band alone is
        recorded in either case, which is what a sitting stored before the
        session kept these will have.
      */
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
      Recorded in the same order a full sitting records, and for the same
      reasons. `recordRetake` writes nothing at all when the module could not be
      marked, so the standing report keeps the band it had rather than losing it
      to an attempt at improving it. The per-module row goes into `results` as
      well, because the study plan and the history graphs read bands from there
      and a retake is the most current thing a learner has done.
    */
    if (!scored) return;
    recordRetake(session, scored, at);
    addResult({
      module: retake.module,
      testId: `${session.id}-${retake.module}`,
      testTitle: `One skill retake — ${MODULE_NAMES[retake.module]}`,
      band: scored.band,
      raw: scored.raw,
      total: scored.total,
      date: at,
      review,
    });
  }, [retake, session, listeningSet, readingSet]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  /*
    Marking again after it failed, which here is simply running the same pass a
    second time.

    That is safe in a way it is not after a full sitting: this callback writes
    nothing at all unless it produced a band — `if (!scored) return` above — so
    a failed pass leaves the standing report, the retake record and the history
    row all untouched, and there is nothing for a second pass to duplicate.
  */
  const remark = useCallback(() => {
    setMarking(true);
    setMarkingFailure(null);
    void run();
  }, [run]);

  if (!retake) return null;

  if (marking) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 py-10 text-center">
        <h1 className="text-[22px] font-semibold text-slate-900">
          <LoadingIndicator label={`Marking your ${MODULE_NAMES[retake.module]} retake`} />
        </h1>
        <p className="text-sm leading-6 text-slate-600">
          Your other three bands are not being re-marked — a retake only changes the skill you sat.
        </p>
      </div>
    );
  }

  const previous = bandBefore(before, retake.module);
  const overallBefore = before?.overall ?? null;

  /*
    The report as it stands now, derived from the profile live rather than
    frozen — this is the number the learner walks away with, so it has to be the
    one history will show them a moment later.
  */
  const report = profile.mockReports?.find((item) => item.id === retake.of);
  const after = report ? standingFor(report, profile.mockRetakes) : null;

  const delta = mark && previous !== null ? Math.round((mark.band - previous) * 10) / 10 : null;
  /*
    Held as the narrowed module rather than a boolean, because `testAdvice` and
    `buildReview` only speak the two objective modules and a boolean does not
    narrow a union for the compiler.
  */
  const objective: "listening" | "reading" | null =
    retake.module === "listening" || retake.module === "reading" ? retake.module : null;
  const set = objective === "reading" ? readingSet : listeningSet;
  const items = objective ? buildReview(set, session.answers) : [];

  return (
    <div className="space-y-5">
      {/*
        First thing on the page, above the band ring, because until it is dealt
        with the ring is showing a number that does not include the paper the
        learner just sat. Marking a retake that failed used to leave them with
        "not marked" and nowhere to go — an hour of writing, the essays still in
        the session, and no button.
      */}
      {markingFailure !== null && mark === null && (
        <div
          role="alert"
          className="card flex flex-col gap-2 !p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm leading-6 text-slate-700">
            Your retake was not marked. {markingFailure} Your answers are still here, and your
            standing band has not been changed.
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
        {/* No `caption`: BandBadge prints bandLabel as its own first line, so
            passing it again renders "Good user" twice. */}
        {after?.overall !== null && after?.overall !== undefined ? (
          <BandBadge band={after.overall} />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-center text-xs leading-4 text-slate-400">
            no overall band
          </div>
        )}
        <div className="max-w-md space-y-2 text-sm leading-6 text-slate-600">
          <h1 className="text-lg font-semibold text-slate-900">
            {MODULE_NAMES[retake.module]} retake
          </h1>
          {mark === null ? (
            <p>
              This retake could not be marked, so nothing has changed. Your{" "}
              {MODULE_NAMES[retake.module]} band is still{" "}
              <span className="font-semibold">{previous ?? "unrecorded"}</span> — a retake that
              cannot be scored must never take away a band you already earned. You can sit it again
              whenever marking is available.
            </p>
          ) : (
            <>
              {/* Neutral about direction on purpose: the sentence has to read
                  the same whether the retake went up or down, and the one after
                  it says which. */}
              <p>
                Your new {MODULE_NAMES[retake.module]} band is{" "}
                <span className="font-semibold">{mark.band}</span>
                {previous !== null ? `, where the sitting it replaces gave ${previous}` : null}.{" "}
                {markLabel(mark)}.
              </p>
              {previous !== null && delta !== null && (
                <p>
                  {delta > 0
                    ? `That is ${delta} of a band better than the sitting it replaces.`
                    : delta < 0
                      ? `That is ${Math.abs(delta)} lower than the sitting it replaces. The original band stays on your record beside it — the standing band is what you would score today, not your best day.`
                      : "The same band as the sitting it replaces."}
                </p>
              )}
              {after?.overall !== null && after?.overall !== undefined ? (
                <p>
                  Your overall band is now{" "}
                  <span className="font-semibold">{after.overall}</span>
                  {overallBefore !== null && overallBefore !== after.overall
                    ? ` — it was ${overallBefore}.`
                    : overallBefore !== null
                      ? " — unchanged, because the mean of four bands still rounds to the same half."
                      : ", now that all four skills are marked."}
                </p>
              ) : (
                <p>
                  There is still no overall band, because{" "}
                  {(after?.unmarked ?? []).map((name) => MODULE_NAMES[name]).join(" and ")}{" "}
                  {(after?.unmarked.length ?? 0) > 1 ? "have" : "has"} never been marked. An overall
                  is the mean of four.
                </p>
              )}
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
