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
 * A study section: pick a topic, read the rule, drill it.
 *
 * Both grammar and vocabulary use this. Neither is shaped like the exam,
 * deliberately — a learner who keeps failing the same tense needs to practise
 * that tense, not to sit another whole paper and discover the same thing.
 */
/**
 * The first sentence of a teaching note, for the index card.
 *
 * Falls back to the whole string when there is no sentence break, so a summary
 * written as one long clause is shown rather than swallowed. The CSS clamp
 * behind this handles the case where that one sentence is still long.
 */
function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

export default function DrillSection({
  title,
  intro,
  topics,
}: {
  title: string;
  intro: string;
  topics: DrillTopic[];
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
            <button
              key={t.id}
              type="button"
              onClick={() => setOpenId(t.id)}
              className="card block text-left transition-all hover:-translate-y-0.5 hover:border-indigo-300"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold text-slate-900">{t.title}</h2>
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                  {t.level}
                </span>
              </div>
              {/*
                One sentence on the index, the whole note on the topic page.
                The card is for choosing between topics, and three lines of
                prose per card turned that choice into a page of reading —
                for an audience whose English is the thing being taught.
              */}
              <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-slate-600">
                {firstSentence(t.summary)}
              </p>
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
          );
        })}
      </div>
    </div>
  );
}
