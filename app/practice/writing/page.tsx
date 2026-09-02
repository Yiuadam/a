"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import BandBadge from "@/components/BandBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import ExplainText from "@/components/ExplainText";
import ExamShell from "@/components/exam/ExamShell";
import SplitPanes, { useIsWide } from "@/components/exam/SplitPanes";
import SwipePanels, { type SwipePanel } from "@/components/exam/SwipePanels";
import writingData from "@/data/writing-tasks.json";
import { postJSON } from "@/lib/api";
import { addResult } from "@/lib/store";
import type { WritingGrade, WritingTasksData } from "@/lib/types";
import {
  AUTOSAVE_DELAY_MS,
  discardWritingDraft,
  discardWritingDrafts,
  loadWritingDraft,
  saveWritingDraft,
} from "@/lib/writing-draft";
import Chart from "@/components/Chart";
import SkillGate from "@/components/SkillGate";
import { tierShows, useTier } from "@/lib/billing/useTier";
import AssignedPracticeNotice from "@/components/organization/AssignedPracticeNotice";
import TestChooser from "@/components/TestChooser";
import { useMounted } from "@/lib/hooks";

const tasks = (writingData as WritingTasksData).tasks;
const compactTableHeadings: Record<string, string> = {
  Agriculture: "Agric.",
  Households: "Homes",
};

function TableHeading({ heading }: { heading: string }) {
  return (
    <>
      <span className="sm:hidden">{compactTableHeadings[heading] ?? heading}</span>
      <span className="hidden sm:inline">{heading}</span>
    </>
  );
}

