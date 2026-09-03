"use client";

import { Suspense, useCallback, useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import SpeakingSession from "@/components/speaking/SpeakingSession";
import MockListening from "@/components/exam/MockListening";
import MockReading from "@/components/exam/MockReading";
import MockResults from "@/components/exam/MockResults";
import MockRetakeResults from "@/components/exam/MockRetakeResults";
import MockSkillResults from "@/components/exam/MockSkillResults";
import MockWriting from "@/components/exam/MockWriting";
import { useMounted, useProfile } from "@/lib/hooks";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import {
  MODULE_MINUTES,
  MODULE_NAMES,
  MOCK_MODULES,
  abandonSession,
  clearSession,
  listeningPaper,
  newRetakeSession,
  newSession,
  newSingleSkillSession,
  nextStage,
  readingPaper,
  saveSession,
  serverSessionSnapshot,
  sessionSnapshot,
  subscribeSession,
  type MockMarks,
  type MockModule,
  type MockSession,
} from "@/lib/exam/mock";
import { questionCount } from "@/lib/questions";
import type { SpeakingGrade, SpeakingTranscriptTurn } from "@/lib/types";

/*
  A full IELTS sitting: Listening, Reading, Writing, Speaking, in that order,
  marked only at the end.

  ---------------------------------------------------------------------------
  The session is the source of truth, not this component

  Every change is written to storage immediately and read back on mount. That
  is not tidiness — it is the single most important property this feature has.
  A mock exam is two and three-quarter hours of somebody's Saturday, and the
  ways to lose it are ordinary: a reload, a phone locking, a browser
  reclaiming a background tab. Losing that is the worst thing this app could
  do to a person, and it would be entirely our fault.

  So the clock is stored as an absolute deadline, the answers are stored as
  they are typed, and which recordings have played is stored too — because
  otherwise a reload is a way to hear Part 2 again.

  ---------------------------------------------------------------------------
  Why a module cannot be re-entered

  Finishing Listening moves the stage on, and there is no way back. Without
  that rule the reading hour is not an hour: you would read the writing tasks,
  return to the passages with something to think about, and get a band that
  does not describe anything you could repeat on the day.
*/

/*
  A Suspense boundary because the retake link below carries its module and its
  sitting in the query string, and `useSearchParams` suspends. The pattern is
  the app's existing one — see app/exam/report/page.tsx and the organization
  query shells. The fallback is null rather than a spinner: the exam screen
  already renders nothing until `useMounted` says storage has been read, so a
  placeholder here would only add a flash the sitting does not want.
*/
export default function ExamPage() {
  return (
    <Suspense fallback={null}>
      <ExamRunner />
    </Suspense>
  );
}

function ExamRunner() {
  const mounted = useMounted();
  const router = useRouter();
  const profile = useProfile();
  const params = useSearchParams();
  const session = useSyncExternalStore(
    subscribeSession,
    sessionSnapshot,
    serverSessionSnapshot,
  );

  const update = useCallback((next: MockSession) => {
    saveSession(next);
  }, []);

  /*
    Leaving this page ends the sitting.

    The cleanup runs when this component unmounts, and the only thing that
    unmounts it is a navigation inside the app — tapping the menu, the logo,
    the account button. That is exactly the case the owner reported: leave the
    exam, read something else, come back, and find the clock still running on a
    paper you have had time to think about.

    A reload does not reach here at all. The browser discards the whole
    JavaScript context without asking React to unmount anything, so a refresh,
    a locked phone and a reclaimed background tab all resume as they always
    did — which is the behaviour a three-hour sitting has to have.

    The pathname check is what makes it safe in development, where React's
    StrictMode mounts every component, unmounts it and mounts it again to prove
    effects can survive it. That teardown is not a navigation, and the address
    bar says so: it still reads /exam. Without the check, starting a mock in
    development ends it in the same frame.
  */
  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;
      if (window.location.pathname.startsWith("/exam")) return;
      abandonSession();
    };
  }, []);

  const start = useCallback(() => {
    const fresh = newSession();
    fresh.deadline = Date.now() + MODULE_MINUTES.listening * 60_000;
    update(fresh);
  }, [update]);

  /**
   * Start a standalone single-skill exam: one module, sat on its own, with no
   * earlier sitting behind it.
   *
   * The deadline is computed the same way the retake-starting effect below
   * computes one, and for the same reason: `fresh.stage` is `MockSession`'s
   * general "which stage" field, so it reads as `MockModule | "results"` to
   * the compiler even though `newSingleSkillSession` only ever sets it to the
   * module just chosen. Both branches are excluded rather than assumed away —
   * "results" because the type admits it, "speaking" because it really can
   * arrive here: the check exists for the day something other than today's
   * "One skill" chooser calls this with "speaking", since that chooser itself
   * sends Speaking to /speaking, which is already this exact sitting.
   */
  const startSingleSkill = useCallback(
    (module: MockModule) => {
      const fresh = newSingleSkillSession(module);
      fresh.deadline =
        fresh.stage === "speaking" || fresh.stage === "results"
          ? null
          : Date.now() + MODULE_MINUTES[fresh.stage] * 60_000;
      update(fresh);
    },
    [update],
  );

  /**
   * Move to the next module, starting its clock. Speaking runs without one.
   *
   * Through `nextStage` rather than by indexing MOCK_MODULES here, because a
   * One Skill Retake covers one module and finishing it means finishing the
   * sitting. Asking the session which modules it covers is the only version of
   * this that cannot walk a retake into a paper it never opened.
   */
  const advance = useCallback(
    (from: MockModule) => {
      if (!session || session.stage !== from) return;
      const next = nextStage(session, from);
      update({
        ...session,
        stage: next,
        deadline:
          next === "results" || next === "speaking"
            ? null
            : Date.now() + MODULE_MINUTES[next] * 60_000,
      });
    },
    [session, update],
  );

  const answer = useCallback(
    (id: string, value: string | number) => {
      if (!session) return;
      update({ ...session, answers: { ...session.answers, [id]: value } });
    },
    [session, update],
  );

  const write = useCallback(
    (taskId: string, text: string) => {
      if (!session) return;
      update({ ...session, essays: { ...session.essays, [taskId]: text } });
    },
    [session, update],
  );

  const markPlayed = useCallback(
    (index: number) => {
      if (!session || session.played.includes(index)) return;
      update({ ...session, played: [...session.played, index] });
    },
    [session, update],
  );

  /*
    The end of the interview, and everything the examiner said about it.

    The grade and the transcript are optional parameters rather than required
    ones, and that is what lets this land ahead of the other half. Today
    components/speaking/SpeakingSession.tsx calls `onFinish(band)` and the two
    extra arguments arrive as undefined, which the session reads as "not kept"
    exactly the way an older stored sitting does. The moment that component
    widens its own `exam.onFinish` type and passes what it already has in hand,
    the whole grade flows into the sitting with nothing here to change.
  */
  const finishSpeaking = useCallback(
    (
      band: number | null,
      grade?: SpeakingGrade | null,
      transcript?: SpeakingTranscriptTurn[],
    ) => {
      if (!session) return;
      update({
        ...session,
        speakingBand: band,
        speakingGrade: grade,
        speakingTranscript: transcript,
        stage: "results",
        deadline: null,
      });
    },
    [session, update],
  );

  const setMarks = useCallback(
    (marks: MockMarks) => {
      if (!session) return;
      update({ ...session, marks });
    },
    [session, update],
  );

  const restart = useCallback(() => {
    clearSession();
  }, []);

  /*
    Starting a One Skill Retake, asked for by the link on /history.

    Two guards, and the first one is the important one. If a session already
    exists it wins, always — someone two hours into a full sitting who lands
    here with a stale retake link in their history must not have that sitting
    replaced by a thirty-minute Listening paper. The link is simply ignored, and
    the sitting is drawn as normal.

    The second guard is that the retake has to name a sitting this learner
    actually has. A retake exists to update a report; one attached to a report
    id that is not in the archive would be marked, recorded, and never appear
    anywhere — a band earned and silently lost, which is the failure this whole
    feature is most obliged to avoid.

    The query is then replaced away, so a reload of the results screen cannot
    read the same link again and start a second retake over the first.
  */
  useEffect(() => {
    if (!mounted || session) return;
    const skill = params.get("retake");
    const of = params.get("of");
    if (!skill || !of) return;
    if (!MOCK_MODULES.includes(skill as MockModule)) return;
    if (!profile.mockReports?.some((report) => report.id === of)) return;

    const fresh = newRetakeSession(skill as MockModule, of);
    fresh.deadline =
      fresh.stage === "speaking" || fresh.stage === "results"
        ? null
        : Date.now() + MODULE_MINUTES[fresh.stage] * 60_000;
    saveSession(fresh);
    router.replace("/exam");
  }, [mounted, session, params, profile.mockReports, router]);

  /* Nothing is drawn until storage has been read, or the clock flashes wrong. */
  if (!mounted) return null;

  if (!session) return <StartScreen onStart={start} onStartSkill={startSingleSkill} />;

  switch (session.stage) {
    case "listening":
      return (
        <MockListening
          paper={session.paper}
          answers={session.answers}
          onAnswer={answer}
          played={session.played}
          onPlayed={markPlayed}
          deadline={session.deadline}
          onFinish={() => advance("listening")}
        />
      );
    case "reading":
      return (
        <MockReading
          paper={session.paper}
          answers={session.answers}
          onAnswer={answer}
          deadline={session.deadline}
          onFinish={() => advance("reading")}
        />
      );
    case "writing":
      return (
        <MockWriting
          paper={session.paper}
          essays={session.essays}
          onWrite={write}
          deadline={session.deadline}
          onFinish={() => advance("writing")}
        />
      );
    case "speaking":
      return (
        <div className="mx-auto max-w-3xl space-y-3">
          <p className="text-inset-compact rounded-lg bg-indigo-50 py-2 text-sm leading-6 text-indigo-800">
            Last module. The examiner speaks, you answer out loud, and your band for the whole
            sitting appears when the interview ends.
          </p>
          <SpeakingSession exam={{ onFinish: finishSpeaking }} />
        </div>
      );
    case "results":
      /*
        A session with a `retake` never reaches MockResults, and that
        separation is load-bearing rather than cosmetic. MockResults marks
        every module of the paper it is handed; a solo session's paper carries
        all four for the reasons `newSoloSession` sets out, but only one of
        them was ever opened, so the other three would be scored as forty
        unanswered questions and written into the learner's history as band 2.
        The routing here is what makes that impossible.

        The second branch is the same distinction `MockRetakeIntent` itself
        draws: `of` present is a One Skill Retake, updating a report that
        already exists, and goes to MockRetakeResults; `of` absent is a
        standalone single-skill exam, with no report to update, and goes to
        MockSkillResults. Getting this wrong in either direction would be
        silent and wrong in opposite ways — a standalone sitting marked as a
        retake would go looking for a report that was never sat, and a retake
        marked as standalone would leave the report it was booked against
        exactly as it was before.
      */
      if (!session.retake) {
        return <MockResults session={session} onMarks={setMarks} onRestart={restart} />;
      }
      return session.retake.of ? (
        <MockRetakeResults session={session} onLeave={restart} />
      ) : (
        <MockSkillResults session={session} onLeave={restart} />
      );
  }
}

