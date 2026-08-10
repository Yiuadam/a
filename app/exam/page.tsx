"use client";

import { useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { SpeakingSession } from "@/app/speaking/page";
import MockListening from "@/components/exam/MockListening";
import MockReading from "@/components/exam/MockReading";
import MockResults from "@/components/exam/MockResults";
import MockWriting from "@/components/exam/MockWriting";
import { useMounted } from "@/lib/hooks";
import {
  MODULE_MINUTES,
  MODULE_NAMES,
  MOCK_MODULES,
  clearSession,
  listeningPaper,
  newSession,
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

export default function ExamPage() {
  const mounted = useMounted();
  const session = useSyncExternalStore(
    subscribeSession,
    sessionSnapshot,
    serverSessionSnapshot,
  );

  const update = useCallback((next: MockSession) => {
    saveSession(next);
  }, []);

  const start = useCallback(() => {
    const fresh = newSession();
    fresh.deadline = Date.now() + MODULE_MINUTES.listening * 60_000;
    update(fresh);
  }, [update]);

  /** Move to the next module, starting its clock. Speaking runs without one. */
  const advance = useCallback(
    (from: MockModule) => {
      if (!session || session.stage !== from) return;
      const index = MOCK_MODULES.indexOf(from);
      const next = MOCK_MODULES[index + 1];
      if (!next) {
        update({ ...session, stage: "results", deadline: null });
        return;
      }
      update({
        ...session,
        stage: next,
        deadline: next === "speaking" ? null : Date.now() + MODULE_MINUTES[next] * 60_000,
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

  const finishSpeaking = useCallback(
    (band: number | null) => {
      if (!session) return;
      update({ ...session, speakingBand: band, stage: "results", deadline: null });
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

  /* Nothing is drawn until storage has been read, or the clock flashes wrong. */
  if (!mounted) return null;

  if (!session) return <StartScreen onStart={start} />;

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
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
            Last module. The examiner speaks, you answer out loud, and your band for the whole
            sitting appears when the interview ends.
          </p>
          <SpeakingSession exam={{ onFinish: finishSpeaking }} />
        </div>
      );
    case "results":
      return <MockResults session={session} onMarks={setMarks} onRestart={restart} />;
  }
}

function StartScreen({ onStart }: { onStart: () => void }) {
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
    { module: "listening", detail: `4 recordings, ${listeningQs} questions, each played once` },
    { module: "reading", detail: `3 passages, ${readingQs} questions, one hour between them` },
    { module: "writing", detail: "Task 1 and Task 2, one hour between them" },
    { module: "speaking", detail: "3 parts with the examiner, out loud" },
  ];

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="card space-y-4 py-7">
        <h1 className="text-[26px] font-semibold text-slate-900">Full mock exam</h1>
        <p className="text-sm leading-6 text-slate-600">
          The whole exam, in the order you will sit it, with the real timings. Nothing is marked
          and nothing is explained until the end — that is what makes the band mean something.
        </p>

        <ul className="space-y-2">
          {rows.map(({ module, detail }) => (
            <li
              key={module}
              className="flex items-baseline justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"
            >
              <span className="text-sm font-medium text-slate-800">{MODULE_NAMES[module]}</span>
              <span className="text-right text-xs text-slate-500">
                {detail}
                <span className="ml-2 tabular-nums text-slate-400">
                  {MODULE_MINUTES[module]} min
                </span>
              </span>
            </li>
          ))}
        </ul>

        <div className="space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
          <p>
            Set aside about three hours. Each module has its own clock, moves on by itself when
            the time is up, and cannot be re-entered.
          </p>
          <p>
            A reload will not lose your place — your answers and the clock are saved as you go.
            Closing the tab ends the sitting, in the same way that walking out of one does.
          </p>
        </div>

        <button className="btn-primary w-full" onClick={onStart}>
          Start the exam
        </button>
        <p className="text-center text-xs text-slate-400">
          Want to work on one skill instead?{" "}
          <Link href="/practice" className="underline underline-offset-4">
            Practice
          </Link>{" "}
          marks as you go and explains every answer.
        </p>
      </div>
    </div>
  );
}
