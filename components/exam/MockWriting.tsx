"use client";

import { useState } from "react";
import Chart from "@/components/Chart";
import ExamShell from "@/components/exam/ExamShell";
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
  const task = tasks[active];
  if (!task) return null;

  const essay = essays[task.id] ?? "";
  const count = words(essay);

  return (
    <ExamShell
      section="Writing"
      paper={`Task ${task.task} of 2`}
      minutes={MODULE_MINUTES.writing}
      running
      endsAt={deadline}
      onExpire={onFinish}
      topRight={
        <div className="flex items-center gap-1">
          {tasks.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(i)}
              aria-current={i === active}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-3 rounded-lg border border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] px-3 py-2">
          <p className="whitespace-pre-line leading-7">{task.prompt}</p>
          {task.chart && <Chart spec={task.chart} className="mt-3" />}
          {task.dataTable && (
            <div className="mt-3 overflow-x-auto">
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
          )}
          <p className="mt-2 text-[color:var(--exam-muted)]">
            Write at least {task.minWords} words. You are advised to spend about{" "}
            {task.timeMinutes} minutes on this task.
          </p>
        </div>

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
          className="input h-72 w-full resize-y font-sans leading-7"
          placeholder="Start typing your response…"
          value={essay}
          onChange={(e) => onWrite(task.id, e.target.value)}
        />
      </div>
    </ExamShell>
  );
}