function StartScreen({
  onStart,
  onStartSkill,
}: {
  onStart: () => void;
  /** Starts a standalone single-skill exam — see the "One skill" card below. */
  onStartSkill: (module: MockModule) => void;
}) {
  /*
    What this sitting will and will not mark, for whoever is about to spend
    three hours on it.

    The exam itself is deliberately ungated, unlike /speaking and
    /practice/writing, and it should stay that way: walling someone out of a
    module halfway through a timed sitting is worse than letting them sit it.
    But the two AI-marked modules come back with no band for an account that
    cannot reach the marker, and the way that failure surfaces is a report with
    a gap in it, three hours later — the request is refused and the result
    screen swallows it. Being told beforehand is the difference between a
    choice and a surprise.

    The same reasoning carries over to a standalone Writing exam below: it is
    a real sitting rather than a lesson, and the honest gap belongs on this
    screen, before the hour is spent, not as a surprise on the results screen
    after it. Listening and Reading never need this notice at all — both are
    marked from an answer key, on every tier, always.
  */
  const access = useSessionAccess();
  const unmarked = (["writing", "speaking"] as const).filter(
    (module) => access[module].locked && !access[module].pending,
  );

  /*
    Counted from the papers rather than written down, so the screen cannot
    promise forty questions and hand over thirty-nine.
  */
  const sample = newSession().paper;
  const listeningQs = sample.listening.reduce(
    (n, id) => n + questionCount(listeningPaper(id)?.questions ?? []),
    0,
  );
  const readingQs = sample.reading.reduce(
    (n, id) => n + questionCount(readingPaper(id)?.questions ?? []),
    0,
  );

  const rows: { module: MockModule; detail: string }[] = [
    { module: "listening", detail: `${listeningQs} questions · 4 recordings` },
    { module: "reading", detail: `${readingQs} questions · 3 passages` },
    { module: "writing", detail: "2 tasks" },
    { module: "speaking", detail: "3 interview parts" },
  ];

  return (
    <section className="exam-start mx-auto flex h-[calc(100dvh-var(--header-h))] w-full max-w-6xl items-center overflow-y-auto px-3 sm:px-5">
      {/*
        The clear choice the owner asked for: a full sitting or one skill,
        both visible together rather than a step a learner has to find. Two
        cards rather than one growing to hold both, because "which of these am
        I choosing" reads faster from two labelled boxes than from a single
        page where a heading changes meaning halfway down.
      */}
      <div className="mx-auto flex w-full flex-col gap-3">
      <div className="exam-start-window card premade-glass relative mx-auto w-full overflow-hidden !p-[clamp(1rem,3vw,2rem)]">
        <div className="exam-start-content premade-glass-content mx-auto w-full space-y-[clamp(0.75rem,2.4vh,1.5rem)]">
        <header className="max-w-2xl">
          <p className="liquid-glass mb-2 inline-flex min-h-7 items-center rounded-full border px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-indigo-700">
            Full sitting
          </p>
          <h1 className="text-[clamp(1.9rem,5vw,3.5rem)] font-semibold leading-none tracking-tight text-slate-900">
            Full mock exam
          </h1>
          <p className="exam-start-summary mt-2 text-[clamp(0.82rem,1.8vw,1rem)] leading-snug text-slate-600">
            All four IELTS skills, real timings, results only at the end.
          </p>
        </header>

        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          {/* Padding and radius move together, which they did not: a 28pt
              corner around a 12pt inset draws the arc through the module's own
              name. Centred as well — four tiles of two or three short lines
              each read as a row of labels rather than a list, and ragged left
              edges inside rounded boxes made the grid look misaligned when it
              was not. */}
          {rows.map(({ module, detail }) => (
            <li key={module} className="liquid-glass min-w-0 rounded-[var(--radius-xl)] border px-4 py-3.5 text-center">
              <span className="block text-sm font-semibold text-slate-900">
                {MODULE_NAMES[module]}
              </span>
              {/* Allowed to wrap rather than truncate. The line exists to say how
                  many recordings or passages there are, and on a phone
                  `truncate` cut it off at exactly that number — "40 questions ·
                  4 re…" — so the tile kept the part a learner already knew and
                  threw away the part it was there to tell them. */}
              <span className="block text-xs text-slate-500">{detail}</span>
              <span className="mt-0.5 block text-xs font-medium tabular-nums text-slate-700">
                {MODULE_MINUTES[module]} min
              </span>
            </li>
          ))}
        </ul>

        <div className="exam-start-notes grid gap-1 text-xs leading-snug text-slate-600 sm:grid-cols-2 sm:gap-x-8">
          <p>
            <strong className="font-semibold text-slate-800">Allow about three hours.</strong>{" "}
            Modules advance automatically and cannot be reopened.
          </p>
          <p>
            Reloading keeps your place. Leaving this page ends the exam. Restarting is free.
          </p>
        </div>

        <UnmarkedNotice modules={unmarked} />

        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
          <button className="btn-primary premade-glass min-w-44" onClick={onStart}>
            <span className="premade-glass-content">Start exam</span>
          </button>
          <p className="exam-start-alternative text-xs text-slate-500 sm:pl-2">
            Not ready for a full sitting?{" "}
            <Link href="/practice" className="font-medium underline underline-offset-4">
              Practise one skill
            </Link>
          </p>
        </div>
        </div>
      </div>

      {/*
        Deliberately not a fifth thing called "practice" — /practice already
        is that, untimed and marked as you go. This is the exam's own real
        timing and its own silence until the end, applied to a single module
        instead of four, which is a different activity from either of the
        other two cards on this page and needs its own name rather than
        borrowing one.
      */}
      <div className="exam-start-window card premade-glass relative mx-auto w-full overflow-hidden !p-[clamp(1rem,3vw,2rem)]">
        <div className="premade-glass-content mx-auto w-full space-y-3">
          <header className="max-w-2xl">
            <p className="liquid-glass mb-2 inline-flex min-h-7 items-center rounded-full border px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-indigo-700">
              One skill
            </p>
            <h2 className="text-[clamp(1.15rem,2.6vw,1.5rem)] font-semibold leading-none tracking-tight text-slate-900">
              Sit one skill on its own
            </h2>
            <p className="mt-2 text-[clamp(0.8rem,1.6vw,0.9375rem)] leading-snug text-slate-600">
              The complete paper for one skill, at its own real timing, marked the same way as a
              full sitting — silence until the end, then a band. It is a full exam of one module,
              not a shortened one.
            </p>
          </header>

          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
            {rows.map(({ module, detail }) => {
              /*
                Speaking's tile leaves through /speaking rather than this
                screen's own session machinery. That page already is the
                complete interview, sat and marked on exactly these terms —
                rebuilding it here would be a second copy of a working thing
                for no learner-visible gain, only a second place to keep it
                right.
              */
              const tile = (
                <>
                  <span className="block text-sm font-semibold text-slate-900">
                    {MODULE_NAMES[module]}
                  </span>
                  <span className="block text-xs text-slate-500">{detail}</span>
                  <span className="mt-0.5 block text-xs font-medium tabular-nums text-slate-700">
                    {MODULE_MINUTES[module]} min
                  </span>
                </>
              );
              const tileClass =
                "liquid-glass block min-w-0 rounded-[var(--radius-xl)] border px-4 py-3.5 text-center transition-colors hover:bg-surface/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500";
              return (
                <li key={module}>
                  {module === "speaking" ? (
                    <Link href="/speaking" className={tileClass}>
                      {tile}
                    </Link>
                  ) : (
                    <button type="button" onClick={() => onStartSkill(module)} className={`${tileClass} w-full`}>
                      {tile}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {/*
            Scoped to Writing alone, unlike the full sitting's notice above.
            Speaking is not a button in this card — it leaves through
            /speaking, which carries its own lock — so naming it here would be
            warning about a door this card never opens.
          */}
          <UnmarkedNotice modules={unmarked.filter((module) => module === "writing")} />
        </div>
      </div>
      </div>
    </section>
  );
}

/**
 * The one honest thing a screen about to start an AI-marked module has to say
 * beforehand: which of them this account cannot get a band for.
 *
 * Shared between the full-sitting card and the one-skill card above rather
 * than written twice, because it is the same fact stated at the same moment —
 * before the clock starts, not after. "Missing" rather than "missing from
 * your report": the full sitting has a report to be missing from and a
 * standalone single-skill exam never does, and one sentence has to be true
 * for both callers.
 */
function UnmarkedNotice({ modules }: { modules: readonly ("writing" | "speaking")[] }) {
  if (modules.length === 0) return null;
  return (
    <p
      role="status"
      className="text-inset-compact rounded-lg bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900"
    >
      <strong className="font-semibold">
        {modules.map((module) => MODULE_NAMES[module]).join(" and ")} will not be marked on this
        account.
      </strong>{" "}
      You can still sit {modules.length === 1 ? "it" : "them"}, and everything else is marked as
      usual — but {modules.length === 1 ? "that band" : "those bands"} will be missing.{" "}
      {/* No route to a billing page from the iOS bundle: those pages are not in
          it, and pointing at one is what the App Store rules are about. The
          sentence still has to say what would fix it. */}
      {IS_MOBILE_BUILD ? (
        "Marking is part of a paid plan."
      ) : (
        <>
          Marking is part of a paid plan; see the{" "}
          <Link href="/pricing" className="font-medium underline underline-offset-4">
            plans
          </Link>
          .
        </>
      )}
    </p>
  );
}
