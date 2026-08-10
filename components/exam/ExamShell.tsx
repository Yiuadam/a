"use client";

import type { ReactNode } from "react";
import ExamSettings, { useExamDisplay } from "./ExamSettings";
import ExamTimer from "./ExamTimer";
import QuestionPalette, { type PaletteItem } from "./QuestionPalette";
import { sizeInPx } from "@/lib/exam/display";

/*
  The frame every practice session sits inside: exam chrome above, exam chrome
  below, the paper in between.

  ---------------------------------------------------------------------------
  Why this is a shell rather than a set of pieces each page assembles

  Because the arrangement *is* the thing being reproduced. Computer-delivered
  IELTS puts the candidate line top-left, the clock top-centre, settings and
  volume top-right, and the forty question numbers along the bottom — and it is
  the same on every screen of every section for three hours. A candidate stops
  seeing it and starts seeing only the paper, which is exactly what you want
  them practising in.

  So the layout is fixed here and the pages pass content in. A page cannot move
  the clock, because in the exam a page cannot move the clock.

  ---------------------------------------------------------------------------
  The colour schemes, and why they are variables rather than classes

  The exam's three schemes are not a light/dark toggle — yellow-on-black is not
  a dark theme, it is a high-contrast accessibility mode with a specific
  yellow. So the shell sets four custom properties and everything inside reads
  them. A component written against --exam-fg is correct in all three without
  knowing any of them exist, and adding a fourth scheme later touches this file
  and nothing else.

  BandUp's own accent survives as --exam-accent, used only for "where you are"
  — the ring on the current question. Everything that is part of the exam
  illusion is monochrome, and the one thing that is the app helping you is not.
  That is the self-redesign: the same furniture, in this app's voice.
*/

const SCHEME_VARS: Record<string, Record<string, string>> = {
  standard: {
    "--exam-bg": "#ffffff",
    "--exam-fg": "#111111",
    "--exam-muted": "#5b5b5b",
    "--exam-line": "#c9c9c9",
    "--exam-chrome": "#f1f1f1",
    "--exam-hover": "#e4e4e4",
    "--exam-accent": "#8a4b2a",
    "--exam-mark": "#ffe680",
  },
  reverse: {
    "--exam-bg": "#000000",
    "--exam-fg": "#ffffff",
    "--exam-muted": "#a8a8a8",
    "--exam-line": "#4a4a4a",
    "--exam-chrome": "#161616",
    "--exam-hover": "#2a2a2a",
    "--exam-accent": "#e08a55",
    "--exam-mark": "#4a4000",
  },
  amber: {
    "--exam-bg": "#000000",
    "--exam-fg": "#ffd400",
    "--exam-muted": "#b39400",
    "--exam-line": "#5a4c00",
    "--exam-chrome": "#141200",
    "--exam-hover": "#2a2400",
    "--exam-accent": "#ffffff",
    "--exam-mark": "#4a3e00",
  },
};

