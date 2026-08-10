"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TestQuestions, { type AnswerMap } from "@/components/TestQuestions";
import ExamShell from "@/components/exam/ExamShell";
import { playScript } from "@/lib/exam/playback";
import {
  MODULE_MINUTES,
  listeningPaper,
  listeningQuestions,
  sittingGroups,
  type MockPaper,
} from "@/lib/exam/mock";
import { useExamNavigation } from "@/lib/exam/navigation";
import { questionCount } from "@/lib/questions";
import { rankedEnglishVoices } from "@/lib/speech";

/*
  The listening paper of a mock sitting: four recordings, forty questions, one
  clock, and each recording played exactly once.

  ---------------------------------------------------------------------------
  What "played once" costs, and why it is the point

  Practice replays. It should — hearing the sentence you missed is the whole
  lesson. A sitting cannot, and the difference is not a setting: the entire
  difficulty of IELTS listening is that the answer goes past at the speed the
  speaker chose and does not come back. A mock that let you replay would return
  a band a candidate could not reproduce on the day, which is worse than
  returning no band at all.

  So `played` lives in the stored session rather than in component state, and
  the Play button for a part that has been heard is gone rather than disabled.
  Refreshing the page is the obvious way to try for a second listen, and it is
  the one that has to be closed.

  ---------------------------------------------------------------------------
  All forty questions are on screen from the start

  Which is what computer-delivered IELTS does, and is worth stating because the
  paper test does not feel like this. You may read ahead, you may go back, the
  palette numbers 1 to 40 straight through the four recordings. What you cannot
  do is hear Part 2 again once Part 3 has started.
*/

export default function MockListening({
  paper,
  answers,
  onAnswer,
  played,
  onPlayed,
  deadline,
  onFinish,
}: {
  paper: MockPaper;
  answers: AnswerMap;
  onAnswer: (id: string, value: string | number) => void;
  played: number[];
  onPlayed: (index: number) => void;
  deadline: number | null;
  onFinish: () => void;
}) {
  const tests = useMemo(
    () => paper.listening.map((id) => listeningPaper(id)).filter((t) => t !== undefined),
    [paper.listening],
  );

  /*
    Where each recording's questions start in the 1-40 numbering. Computed from
    the papers rather than assumed to be 10 apart, so a paper with a different
    count cannot silently renumber the ones after it.
  */
  const starts = useMemo(
    () =>
      tests.map((_, i) =>
        tests.slice(0, i).reduce((n, t) => n + questionCount(t.questions), 1),
      ),
    [tests],
  );

  /*
    Renamed once, here, and used for both the palette and the rendering. Two
    separate calls would produce two sets of equal-but-not-identical objects
    and the palette's ids would stop matching the anchors it scrolls to.
  */
  const groups = useMemo(
    () => tests.map((t) => sittingGroups(t.id, t.questions)),
    [tests],
  );
  const flat = useMemo(() => listeningQuestions(paper), [paper]);

  const nav = useExamNavigation(
    useMemo(
      () => flat.map((q) => ({ id: q.id, answered: answers[q.id] !== undefined })),
      [flat, answers],
    ),
  );

  const [playingPart, setPlayingPart] = useState<number | null>(null);
  const playingRef = useRef(false);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!supported) return;
    const load = () => {
      voicesRef.current = rankedEnglishVoices();
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      /* Disarm before cancelling — cancel() fires the current utterance's end
         handler, which would otherwise queue the next turn after unmount. */
      playingRef.current = false;
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  const play = useCallback(
    (index: number) => {
      const test = tests[index];
      if (!test || !supported || playingRef.current) return;
      /*
        Recorded as played the moment it starts, not when it ends. Stopping
        halfway through is a thing that happens in a real exam too — the tape
        does not rewind because you looked away.
      */
      onPlayed(index);
      window.speechSynthesis.cancel();
      playingRef.current = true;
      setPlayingPart(index);
      playScript(test, 0, {
        voices: voicesRef.current,
        rate: () => 1,
        stillPlaying: () => playingRef.current,
        onTurn: () => {},
        onEnd: () => {
          playingRef.current = false;
          setPlayingPart(null);
        },
      });
    },
    [tests, supported, onPlayed],
  );

  const finish = useCallback(() => {
    playingRef.current = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    onFinish();
  }, [onFinish]);

  /* The next recording that has not been heard, or null once all four have. */
  const nextUnplayed = tests.findIndex((_, i) => !played.includes(i));

  return (
    <ExamShell
      section="Listening"
      paper={`Parts 1–${tests.length}`}
      minutes={MODULE_MINUTES.listening}
      running
      endsAt={deadline}
      onExpire={finish}
      palette={nav.items}
      currentId={nav.currentId}
      onJump={nav.jump}
      onPrev={nav.prev}
      onNext={nav.next}
      onToggleReview={nav.toggleReview}
      onNextFlagged={nav.nextFlagged}
      topRight={
        playingPart !== null ? (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-fg)]">
            ▶ Part {playingPart + 1}
          </span>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
          The audio control sits above the paper rather than beside each part,
          because there is only ever one thing it can do: play the next
          recording. A row of four buttons would invite choosing, and there is
          no choosing — the exam plays them in order.
        */}
        <div className="mb-3 rounded-lg border border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 py-2">
          {!supported ? (
            <p className="text-sm leading-6">
              This browser cannot read the recordings aloud, so the listening paper cannot be
              sat here. Chrome, Edge and Safari can. The rest of the sitting works.
            </p>
          ) : playingPart !== null ? (
            <p className="text-sm leading-6">
              Part {playingPart + 1} is playing. It plays once, as in the exam — answer as you
              listen.
            </p>
          ) : nextUnplayed === -1 ? (
            <p className="text-sm leading-6">
              All four recordings have been played. Check your answers until the clock runs out,
              then finish.
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm leading-6">
                {nextUnplayed === 0
                  ? "Part 1 is ready. It plays once and cannot be repeated."
                  : `Part ${nextUnplayed + 1} of ${tests.length}. It plays once.`}
              </p>
              <button type="button" className="btn-primary" onClick={() => play(nextUnplayed)}>
                Play part {nextUnplayed + 1}
              </button>
            </div>
          )}
        </div>

        {tests.map((test, index) => (
          <section key={test.id} className="mb-6">
            <h2 className="mb-2 border-b border-[color:var(--exam-line)] pb-1 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-muted)]">
              Part {index + 1}
              {played.includes(index) ? "" : " — not yet played"}
            </h2>
            <TestQuestions
              questions={groups[index]}
              answers={answers}
              onAnswer={onAnswer}
              submitted={false}
              mode="exam"
              startNumber={starts[index]}
            />
          </section>
        ))}

        <button type="button" className="btn-primary mb-4 w-full" onClick={finish}>
          Finish the listening paper
        </button>
        <p className="mb-2 text-center text-[11px] text-[color:var(--exam-muted)]">
          You cannot come back to it.
        </p>
      </div>
    </ExamShell>
  );
}
