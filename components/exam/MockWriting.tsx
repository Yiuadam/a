"use client";

import { useState } from "react";
import PlanDrawing from "@/components/PlanFigure";
import Chart from "@/components/Chart";
import ExamShell from "@/components/exam/ExamShell";
import { useIsWide } from "@/components/exam/SplitPanes";
import SwipePanels, { type SwipePanel } from "@/components/exam/SwipePanels";
import { MODULE_MINUTES, writingTask, type MockPaper } from "@/lib/exam/mock";

/*
  The writing paper of a mock sitting: two tasks, sixty minutes between them.

  The exam recommends twenty minutes on Task 1 and forty on Task 2, and does
  not enforce it — Task 2 is worth twice as much, so a candidate who spends the
  hour polishing a chart description has made an expensive mistake that nobody
  stopped them making. Both tasks are reachable throughout and the split is
  printed as advice, which is exactly what the real paper does.

  Nothing is marked here. The essays are stored in the session and graded at
  the end of the sitting with everything else, because a band arriving between
  Writing and Speaking would tell a candidate how they are doing in the middle
  of an exam — which is the one thing an exam never does.

  Below `lg` the paper becomes the same horizontal panes the reading papers use,
  and for the same reason: stacked, the prompt is a screen and a half above the
  caret by the second paragraph, and a candidate re-reads the task far more
  often than they scroll to it. The switcher puts it one tap away and leaves the
  answer mounted while they look. Above `lg` there is room for both at once, so
  nothing there has changed — one scrolling column, prompt then answer.
*/

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export default function MockWriting({
  paper,
  essays,
  onWrite,
  deadline,
  onFinish,
}: {
  paper: MockPaper;
  essays: Record<string, string>;
  onWrite: (taskId: string, text: string) => void;
  deadline: number | null;
  onFinish: () => void;
}) {
  const tasks = paper.writing.map((id) => writingTask(id)).filter((t) => t !== undefined);
  const [active, setActive] = useState(0);
  const wide = useIsWide();
  const task = tasks[active];
  if (!task) return null;

  const essay = essays[task.id] ?? "";
  const count = words(essay);

  const brief = <p className="whitespace-pre-line leading-7">{task.prompt}</p>;

  const figure = task.chart ? (
    <Chart spec={task.chart} />
  ) : task.plans ? (
    /*
      Two plans of the same site, drawn side by side on a wide screen and
      stacked on a narrow one. Side by side is how the paper prints them and
      how the comparison is actually made — a candidate describing what changed
      is looking from one to the other — but on a phone two plans in a row are
      two illegible plans, so below the breakpoint they stack.
    */
    <div className="grid gap-4 sm:grid-cols-2">
      {task.plans.map((plan) => (
        <div key={plan.caption} className="min-w-0">
          <p className="mb-1 text-center text-sm font-semibold text-slate-700">{plan.caption}</p>
          <PlanDrawing figure={plan.figure} />
        </div>
      ))}
    </div>
  ) : task.dataTable ? (
    /*
      `overscroll-x-contain` because this sideways scroller now lives inside
      another one. A five-column exam table is wider than a phone and always
      has been, so it has always been dragged sideways to read; what is new is
      that the pane behind it moves the same way, and without this the drag that
      reaches the last column carries straight on into the answer pane. Contained,
      the table stops at its own edge and the pane is switched deliberately.
    */
    <div className="overflow-x-auto overscroll-x-contain">
      <p className="mb-2 font-semibold">{task.dataTable.title}</p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {task.dataTable.headers.map((h) => (
              <th
                key={h}
                className="border border-[color:var(--exam-line)] px-3 py-2 text-left font-semibold"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {task.dataTable.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="border border-[color:var(--exam-line)] px-3 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;

  const advice = (
    <p className="text-[color:var(--exam-muted)]">
      Write at least {task.minWords} words. You are advised to spend about {task.timeMinutes}{" "}
      minutes on this task.
    </p>
  );

  /*
    One definition, laid out by whichever arrangement is on screen. The essay is
    a controlled value held in the sitting's stored session, so it does not care
    which of the two renders it — but it must only be rendered once, or two
    textareas would answer to `mock-essay` and the label would point at whichever
    the browser found first.

    The essay used to be restricted to vertical panning, so that a thumb resting
    on the text and drifting a few degrees off vertical could not snap the pane
    away mid-sentence. The owner asked for the opposite: a swipe should work from
    anywhere, the editor included, because having to find a gap in the page
    before you can go back and re-read the task is worse than the occasional
    stray pane.

    So the restriction is gone and the panes move from a touch that starts inside
    the textarea like any other. What that costs is the thing to watch: a
    horizontal drag on the essay is now a pane change rather than nothing, and on
    iOS the same gesture is close to the one that drags a selection handle. The
    caret, the selection and the essay's own vertical scrolling are untouched.
  */
  const answer = (
    <div className={wide ? undefined : "flex h-full min-h-[16rem] flex-col"}>
      <div className="mb-2 flex items-center justify-between">
        <label htmlFor="mock-essay" className="font-medium">
          Your response
        </label>
        <span
          className={count >= task.minWords ? "text-emerald-600" : "text-[color:var(--exam-muted)]"}
        >
          {count} / {task.minWords} words
        </span>
      </div>
      <textarea
        id="mock-essay"
        /*
          No spell-check, because the exam has none.

          A browser turns it on by default, so a candidate practising here saw
          red underlines under every misspelling and a real candidate sees
          nothing — which is the difference between finding your own errors and
          being shown them. Lexical accuracy is a quarter of the writing band;
          practising with a proofreader is practising a different exam.

          Autocorrect and autocapitalise go with it for the same reason, and
          they matter more on a phone, where iOS would otherwise be quietly
          fixing the candidate's grammar as they typed.
        */
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={`input w-full font-sans leading-7 ${
          wide ? "h-72 resize-y" : "min-h-48 flex-1 resize-none"
        }`}
        placeholder="Start typing your response…"
        value={essay}
        onChange={(e) => onWrite(task.id, e.target.value)}
      />
    </div>
  );

  const panels: SwipePanel[] = [
    { label: "Task", content: <div className="space-y-3">{brief}{advice}</div> },
    ...(figure ? [{ label: "Source", content: figure }] : []),
    { label: "Response", content: answer },
  ];

  return (
    <ExamShell
      section="Writing"
      paper={`Task ${task.task} of 2`}
      minutes={MODULE_MINUTES.writing}
      running
      endsAt={deadline}
      onExpire={onFinish}
      /*
        The same trade the two reading papers already made, and this paper now
        has the same reason for it: below `lg` its task and its answer sit in a
        swipe panel, so a phone is paying for a frame, a paper inset and a panel
        inset before a single word of the prompt is laid out. The header pill
        above and the word-count bar below draw their own edges, which is all
        the outline this screen needs at 390px. The frame returns from `sm` up.
      */
      edgeToEdgeOnPhone
      topRight={
        <div className="flex items-center gap-1">
          {tasks.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(i)}
              aria-current={i === active}
              className={`rounded px-2 py-0.5 text-[0.6875rem] font-semibold ${
                i === active
                  ? "border-[1.5px] border-[color:var(--exam-accent)]"
                  : "border border-[color:var(--exam-line)] hover:bg-[color:var(--exam-hover)]"
              }`}
            >
              Task {t.task}
            </button>
          ))}
        </div>
      }
      bottomLeft={
        <span>
          {/*
            Both counts, always, because the candidate is managing two answers
            against one clock and needs to know the state of the one they are
            not looking at.
          */}
          {tasks
            .map((t) => `Task ${t.task}: ${words(essays[t.id] ?? "")} words`)
            .join("  ·  ")}
        </span>
      }
      bottomRight={
        <button type="button" className="btn-primary" onClick={onFinish}>
          Finish writing
        </button>
      }
    >
      {wide ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mb-3 rounded-lg border border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 py-2">
            {brief}
            {figure && <div className="mt-3">{figure}</div>}
            <div className="mt-2">{advice}</div>
          </div>
          {answer}
        </div>
      ) : (
        /*
          Keyed on the task, so switching from Task 1 to Task 2 lands on the new
          prompt rather than on an empty answer box. Everything that would be
          lost by remounting is held elsewhere — the essays are in the stored
          session, the clock is an absolute deadline — so the only state that
          resets is which pane was showing, which is the state that should.
        */
        <SwipePanels key={task.id} panels={panels} />
      )}
    </ExamShell>
  );
}
