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
  A writing task is a document on a phone, not a carousel.

  The shared SwipePanels deliberately leaves the neighbouring panel peeking in
  so reading and listening candidates know that they can swipe. Here that cue
  took width away from the prompt, the figure and the answer at the same time:
  a paragraph became a column of six-word lines and a five-column table could
  only show its first two columns. Writing therefore has one narrow-screen
  flow. The sections use the full paper width and the paper scrolls vertically;
  the desktop keeps its independent split panes.
*/
function WritingMobilePanels({ panels, lead }: { panels: SwipePanel[]; lead?: React.ReactNode }) {
  return (
    <div
      data-writing-mobile-panels=""
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pb-5"
    >
      {lead}
      <div className="min-w-0 divide-y divide-[color:var(--exam-line)]">
        {panels.map((panel) => (
          <section
            key={panel.label}
            aria-label={panel.label}
            data-writing-mobile-panel={panel.label.toLowerCase()}
            className="w-full min-w-0 py-4 first:pt-1 last:pb-2"
          >
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--exam-muted)]">
              {panel.label}
            </p>
            <div className="min-w-0 max-w-full">{panel.content}</div>
          </section>
        ))}
      </div>
    </div>
  );
}

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

  const [essay, setEssay] = useState("");
  const [started, setStarted] = useState(false);
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<WritingGrade | null>(null);

  useEffect(() => {
    if (grade) window.scrollTo({ top: 0 });
  }, [grade]);
  const [error, setError] = useState<string | null>(null);

  const task = useMemo(() => tasks.find((t) => t.id === initialTaskId)!, [initialTaskId]);
  const wordCount = essay.trim() ? essay.trim().split(/\s+/).length : 0;

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
    <div className="flex min-h-[20rem] flex-col lg:h-full lg:min-h-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor="writing-response" className="text-sm font-semibold text-slate-900">
          Your response
        </label>
        <span className={wordCount >= task.minWords ? "text-xs text-emerald-600" : "text-xs text-slate-500"}>
          {wordCount} / {task.minWords}
        </span>
      </div>
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
        wide ? (
          <SwipePanels panels={feedbackPanels} />
        ) : (
          /*
            key forces a fresh instance rather than an update to the practice
            view's — same component, same position in the tree, so without it
            React would carry over the scrollTop from wherever the essay was
            last scrolled while writing, landing the feedback view mid-page
            instead of at the band that heads it.
          */
          <WritingMobilePanels key="graded" panels={feedbackPanels} />
        )
      ) : wide ? (
        <SplitPanes className="h-full" initial={48} left={source} right={response} />
      ) : (
        <WritingMobilePanels
          key="practice"
          panels={practicePanels}
          lead={<AssignedPracticeNotice className="mx-1 mb-2" />}
        />
      )}
    </ExamShell>
  );
}

/*
  Writing is model-marked, so a visitor with no model gets a lock rather than a
  blank box and forty minutes. See lib/entitlements/sessions.ts.
*/
export default function WritingPage() {
  return (
    <Suspense
      fallback={(
        <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-xl items-center justify-center px-4">
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