export default function ExamShell({
  section,
  paper,
  minutes,
  running,
  onExpire,
  palette,
  currentId,
  onJump,
  onPrev,
  onNext,
  onToggleReview,
  onNextFlagged,
  topRight,
  bottomLeft,
  bottomRight,
  children,
}: {
  /** "Reading", "Listening" — what the exam calls this part. */
  section: string;
  /** Which paper, shown where the exam shows the candidate line. */
  paper: string;
  minutes: number;
  running: boolean;
  onExpire?: () => void;
  /**
   * The forty numbers, when there are forty numbers.
   *
   * Reading and Listening have them; Writing does not, because a writing paper
   * is two tasks and a word count. Rather than fake a palette for it, the shell
   * takes `bottomLeft` and `bottomRight` instead and keeps the bar — the bar
   * itself is part of the furniture, and a session whose bottom edge suddenly
   * differs is a session that feels like a different application.
   */
  palette?: PaletteItem[];
  currentId?: string | null;
  onJump?: (id: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onToggleReview?: () => void;
  onNextFlagged?: () => void;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  /** Anything the section adds beside Settings — Listening puts volume here. */
  topRight?: ReactNode;
  children: ReactNode;
}) {
  const display = useExamDisplay();
  const vars = SCHEME_VARS[display.scheme] ?? SCHEME_VARS.standard;

  return (
    <div
      /*
        The whole shell is one stacking context with its own colours and its own
        base font size, so nothing inside has to know which scheme is on.
        Everything sizes in em from here, which is what makes one setting move
        the entire paper rather than just its paragraphs.
      */
      /*
        The hook app/globals.css scopes its exam overrides to. Everything inside
        an exam follows the scheme; nothing outside one is touched.
      */
      data-exam=""
      /*
        --exam-base is what app/globals.css sizes everything inside against.
        fontSize is set from the same number so that any text with no utility
        of its own inherits it rather than falling back to the page.
      */
      style={
        {
          ...vars,
          "--exam-base": `${sizeInPx(display.size)}px`,
          fontSize: sizeInPx(display.size),
        } as React.CSSProperties
      }
      /*
        Sized to the window rather than to a fraction of it.

        It was min-h-[80vh] with the panes fixed at 62vh inside, which left a
        band of nothing between the paper and the numbers — the app's chrome
        and the exam's chrome each taking their share and the reading getting
        what was left. Now the shell takes the viewport minus the site header,
        the paper takes everything the two bars do not, and the gap is however
        many pixels the bars actually need.

        dvh rather than vh because mobile browsers count their own collapsing
        toolbar in vh, which puts the question numbers below the fold on a
        phone until you scroll — on the one bar that must never move.

        The 8.5rem is the site header and the page's own padding, measured
        rather than guessed, with enough left over that the question numbers
        are never the thing at the very bottom edge of the window. The document
        is still taller than the window — the site footer is below all of
        this — but the exam does not depend on scrolling to it.
      */
      className="-mx-4 flex h-[calc(100dvh-8.5rem)] min-h-[26rem] flex-col overflow-hidden border-y border-[color:var(--exam-line)] bg-[color:var(--exam-bg)] text-[color:var(--exam-fg)] sm:mx-0 sm:rounded-lg sm:border"
    >
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 py-1.5">
        {/*
          Where the exam prints the candidate's name and number. There is no
          candidate here, so it says which paper you are on — the same corner,
          doing the same job of telling you where you are.
        */}
        <div className="min-w-0 text-[11px] leading-tight">
          <div className="truncate font-semibold uppercase tracking-wide text-[color:var(--exam-fg)]">
            {section}
          </div>
          <div className="truncate text-[color:var(--exam-muted)]">{paper}</div>
        </div>

        <ExamTimer minutes={minutes} running={running} onExpire={onExpire} />

        <div className="flex items-center justify-end gap-2">
          {topRight}
          <ExamSettings />
        </div>
      </header>

      {/*
        The paper. It scrolls, the chrome does not — which is the behaviour that
        makes the clock and the numbers feel bolted to the screen rather than to
        the page.
      */}
      {/*
        The paper. Fills what is left and does not scroll itself — the panes
        inside it do, which is what keeps the passage and the questions
        independent. A page that wants one scrolling column puts its own
        overflow-y-auto in here.
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2">{children}</div>

      {palette && palette.length > 0 ? (
        <QuestionPalette
          items={palette}
          currentId={currentId ?? null}
          onJump={onJump ?? (() => {})}
          onPrev={onPrev ?? (() => {})}
          onNext={onNext ?? (() => {})}
          onToggleReview={onToggleReview ?? (() => {})}
          onNextFlagged={onNextFlagged ?? (() => {})}
        />
      ) : (
        <div className="flex items-center justify-between gap-3 border-t border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 py-2 text-xs text-[color:var(--exam-fg)]">
          <div className="min-w-0">{bottomLeft}</div>
          <div className="shrink-0">{bottomRight}</div>
        </div>
      )}
    </div>
  );
}
