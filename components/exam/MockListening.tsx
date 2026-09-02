"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TestQuestions, { type AnswerMap } from "@/components/TestQuestions";
import ExamShell from "@/components/exam/ExamShell";
import { playBundledListening, type ListeningPlayback } from "@/lib/exam/listening-player";
import { playScript } from "@/lib/exam/playback";
import {
  MODULE_MINUTES,
  listeningPaper,
  listeningQuestions,
  sittingGroups,
  type MockPaper,
} from "@/lib/exam/mock";
import { useExamNavigation } from "@/lib/exam/navigation";
import { bundledListeningAudio } from "@/lib/listening-audio";
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
  The sitting hears the same recordings everybody else does

  This screen used to call playScript and nothing else, which meant the four
  papers were read out by whatever voices the device happened to carry, at
  whatever accents those voices happened to be. Practice had already moved on:
  it plays the reviewed Aura MP3s from /api/listening-audio, one per dialogue
  turn, cast per speaker and identical for every learner. The sitting was
  therefore the one screen in the app that scored a candidate against a
  recording nobody else heard — a mock whose difficulty depended on which
  phone it ran on, which is precisely the thing a mock is for eliminating.

  So it takes the same path, through lib/exam/listening-player.ts, and keeps
  browser speech underneath as recovery rather than as the plan. The recovery
  is deliberately not a restart: a paper that breaks after the candidate has
  heard some of it resumes speaking from the turn it reached, because in a
  sitting the alternative is either losing the rest of a recording that cannot
  be replayed or playing the opening of it a second time.

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
  const [failedPart, setFailedPart] = useState<{ index: number; heard: boolean; message: string } | null>(null);
  const playingRef = useRef(false);
  const playbackRunRef = useRef(0);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const playerRef = useRef<ListeningPlayback | null>(null);
  /*
    Whether this recording has been audible at all, and therefore spent.

    A ref rather than a local, because the answer now has to survive a handover
    from the MP3 player to browser speech: a paper that fails after the
    candidate heard half of it is already used up, and the recovery path must
    not be able to hand it back by locking it a second time or by offering a
    retry of something that has been heard.
  */
  const heardRef = useRef(false);
  const nativeAudioRef = useRef<HTMLAudioElement | null>(null);
  const nativeAudioBufferRef = useRef<HTMLAudioElement | null>(null);

  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  /*
    Every paper in a sitting comes from the reviewed catalogue, so every one of
    them has server recordings. That makes the sitting playable in a browser
    with no SpeechSynthesis at all, because playing an MP3 is enough, which is
    why support is no longer a question about the Web Speech API alone.
  */
  const serverAudioReady = useMemo(
    () => tests.length > 0 && tests.every((test) => (bundledListeningAudio(test.id)?.parts.length ?? 0) > 0),
    [tests],
  );
  const supported = serverAudioReady || ttsSupported;

  useEffect(() => {
    if (!ttsSupported) return;
    const load = () => {
      voicesRef.current = rankedEnglishVoices();
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      /* Disarm before cancelling — cancel() fires the current utterance's end
         handler, which would otherwise queue the next turn after unmount. */
      playbackRunRef.current += 1;
      playingRef.current = false;
      window.speechSynthesis.cancel();
    };
  }, [ttsSupported]);

  // The MP3 player holds two media elements and its own listeners, and neither
  // stops itself when the sitting leaves this screen.
  useEffect(
    () => () => {
      playbackRunRef.current += 1;
      playingRef.current = false;
      playerRef.current?.stop();
      playerRef.current = null;
    },
    [],
  );

  /** Lock a recording exactly once, and only after real sound has been made. */
  const markHeard = useCallback(
    (run: number, index: number) => {
      if (playbackRunRef.current !== run || heardRef.current) return;
      heardRef.current = true;
      onPlayed(index);
    },
    [onPlayed],
  );

  /*
    Browser speech, as recovery.

    `from` is the dialogue turn to resume at, which is 0 only when nothing has
    been heard yet. When the MP3s failed partway through it is the turn they
    reached, so the candidate hears the rest of the paper in a worse voice
    rather than losing it — a sitting cannot offer the recording again.
  */
  const speakScript = useCallback(
    (run: number, index: number, from: number) => {
      const test = tests[index];
      const stop = (message: string) => {
        if (playbackRunRef.current !== run) return;
        playingRef.current = false;
        setPlayingPart(null);
        setFailedPart({ index, heard: heardRef.current, message });
      };
      if (!test || !ttsSupported) {
        stop("This recording could not be played. Check your connection and this browser's sound permission, then try again.");
        return;
      }
      const freshVoices = rankedEnglishVoices();
      if (freshVoices.length > 0) voicesRef.current = freshVoices;
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();
      } catch {
        stop("Your browser could not prepare this recording. Check its sound permission, then try again.");
        return;
      }
      playingRef.current = true;
      playScript(test, from, {
        voices: voicesRef.current,
        rate: () => 1,
        stillPlaying: () => playingRef.current && playbackRunRef.current === run,
        onTurn: () => {},
        onStart: () => {
          /*
            A browser can reject a queued utterance without any audible sound.
            Only make this one-shot exam recording unavailable after its first
            sentence genuinely starts; a pre-start failure remains retryable.
          */
          markHeard(run, index);
        },
        onError: (message) => {
          if (playbackRunRef.current !== run) return;
          playingRef.current = false;
          setPlayingPart(null);
          setFailedPart({ index, heard: heardRef.current, message });
        },
        onEnd: () => {
          if (playbackRunRef.current !== run) return;
          playingRef.current = false;
          setPlayingPart(null);
        },
      });
    },
    [markHeard, tests, ttsSupported],
  );

  const play = useCallback(
    (index: number) => {
      const test = tests[index];
      if (!test || !supported || playingRef.current) return;
      const run = ++playbackRunRef.current;
      playerRef.current?.stop();
      playerRef.current = null;
      heardRef.current = false;
      setPlayingPart(index);
      setFailedPart(null);
      playingRef.current = true;
      // Browser speech may still be mid-utterance from a previous part. The
      // MP3 path does not go through the synthesiser, so silencing it here is
      // the only thing that stops two recordings overlapping.
      try {
        if (ttsSupported) window.speechSynthesis.cancel();
      } catch {
        // A synthesiser that will not cancel is not a reason to withhold the
        // MP3s, which are what this sitting is about to play.
      }

      /*
        Null means this paper has no server recordings at all, and the fallback
        has to happen right here rather than after an await: browsers grant
        audio to a user gesture, and speech started outside the click that
        asked for it is silently refused.
      */
      playerRef.current = playBundledListening(
        test.id,
        [nativeAudioRef.current, nativeAudioBufferRef.current],
        {
          onAudible: () => markHeard(run, index),
          onEnd: () => {
            if (playbackRunRef.current !== run) return;
            playerRef.current = null;
            playingRef.current = false;
            setPlayingPart(null);
          },
          onFail: ({ heard, turnIndex }) => {
            if (playbackRunRef.current !== run) return;
            playerRef.current = null;
            speakScript(run, index, heard ? turnIndex : 0);
          },
        },
      );
      if (!playerRef.current) speakScript(run, index, 0);
    },
    [markHeard, speakScript, supported, tests, ttsSupported],
  );

  const finish = useCallback(() => {
    playbackRunRef.current += 1;
    playingRef.current = false;
    playerRef.current?.stop();
    playerRef.current = null;
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
      topRight={
        playingPart !== null ? (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-fg)]">
            ▶ Part {playingPart + 1}
          </span>
        ) : null
      }
    >
      {/*
        Two elements, not one. While one plays a dialogue turn the other holds
        the next turn already loaded, so the handover at a turn boundary never
        has to tear a decoder down and build another — which is heard as a gap
        of unpredictable length in the middle of a conversation, and in a
        sitting it is heard exactly once. lib/exam/listening-player.ts owns
        both, attaches its own listeners and swaps between them.
      */}
      <audio ref={nativeAudioRef} data-mock-listening-audio preload="none" aria-hidden="true" />
      <audio ref={nativeAudioBufferRef} data-mock-listening-audio-buffer preload="none" aria-hidden="true" />
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
              This browser cannot play the recordings, so the listening paper cannot be sat
              here. Chrome, Edge and Safari can. The rest of the sitting works.
            </p>
          ) : failedPart ? (
            <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
              <p className="text-sm leading-6">
                {failedPart.message}{" "}
                {failedPart.heard
                  ? "This part has been recorded as played, so continue when you are ready."
                  : "No audio was heard, so you can retry this part."}
              </p>
              {(!failedPart.heard || nextUnplayed !== failedPart.index) && nextUnplayed !== -1 && (
                <button type="button" className="btn-primary" onClick={() => play(nextUnplayed)}>
                  {failedPart.heard ? `Play part ${nextUnplayed + 1}` : `Retry part ${nextUnplayed + 1}`}
                </button>
              )}
            </div>
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