/*
  A writing task is a workspace on a phone, not a document.

  This file argued the opposite until now, and the reversal is worth writing
  down rather than deleting. The old flow stacked the task, the figure and the
  answer down one scrolling column, because the shared SwipePanels left a
  generous margin of the next panel showing and that margin was being taken out
  of a paragraph's line length and a five-column table's last three columns at
  the same time. The width work has since cut that cue to a sliver on a phone,
  so the reason for the stack has gone with it.

  What the stack never answered is the thing a candidate actually does: compose
  a sentence, re-read the task, compose the next one. Stacked, the task is
  wherever the scroll happens to have left it, which on a 390px screen is
  usually a screen and a half above the caret. Reading solved the same tension
  with a switcher, so writing now uses it too — Task, Source and Response as
  horizontal panes, one tap or one swipe apart, every one of them mounted the
  whole time so the caret, the scroll and the draft survive the trip. The
  desktop keeps its independent split panes, where nothing was ever in the way.
*/
function WritingSession({ initialTaskId }: { initialTaskId: string }) {
  /*
    Whether marking is included, which is not the same as whether the page is
    open. Standard unlocks writing practice — the task, the timer, the word
    count — and does not include the AI examiner; Plus is where marking starts.

    That distinction has to be visible *before* somebody writes, not after. The
    failure it prevents is the worst one this page has: forty minutes of work,
    then a paywall. So the standfirst changes and the submit button is replaced,
    rather than the button being left in place to fail on the click.

    Generous while the answer is unknown, like every other client-side gate
    here: during `loading`, and with accounts switched off, marking is offered.
    The server refuses if it should — lib/billing/gate.ts — and a paywall that
    flashes on a subscriber's screen is worse than one that arrives a beat late.
  */
  const account = useTier();
  const marked =
    account.phase !== "ready" || !account.accountsEnabled || tierShows(account, "grade-writing");
  const wide = useIsWide();

  /*
    Whatever was in the box when this task was last open, read straight into the
    first render rather than pushed in by an effect afterwards.

    WritingPageContent draws nothing until it has mounted, so this initialiser
    only ever runs in the browser and there is no server render for it to
    disagree with. Restoring in an effect instead would paint one frame of an
    empty textarea over an essay somebody is about to be very relieved to see,
    which is a poor way to tell them their work survived. It is keyed by task —
    the component is keyed on the id too — so Task 1 and Task 2 restore their
    own drafts and never each other's.
  */
  const [essay, setEssay] = useState(() => loadWritingDraft(initialTaskId));
  const [started, setStarted] = useState(false);
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<WritingGrade | null>(null);
  const [error, setError] = useState<string | null>(null);

  const task = useMemo(() => tasks.find((t) => t.id === initialTaskId)!, [initialTaskId]);
  const wordCount = essay.trim() ? essay.trim().split(/\s+/).length : 0;

  /*
    The autosave, half a second behind the typing.

    Debounced rather than written on every keystroke because a storage write per
    letter is work nobody asked for, and the pause between words is soon enough:
    all a lock or a reclaimed tab can take from here is the tail of whatever was
    being typed at the moment it happened. lib/writing-draft.ts explains what the
    draft is for and the terms it is kept on.

    `grade` is in the dependencies to cancel a write, not to cause one. Submit
    clears the draft as soon as the marking comes back, and without this the
    keystroke from a second earlier would still have a timer pending and would
    write the essay straight back over the top of that.
  */
  useEffect(() => {
    if (grade) return;
    const timer = setTimeout(() => saveWritingDraft(task.id, essay), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [task.id, essay, grade]);

  /*
    Leaving the writing paper throws the drafts away.

    The owner's rule, and the reason the autosave is allowed to be as quiet as it
    is: it guards against an accident, so anything deliberate should end it. Both
    tasks go, not just the one on screen — somebody who has gone back to the
    homepage has finished with the paper, not with one half of it.

    What must not reach here is every other way this component can disappear,
    and the difference is the address bar. A reload never runs a cleanup at all:
    the browser discards the whole JavaScript context without asking React to
    unmount anything, which is exactly why a refresh, a locked phone and a
    reclaimed background tab all restore instead — the case this feature exists
    for. A task switch and the chooser do unmount it, but they stay on
    /practice/writing, so the check leaves their drafts alone. And StrictMode in
    development mounts, unmounts and remounts everything to prove effects can
    survive it; the pathname is unchanged through that too, which is the only
    thing stopping a dev build from deleting the draft it has just restored.
  */
  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;
      if (window.location.pathname.startsWith("/practice/writing")) return;
      discardWritingDrafts();
    };
  }, []);

  async function submit() {
    setGrading(true);
    setError(null);
    setGrade(null);
    try {
      /* postJSON carries the session token and the iOS API base — see lib/api.ts. */
      const data = await postJSON<WritingGrade>("/api/grade/writing", {
        task: task.task,
        prompt: task.prompt,
        essay,
        minWords: task.minWords,
      });
      setGrade(data);
      /*
        Marked and recorded, so the guard has nothing left to guard. The essay
        is in the history entry below and on screen in the feedback; a draft
        kept past this point would only be waiting to reappear under a task the
        learner has already finished. A failed submit deliberately does not
        reach here — that is the moment the draft is worth most, because the
        learner is still holding forty minutes of work and may well reload.
      */
      discardWritingDraft(task.id);
      addResult({
        module: "writing",
        testId: task.id,
        testTitle: task.title,
        band: data.overallBand,
        date: new Date().toISOString(),
        review: {
          kind: "writing",
          attempts: [{ task, response: essay, grade: data }],
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grading failed.");
    } finally {
      setGrading(false);
    }
  }

  const resetTask = () => {
    setEssay("");
    setGrade(null);
    setError(null);
    setStarted(false);
  };

  const prompt = (
    <div className="min-w-0 space-y-3">
      <div className="min-w-0">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Task {task.task}</h2>
        <p className="whitespace-pre-line break-words text-[15px] leading-7 text-slate-800">{task.prompt}</p>
        <p className="mt-3 text-xs text-slate-500">
          At least {task.minWords} words · {task.timeMinutes} minutes
        </p>
      </div>
    </div>
  );

  const visual = task.chart ? (
    <Chart spec={task.chart} />
  ) : task.dataTable ? (
    <div className="min-w-0 max-w-full sm:overflow-x-auto">
      <p className="mb-2 text-sm font-semibold text-slate-700">{task.dataTable.title}</p>
      <table
        className="w-full table-fixed border-collapse leading-normal sm:table-auto"
        /* Five headings still fit at 320px without turning into broken word
           fragments. Twelve pixels is the floor; the type grows smoothly to
           the normal 14px table size by 400px and stays there on desktop. */
        style={{ fontSize: "clamp(0.75rem, 3.5vw, 0.875rem)" }}
      >
        <thead>
          <tr>
            {task.dataTable.headers.map((heading) => (
              <th
                key={heading}
                aria-label={heading}
                className="break-words border border-slate-300 bg-slate-100 px-0.5 py-2 text-left font-semibold leading-tight text-slate-700 sm:px-3"
              >
                <TableHeading heading={heading} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {task.dataTable.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="break-words border border-slate-300 px-0.5 py-2 text-slate-700 sm:px-3">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;

  const response = (
    <div className="flex h-full min-h-[20rem] flex-col lg:min-h-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor="writing-response" className="text-sm font-semibold text-slate-900">
          Your response
        </label>
        <span className={wordCount >= task.minWords ? "text-xs text-emerald-600" : "text-xs text-slate-500"}>
          {wordCount} / {task.minWords}
        </span>
      </div>
      {/*
        The swipe track reaches into the editor, which it did not used to.

        This element was restricted to vertical panning, so that a thumb resting
        on the essay and drifting a few degrees off vertical could not snap the
        pane away mid-sentence. The owner asked for the opposite, and the reason
        is the one the panes were introduced for: a candidate re-reads the task
        constantly while composing, and having to find a gap in the page before
        the swipe will take you there is worse than the occasional stray pane.

        So the restriction is gone and the panes move from a touch that starts
        inside the textarea like any other. The cost is worth naming rather than
        discovering: a horizontal drag on the essay is now a pane change rather
        than nothing, and on iOS that is close to the gesture that drags a
        selection handle. Everything else the editor needs is untouched — a tap
        places the caret, a long press still selects and raises the magnifier,
        and a long essay still scrolls vertically under the finger.
      */}
      <textarea
        id="writing-response"
        className="input min-h-64 flex-1 resize-none font-sans leading-7"
        placeholder="Start typing…"
        value={essay}
        onFocus={() => setStarted(true)}
        onChange={(e) => setEssay(e.target.value)}
        disabled={grading}
      />
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      {!marked && (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Saved on this device. AI marking requires Plus. {account.signedIn ? "" : "Sign in first, then upgrade if needed."}
        </p>
      )}
    </div>
  );

  const source = (
    <div className="space-y-5">
      <AssignedPracticeNotice />
      {prompt}
      {visual && <div className="border-t border-slate-200 pt-4">{visual}</div>}
    </div>
  );

  const practicePanels: SwipePanel[] = [
    { label: "Task", content: prompt },
    ...(visual ? [{ label: "Source", content: visual }] : []),
    { label: "Response", content: response },
  ];

  const feedbackPanels: SwipePanel[] = grade
    ? [
        {
          label: "Band",
          content: (
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <BandBadge band={grade.overallBand} caption="Estimated writing band" />
              <div className="grid flex-1 gap-2 sm:grid-cols-2">
                {grade.criteria.map((criterion) => (
                  <div key={criterion.name} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-800">{criterion.name}</span>
                      <span className="text-xs font-semibold text-indigo-700">{criterion.band}</span>
                    </div>
                    <ExplainText text={criterion.comment} className="mt-1 block text-xs leading-5 text-slate-600" />
                  </div>
                ))}
              </div>
            </div>
          ),
        },
        {
          label: "Worked",
          content: (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-emerald-700">What worked</h3>
              <ul className="list-disc space-y-2 pl-5 text-sm text-slate-700">
                {grade.strengths.map((item, index) => <li key={index}><ExplainText text={item} /></li>)}
              </ul>
            </div>
          ),
        },
        {
          label: "Next",
          content: (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-amber-700">Next priorities</h3>
              <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
                {grade.improvements.map((item, index) => <li key={index}><ExplainText text={item} /></li>)}
              </ol>
            </div>
          ),
        },
        {
          label: "Rewrite",
          content: (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">One band higher</h3>
              <ExplainText text={grade.rewrittenExcerpt} className="block whitespace-pre-line text-[15px] leading-7 text-slate-700" />
            </div>
          ),
        },
      ]
    : [];

  return (
    <ExamShell
      section="Writing"
      paper={task.title}
      minutes={task.timeMinutes}
      running={started && !grade}
      comfortableGutter
      edgeToEdgeOnPhone
      bottomLeft={grade ? `Band ${grade.overallBand}` : `${wordCount} / ${task.minWords} words`}
      bottomRight={
        grade ? (
          <div className="flex gap-2">
            <Link href="/practice" className="btn-secondary !min-h-8 !px-3 !py-1 text-xs">More practice</Link>
            <button className="btn-primary !min-h-8 !px-3 !py-1 text-xs" onClick={() => resetTask()}>
              Try again
            </button>
          </div>
        ) : marked ? (
          <button
            className="btn-primary !min-h-8 !px-3 !py-1 text-xs"
            onClick={submit}
            disabled={grading || wordCount < 40}
          >
            {grading ? <LoadingIndicator label="Marking…" announce={false} /> : "Submit for marking"}
          </button>
        ) : (
          <span className="text-[11px] text-slate-500">Saved on device</span>
        )
      }
    >
      {grade ? (
        <SwipePanels panels={feedbackPanels} />
      ) : wide ? (
        <SplitPanes className="h-full" initial={48} left={source} right={response} />
      ) : (
        /*
          The assignment banner stays above the track rather than riding in the
          Task panel. It is about why this paper is open at all, which does not
          stop being true when the candidate swipes to their answer, and a
          notice that vanishes with the panel it was pinned to is a notice
          somebody will swear they never saw.
        */
        <div className="flex min-h-0 flex-1 flex-col">
          <AssignedPracticeNotice className="mx-1 mb-2 shrink-0" />
          <SwipePanels panels={practicePanels} />
        </div>
      )}
    </ExamShell>
  );
}

/*
  Writing is model-marked, so a visitor with no model gets a lock rather than a
  blank box and forty minutes. See lib/entitlements/sessions.ts.
*/
export default function WritingPage() {
  /*
    The waiting screen fills the same space the paper will, and it reads
    var(--header-h) to know how much that is rather than subtracting a literal
    3.75rem. The literal is the header only in a window with no safe-area
    inset; on a notched phone the header is that much taller again, and this
    route locks the body to the viewport, so a box sized past the space
    available is a box with a hidden bottom rather than one you can scroll.
    See the note at frameSize in components/exam/ExamShell.tsx. The reading and
    listening papers already read the token here; writing was the one left
    behind.
  */
  return (
    <Suspense
      fallback={(
        <div className="mx-auto flex min-h-[calc(100dvh-var(--header-h))] max-w-xl items-center justify-center px-4">
          <LoadingIndicator label="Loading writing tasks…" />
        </div>
      )}
    >
      <WritingPageContent />
    </Suspense>
  );
}

function WritingPageContent() {
  const params = useSearchParams();
  const mounted = useMounted();

  if (!mounted) return null;

  const asked = params.get("id");
  const selected = tasks.find((task) => task.id === asked) ?? null;

  if (!selected) {
    const retained = new URLSearchParams();
    for (const key of ["assignment", "from", "preview"] as const) {
      const value = params.get(key);
      if (value !== null) retained.set(key, value);
    }

    return (
      <TestChooser
        kind="writing"
        tests={tasks}
        missingId={asked}
        retainedQuery={retained.toString()}
      />
    );
  }

  return (
    /* The page-level lock paints its own translucent window around the exam.
       Give that outermost window the same viewport gutter as the exam shell,
       otherwise the locked preview touches the browser edge even though the
       writing panes inside it do not. The class only applies while the gate is
       pending or locked; an unlocked session keeps ExamShell's own gutter. */
    <SkillGate module="writing" className="px-0 pt-0 sm:px-4 sm:pt-4">
      <WritingSession key={selected.id} initialTaskId={selected.id} />
    </SkillGate>
  );
}
