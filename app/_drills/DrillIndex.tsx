"use client";

import { useState, useSyncExternalStore } from "react";
import Drill from "@/components/Drill";
import ExplainText from "@/components/ExplainText";
import {
  type DrillTopic,
  drillScores,
  getServerDrillScores,
  subscribeDrills,
} from "@/lib/drills";

/**
 * A topic carrying the long explanation the index keeps behind a disclosure.
 *
 * `detail` lives in the JSON rather than in `lib/drills`, so the shared
 * DrillTopic type is widened here instead of changed for every caller.
 */
export type IndexTopic = DrillTopic & { detail?: string };

/**
 * A study section: scan the topics, open one, read the rule, drill it.
 *
 * The index has to survive being read on a phone. Every card shows one short
 * sentence saying what the topic is, and hides the fuller explanation behind a
 * <details> — a learner deciding between ten topics can see several at once,
 * and the one who wants the reasoning is a single tap away from it rather than
 * a page away. Native <details> is doing the work here on purpose: it brings
 * keyboard and screen-reader behaviour with it and needs no JavaScript, which
 * also means it still works in the static iOS export.
 */
export default function DrillIndex({
  title,
  intro,
  topics,
}: {
  title: string;
  intro: string;
  topics: IndexTopic[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const scores = useSyncExternalStore(subscribeDrills, drillScores, getServerDrillScores);

  const topic = topics.find((t) => t.id === openId) ?? null;

  if (topic) {
    return (
      <div className="space-y-4">
        <div className="card" data-lookupable>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-lg font-semibold text-slate-900">{topic.title}</h1>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
              {topic.level}
            </span>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">{topic.summary}</p>
          {/* Open in full here: the learner has already chosen this topic, so
              there is nothing left to scan past. */}
          {topic.detail && (
            <p className="mt-2 text-sm leading-6 text-slate-600">{topic.detail}</p>
          )}
          <ul className="mt-3 space-y-1.5">
            {topic.points.map((point, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-slate-700">
                <span aria-hidden className="mt-[3px] shrink-0 text-amber-500">
                  →
                </span>
                <ExplainText text={point} />
              </li>
            ))}
          </ul>
        </div>
        <Drill topic={topic} onExit={() => setOpenId(null)} />
      </div>
    );
  }

  const done = topics.filter((t) => scores[t.id]).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[26px] font-semibold text-slate-900">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{intro}</p>
        <p className="mt-2 text-xs text-slate-400">
          No clock, no band score — work through a topic as slowly as you like.
          {done > 0 ? ` You have practised ${done} of ${topics.length} topics.` : ""}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {topics.map((t) => {
          const score = scores[t.id];
          const pct = score ? Math.round((score.correct / score.total) * 100) : null;
          return (
            <div
              key={t.id}
              className="card flex flex-col transition-all duration-200 hover:border-indigo-300 motion-reduce:transition-none"
            >
              {/* The card's main job is still to start the drill, so that stays
                  one big target rather than becoming a link at the bottom. */}
              <button
                type="button"
                onClick={() => setOpenId(t.id)}
                className="-m-2 rounded-xl p-2 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-slate-900">{t.title}</h2>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                    {t.level}
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-6 text-slate-600">{t.summary}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded bg-slate-100 px-2 py-0.5">
                    {t.questions.length} questions
                  </span>
                  {pct !== null && (
                    <span
                      className={`rounded px-2 py-0.5 font-semibold ${
                        pct >= 75
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-800"
                      }`}
                    >
                      Best {score.correct}/{score.total}
                    </span>
                  )}
                </div>
              </button>

              {t.detail && (
                <details className="group mt-3 border-t border-slate-200">
                  {/*
                    The whole row is the control, not just the arrow: at 44px
                    tall and full width it is a comfortable thumb target. The
                    browser's own triangle is removed so the arrow can match the
                    rest of the app.
                  */}
                  <summary className="-mx-2 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-xl px-2 text-xs font-medium text-indigo-700 hover:text-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 [&::-webkit-details-marker]:hidden">
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
                    >
                      <path d="M7.5 4.5 13 10l-5.5 5.5" />
                    </svg>
                    <span className="group-open:hidden">What is this?</span>
                    <span className="hidden group-open:inline">Hide</span>
                  </summary>
                  <p className="pb-1 text-sm leading-6 text-slate-600">{t.detail}</p>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
