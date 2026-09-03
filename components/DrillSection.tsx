"use client";

import { useState, useSyncExternalStore } from "react";
import Drill from "@/components/Drill";
import ExplainText from "@/components/ExplainText";
import LockedCard from "@/components/LockedCard";
import MoreComing from "@/components/MoreComing";
import NewBadge from "@/components/NewBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import styles from "./DrillSection.module.css";
import { drillNeedsNewBadge } from "@/lib/completion-badges";
import {
  drillLimit,
  drillLockReason,
  orderTopics,
  type DrillKind,
} from "@/lib/entitlements/drills";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
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
  kind,
  title,
  intro,
  topics,
  compact = false,
  compactColumns = 4,
}: {
  /** Which list this is, for what a lock says out loud. */
  kind: DrillKind;
  title: string;
  intro: string;
  topics: DrillTopic[];
  /** A denser, route-opt-in chooser and two-column desktop lesson workspace. */
  compact?: boolean;
  /** Grammar can opt into five desktop columns without a shared global rule. */
  compactColumns?: 4 | 5;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const scores = useSyncExternalStore(subscribeDrills, drillScores, getServerDrillScores);
  const access = useSessionAccess();

  /*
    Openable ones first, medium first among those — see
    lib/entitlements/drills.ts. Everything past the allowance is still drawn,
    title and level and question count readable, behind a lock.
  */
  const ordered = orderTopics(topics, access.tier);
  const limit = drillLimit(access.tier);

  /*
    Position-checked, not just found. A locked card is a link rather than a
    button so nothing in the UI can set `openId` to a locked topic — but a tier
    that drops under a learner mid-session (a subscription ending while the
    page is open) would otherwise leave them inside a topic they no longer
    have, and the honest answer there is to put them back on the index.
  */
  const openIndex = ordered.findIndex((t) => t.id === openId);
  const topic =
    openIndex >= 0 && (limit === null || openIndex < limit) ? ordered[openIndex] : null;
  const done = topics.filter((t) => scores[t.id]).length;

  if (topic) {
    if (compact) {
      return (
        <div
          className={styles.compactWorkspace}
          data-drill-compact="true"
          data-drill-workspace
        >
          <section className={styles.compactLesson} data-lookupable>
            <div className={styles.compactLessonHeader}>
              <h1 className={`font-semibold text-slate-900 ${styles.compactLessonTitle}`}>{topic.title}</h1>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
                {topic.level}
              </span>
            </div>
            <p className={`text-slate-600 ${styles.compactLessonSummary}`}>{topic.summary}</p>
            <ul className={`space-y-1.5 ${styles.compactLessonPoints}`}>
              {topic.points.map((point, i) => (
                <li key={i} className={`flex text-slate-700 ${styles.compactLessonPoint}`}>
                  <span aria-hidden className="mt-[3px] shrink-0 text-indigo-500">
                    →
                  </span>
                  <ExplainText text={point} />
                </li>
              ))}
            </ul>
          </section>
          <div className={styles.compactExercise}>
            <Drill topic={topic} onExit={() => setOpenId(null)} />
          </div>
        </div>
      );
    }

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
                <span aria-hidden className="mt-[3px] shrink-0 text-indigo-500">
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

  return (
    <div
      className={compact ? styles.compactIndex : "space-y-6"}
      data-drill-compact={compact ? "true" : undefined}
    >
      <div className={compact ? styles.compactHeader : undefined}>
        {compact ? (
          <div className={styles.compactHeaderTop}>
            <h1 className={`font-semibold text-slate-900 ${styles.compactHeading}`}>{title}</h1>
            <span className={styles.compactProgress}>
              {done > 0 ? `${done} of ${topics.length} practised` : `${topics.length} topics`}
            </span>
          </div>
        ) : (
          <h1 className="text-[1.625rem] font-semibold text-slate-900">{title}</h1>
        )}
        <p
          className={
            compact
              ? `text-slate-600 ${styles.compactIntro}`
              : "mt-1 max-w-2xl text-sm leading-6 text-slate-600"
          }
        >
          {intro}
        </p>
        <p className={compact ? styles.compactNote : "mt-2 text-xs text-slate-400"}>
          There is no clock and no band score here. Take as long as you like.
          {done > 0 ? ` You have practised ${done} of ${topics.length} topics.` : ""}
        </p>
      </div>

      <div
        className={
          compact
            ? `${styles.compactGrid} ${compactColumns === 5 ? styles.compactGridFive : ""}`
            : "grid gap-4 sm:grid-cols-2"
        }
        data-drill-topic-index={compact ? "true" : undefined}
      >
        {ordered.map((t, i) => {
          const score = scores[t.id];
          const pct = score ? Math.round((score.correct / score.total) * 100) : null;
          /* Strictly by position, on the order above. Same rule as the papers. */
          const beyond = limit !== null && i >= limit;

          const inner = (
            <>
              <div className={compact ? styles.compactCardHeader : "flex items-start justify-between gap-3"}>
                <h2 className={compact ? styles.compactCardTitle : "min-w-0 font-semibold text-slate-900"}>
                  {t.title}
                </h2>
                <div className={compact ? "items-center" : "flex shrink-0 items-center gap-1.5"}>
                  <NewBadge show={drillNeedsNewBadge(scores, t.id)} />
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                    {t.level}
                  </span>
                </div>
              </div>
              {/*
                One sentence on the index, the whole note on the topic page.
                The card is for choosing between topics, and three lines of
                prose per card turned that choice into a page of reading —
                for an audience whose English is the thing being taught.
              */}
              <p className={compact ? styles.compactSummary : "mt-1.5 line-clamp-2 text-sm leading-6 text-slate-600"}>
                {firstSentence(t.summary)}
              </p>
              <div className={compact ? `flex flex-wrap items-center ${styles.compactMeta}` : "mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500"}>
                <span className="rounded bg-slate-100 px-2 py-0.5">
                  {t.questions.length} questions
                </span>
                {pct !== null && (
                  <>
                    {/* Same two facts as a paper card: that it is done, and
                        how well. A drill is scored out of its own question
                        count rather than in bands, so the number differs; the
                        badge does not. */}
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Done
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 font-semibold ${
                        pct >= 75
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-800"
                      }`}
                    >
                      Best {score.correct}/{score.total}
                    </span>
                  </>
                )}
              </div>
            </>
          );

          /*
            Not known yet — inert rather than open. Drawing these as buttons
            while the account lookup is in flight is what let a visitor click
            into a topic a second before its lock arrived.
          */
          if (access.pending) {
            return (
              <div
                key={t.id}
                className={`${compact ? styles.compactCard : "card"} relative cursor-wait opacity-60`}
                aria-busy="true"
              >
                <LoadingIndicator label="Checking access…" className="absolute right-3 top-3 text-sm text-indigo-600" textClassName="sr-only" />
                {inner}
              </div>
            );
          }

          if (beyond) {
            return (
              <LockedCard
                key={t.id}
                reason={drillLockReason(access.tier)}
                fill
                label={`${t.title}, a ${kind} topic`}
              >
                <div className={`${compact ? `${styles.compactCard} h-full` : "card h-full"}`}>{inner}</div>
              </LockedCard>
            );
          }

          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setOpenId(t.id)}
              className={`${compact ? styles.compactCard : "card"} block w-full text-left transition-all hover:-translate-y-0.5 hover:border-indigo-300`}
            >
              {inner}
            </button>
          );
        })}

        {compact ? (
          <div className={styles.compactMoreCell} data-drill-more-coming>
            <MoreComing what={`${kind} topics`} className={styles.compactMore} />
          </div>
        ) : (
          <MoreComing what={`${kind} topics`} />
        )}
      </div>
    </div>
  );
}
