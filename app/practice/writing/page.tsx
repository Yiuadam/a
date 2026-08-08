"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import BandBadge from "@/components/BandBadge";
import ExplainText from "@/components/ExplainText";
import Timer from "@/components/Timer";
import writingData from "@/data/writing-tasks.json";
import { addResult } from "@/lib/store";
import type { WritingGrade, WritingTasksData } from "@/lib/types";
import Chart from "@/components/Chart";

const tasks = (writingData as WritingTasksData).tasks;

export default function WritingPage() {
  const [taskId, setTaskId] = useState(tasks[0].id);
  const [essay, setEssay] = useState("");
  const [started, setStarted] = useState(false);
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<WritingGrade | null>(null);
  const [error, setError] = useState<string | null>(null);

  const task = useMemo(() => tasks.find((t) => t.id === taskId)!, [taskId]);
  const wordCount = essay.trim() ? essay.trim().split(/\s+/).length : 0;

  async function submit() {
    setGrading(true);
    setError(null);
    setGrade(null);
    try {
      const res = await fetch("/api/grade/writing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: task.task,
          prompt: task.prompt,
          essay,
          minWords: task.minWords,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Grading failed.");
      setGrade(data as WritingGrade);
      addResult({
        module: "writing",
        testId: task.id,
        testTitle: task.title,
        band: (data as WritingGrade).overallBand,
        date: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grading failed.");
    } finally {
      setGrading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold text-slate-900">Writing practice</h1>
          <p className="mt-1 text-sm text-slate-600">
            Write under exam conditions, then get band estimates against all four published criteria.
          </p>
        </div>
        {started && !grade && <Timer minutes={task.timeMinutes} running />}
      </div>

      <div className="card">
        <label className="mb-1 block text-xs text-slate-500">Choose a task</label>
        <select
          className="input w-full"
          value={taskId}
          onChange={(e) => {
            setTaskId(e.target.value);
            setEssay("");
            setGrade(null);
            setError(null);
            setStarted(false);
          }}
        >
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              Task {t.task} ({t.variant}) — {t.title}
            </option>
          ))}
        </select>

        <div className="mt-4 rounded-lg bg-slate-50 p-4">
          <p className="whitespace-pre-line text-[15px] leading-7 text-slate-800">{task.prompt}</p>
          {/*
            A chart where the real exam would print one. The renderer landed in
            #34 and nothing used it until now: every Academic Task 1 was a
            table, which is the one prompt type the real paper uses least.
          */}
          {task.chart && <Chart spec={task.chart} className="mt-4" />}
          {task.dataTable && (
            <div className="mt-4 overflow-x-auto">
              <p className="mb-2 text-sm font-semibold text-slate-700">{task.dataTable.title}</p>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {task.dataTable.headers.map((h) => (
                      <th
                        key={h}
                        className="border border-slate-300 bg-slate-100 px-3 py-2 text-left font-semibold text-slate-700"
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
                        <td key={j} className="border border-slate-300 px-3 py-2 text-slate-700">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Write at least {task.minWords} words. Recommended time: {task.timeMinutes} minutes.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-800">Your response</label>
          <span
            className={`text-xs ${
              wordCount >= task.minWords ? "text-emerald-600" : "text-slate-400"
            }`}
          >
            {wordCount} / {task.minWords} words
          </span>
        </div>
        <textarea
          className="input h-80 w-full resize-y font-sans leading-7"
          placeholder="Start typing your response…"
          value={essay}
          onFocus={() => setStarted(true)}
          onChange={(e) => setEssay(e.target.value)}
          disabled={grading}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="btn-primary"
            onClick={submit}
            disabled={grading || wordCount < 40}
          >
            {grading ? "Examiner is marking…" : "Submit for AI marking"}
          </button>
          {wordCount < 40 && (
            <span className="text-xs text-slate-400">Write at least 40 words to submit.</span>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      </div>

      {grade && (
        <section className="space-y-4" data-lookupable>
          <div className="card flex flex-col items-center gap-6 py-6 sm:flex-row sm:justify-center">
            <BandBadge band={grade.overallBand} caption="Estimated writing band" />
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
              {grade.criteria.map((c) => (
                <div key={c.name} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-800">{c.name}</span>
                    <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                      {c.band}
                    </span>
                  </div>
                  <ExplainText
                    text={c.comment}
                    className="mt-1 block text-xs leading-5 text-slate-600"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-emerald-700">What worked</h3>
              <ul className="list-disc space-y-1 pl-4 text-sm text-slate-700">
                {grade.strengths.map((s, i) => (
                  <li key={i}>
                    <ExplainText text={s} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-amber-700">
                Priorities for your next attempt
              </h3>
              <ol className="list-decimal space-y-1 pl-4 text-sm text-slate-700">
                {grade.improvements.map((s, i) => (
                  <li key={i}>
                    <ExplainText text={s} />
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="card">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">
              Your weakest paragraph, rewritten one band higher
            </h3>
            <ExplainText
              text={grade.rewrittenExcerpt}
              className="block whitespace-pre-line text-[15px] leading-7 text-slate-700"
            />
          </div>

          <div className="flex gap-2">
            <Link href="/practice" className="btn-secondary">
              Back to practice
            </Link>
            <button
              className="btn-primary"
              onClick={() => {
                setEssay("");
                setGrade(null);
                setStarted(false);
              }}
            >
              Try this task again
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
