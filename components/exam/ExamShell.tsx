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
   *
   * Reading now uses it too, in both the mock and the practice paper, and the
   * reason is worth recording: it had exactly the problem the prop was written
   * for and simply had not been given it. A reading screen nests further than
   * a writing one — frame, paper inset, swipe panel, question card — and on a
   * 390px phone those four insets left a question's prompt 146px to wrap in,
   * which is about four words a line. The frame is the layer that buys the
   * least, because on a phone the header and the question strip already read
   * as the edge of the exam.
   */
  edgeToEdgeOnPhone?: boolean;
  children: ReactNode;
}) {
  const display = useExamDisplay();
  const vars = SCHEME_VARS[display.scheme] ?? SCHEME_VARS.standard;
  /*
    The frame's height, and the one number in it that is not a constant.

    Every variant here says the same thing: take the window, subtract whatever
    is above the exam, subtract this variant's own margin, and the rest is the
    frame. Only the margin differs between them, so only the margin is written
    as a literal.

    What is above the exam is var(--header-h), and it has to be read rather
    than counted because it is not one number. On a desktop browser it is the
    header's 3.75rem row and nothing else, which is what these four lines used
    to subtract as a literal. On a notched iPhone the header also carries
    env(safe-area-inset-top) — around 59px — because .site-header pads itself
    by the inset so its glass runs behind the status bar. And inside the iOS
    app there is no header element at all: lib/native-chrome.ts publishes the
    native bar's own measured height into this same property.

    Subtracting 3.75rem in the first case and calling it measured was true
    only in the window it was measured in. On a phone the frame came out about
    55px taller than the space it had, and because a practice route locks the
    body to the viewport with overflow hidden (see body[data-viewport-locked]
    in app/globals.css), those 55px were not below the fold — they were gone.
    The question strip is the last thing in the frame, so the question strip
    was what went, and with it the finish button on a writing paper.

    The literal that remains is each variant's margin, doubled because a
    margin is paid at the top and again at the bottom. m-0 subtracts nothing,
    m-1 subtracts 0.5rem, m-3 subtracts 1.5rem, sm:m-2 subtracts 1rem and
    sm:m-4 subtracts 2rem. Every variant therefore occupies exactly the window
    minus the header, which is exactly what the page has to give it.
  */
  const frameSize = edgeToEdgeOnPhone
    ? comfortableGutter
      ? "m-0 h-[calc(100dvh-var(--header-h))] w-full sm:m-4 sm:h-[calc(100dvh-var(--header-h)-2rem)] sm:w-[calc(100%-2rem)]"
      : "m-0 h-[calc(100dvh-var(--header-h))] w-full sm:m-2 sm:h-[calc(100dvh-var(--header-h)-1rem)] sm:w-[calc(100%-1rem)]"
    : comfortableGutter
      ? "m-3 h-[calc(100dvh-var(--header-h)-1.5rem)] w-[calc(100%-1.5rem)] sm:m-4 sm:h-[calc(100dvh-var(--header-h)-2rem)] sm:w-[calc(100%-2rem)]"
      : "m-1 h-[calc(100dvh-var(--header-h)-0.5rem)] w-[calc(100%-0.5rem)] sm:m-2 sm:h-[calc(100dvh-var(--header-h)-1rem)] sm:w-[calc(100%-1rem)]";
  const frameSurface = edgeToEdgeOnPhone
    ? "rounded-none border-0 shadow-none sm:rounded-2xl sm:border sm:border-[color:var(--exam-line)] sm:shadow-[0_18px_50px_-32px_rgba(42,37,33,0.55)]"
    : "rounded-xl border border-[color:var(--exam-line)] shadow-[0_18px_50px_-32px_rgba(42,37,33,0.55)] sm:rounded-2xl";
  /*
    A paper that has given up the frame has given up the reason for the frame's
    breathing room too. The header above and the question strip below are both
    glass pills with their own edge, so what this inset buys on a phone is the
    hairline between them and the paper — not the margin a bordered window
    needs. Halving it returns that height to the paper, which on the reading
    screen is the thing the owner asked to be longer. Restored from `sm` up,
    where the frame is drawn again and the room is not scarce.
  */
  const paperInset = edgeToEdgeOnPhone ? "px-2 py-1 sm:px-4 sm:py-2" : "px-3 py-2 sm:px-4";

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

        What is subtracted from the window is worked out where frameSize is
        built, above, and the note there is worth reading before changing any
        of it: on these routes the exam is not a tall document that happens to
        start at the top of the screen, it is the whole of the screen below the
        header, and nothing below it can be scrolled to.

        Which is also why there is no longer a 26rem floor under the height.
        The floor arrived with the height, when the document could still
        scroll and a frame taller than the window was merely further down the
        page. It cannot be reached that way any more, so on a phone held
        sideways — 390 tall, about 320 of it below the header — the floor made
        the frame 416 and put ninety-five pixels of it, the question strip
        included, off the bottom of a screen that does not scroll. A cramped
        paper is worse than a roomy one; a paper you cannot finish is worse
        than both.
      */
      className={`${frameSize} ${frameSurface} flex min-h-0 flex-col overflow-hidden bg-[color:var(--exam-bg)] text-[color:var(--exam-fg)]`}
    >
      <header className="exam-shell-header exam-glass z-50 m-2 mb-0 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl border border-b-2 border-b-[color:var(--exam-accent)] px-3 py-1.5 sm:rounded-2xl">
        {/*
          Where the exam prints the candidate's name and number. There is no
          candidate here, so it says which paper you are on — the same corner,
          doing the same job of telling you where you are.
        */}
        <div className="exam-section-block min-w-0 self-stretch text-[0.6875rem] leading-tight">
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
      {/*
        `exam-paper` marks the boundary between what is read and what is
        operated. app/globals.css uses it to tighten the paper's leading and
        paragraph gaps on a phone without touching the header or the question
        strip — those are controls, and a control that has been tightened is
        only harder to hit.
      */}
      <div className={`exam-paper flex min-h-0 flex-1 flex-col overflow-hidden ${paperInset}`}>
        {children}
      </div>

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
        /*
          The bottom inset is the page's to pay now. Capacitor used to have
          WKWebView inset the content for the safe area itself, and it was taken
          off because the header already reserved the notch and the app was
          paying for it twice — which fixed the gap at the top and handed this
          edge to CSS at the same time. Without it, "Submit for marking" sits in
          the home indicator's strip and is clipped by the screen's own corner.

          max() rather than a plain addition: on a device with no indicator the
          inset is zero and the bar keeps the 0.5rem it was designed with.
        */
        <div
          className="flex items-center justify-between gap-3 border-t border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 pt-2 text-xs text-[color:var(--exam-fg)]"
          style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          <div className="min-w-0">{bottomLeft}</div>
          <div className="shrink-0">{bottomRight}</div>
        </div>
      )}
    </div>
  );
}
