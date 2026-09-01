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

  The exam display scheme is separate from BandUp's site theme. The shell sets
  custom properties and everything inside reads them, so standard follows the
  site while the optional reverse mode stays consistently white on black.

  BandUp's accent marks the question being read — the strip follows the paper
  as it is scrolled. A separate calm blue marks hard questions, so learners can
  scan the bottom strip and return to them quickly.
*/

const SCHEME_VARS: Record<string, Record<string, string>> = {
  standard: {
    "--exam-bg": "var(--color-background)",
    "--exam-fg": "var(--color-foreground)",
    "--exam-muted": "var(--color-slate-500)",
    "--exam-line": "var(--color-slate-300)",
    "--exam-chrome": "var(--color-slate-100)",
    "--exam-hover": "var(--color-slate-200)",
    "--exam-accent": "var(--color-indigo-600)",
    "--exam-hard": "#2563eb",
    "--exam-mark": "var(--color-amber-200)",
  },
  reverse: {
    "--exam-bg": "#000000",
    "--exam-fg": "#ffffff",
    "--exam-muted": "#a8a8a8",
    "--exam-line": "#4a4a4a",
    "--exam-chrome": "#161616",
    "--exam-hover": "#2a2a2a",
    "--exam-accent": "#e08a55",
    "--exam-hard": "#2563eb",
    "--exam-mark": "#4a4000",
  },
};

export default function ExamShell({
  section,
  paper,
  minutes,
  running,
  onExpire,
  endsAt,
  palette,
  currentId,
  onJump,
  onPrev,
  onNext,
  onToggleReview,
  topRight,
  bottomLeft,
  bottomRight,
  comfortableGutter = false,
  edgeToEdgeOnPhone = false,
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
   * An absolute deadline for a clock that must survive a reload — passed
   * straight through to ExamTimer. A practice session omits it; a mock sitting
   * stores one per module and hands it back on resume.
   */
  endsAt?: number | null;
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
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  /** Anything the section adds beside Settings — Listening puts volume here. */
  topRight?: ReactNode;
  /**
   * Give a page a calmer outer margin without changing the shared exam chrome.
   * Writing opts in because its larger text-entry surfaces otherwise read as
   * touching the browser edge; timed Reading and Listening keep the tighter
   * computer-exam frame.
   */
  comfortableGutter?: boolean;
  /**
   * Let a content-heavy paper use the phone's width without changing its
   * desktop frame. Writing uses this because a frame, a paper inset and a
   * panel inset together leave too little room for a task, figure and answer.
   * From `sm` upwards the ordinary (or comfortable) frame is restored.
   */
  edgeToEdgeOnPhone?: boolean;
  children: ReactNode;
}) {
  const display = useExamDisplay();
  const vars = SCHEME_VARS[display.scheme] ?? SCHEME_VARS.standard;
  const frameSize = edgeToEdgeOnPhone
    ? comfortableGutter
      ? "m-0 h-[calc(100dvh-4rem)] w-full sm:m-4 sm:h-[calc(100dvh-5.75rem)] sm:w-[calc(100%-2rem)]"
      : "m-0 h-[calc(100dvh-4rem)] w-full sm:m-2 sm:h-[calc(100dvh-4.75rem)] sm:w-[calc(100%-1rem)]"
    : comfortableGutter
      ? "m-3 h-[calc(100dvh-5.25rem)] w-[calc(100%-1.5rem)] sm:m-4 sm:h-[calc(100dvh-5.75rem)] sm:w-[calc(100%-2rem)]"
      : "m-1 h-[calc(100dvh-4.25rem)] w-[calc(100%-0.5rem)] sm:m-2 sm:h-[calc(100dvh-4.75rem)] sm:w-[calc(100%-1rem)]";
  const frameSurface = edgeToEdgeOnPhone
    ? "rounded-none border-0 shadow-none sm:rounded-2xl sm:border sm:border-[color:var(--exam-line)] sm:shadow-[0_18px_50px_-32px_rgba(42,37,33,0.55)]"
    : "rounded-xl border border-[color:var(--exam-line)] shadow-[0_18px_50px_-32px_rgba(42,37,33,0.55)] sm:rounded-2xl";
  const paperInset = edgeToEdgeOnPhone ? "px-2 py-2 sm:px-4" : "px-3 py-2 sm:px-4";

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
      className={`${frameSize} ${frameSurface} flex min-h-[26rem] flex-col overflow-hidden bg-[color:var(--exam-bg)] text-[color:var(--exam-fg)]`}
    >
      <header className="exam-shell-header exam-glass z-50 m-2 mb-0 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl border border-b-2 border-b-[color:var(--exam-accent)] px-3 py-1.5 sm:rounded-2xl">
        {/*
          Where the exam prints the candidate's name and number. There is no
          candidate here, so it says which paper you are on — the same corner,
          doing the same job of telling you where you are.
        */}
        <div className="exam-section-block min-w-0 self-stretch text-[11px] leading-tight">
          <div className="whitespace-nowrap font-semibold uppercase tracking-wide text-[color:var(--exam-fg)]">
            {section}
          </div>
          <div className="exam-paper-title whitespace-nowrap text-[color:var(--exam-muted)]">
            {paper}
          </div>
        </div>

        <ExamTimer minutes={minutes} running={running} onExpire={onExpire} endsAt={endsAt} />

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
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${paperInset}`}>{children}</div>

      {palette && palette.length > 0 ? (
        <QuestionPalette
          items={palette}
          currentId={currentId ?? null}
          onJump={onJump ?? (() => {})}
          onPrev={onPrev ?? (() => {})}
          onNext={onNext ?? (() => {})}
          onToggleReview={onToggleReview ?? (() => {})}
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
