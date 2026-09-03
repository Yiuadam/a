"use client";

import { useState } from "react";
import Link from "next/link";
import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import speakingData from "@/data/speaking-topics.json";
import type { SpeakingTopicsData } from "@/lib/types";

const data = speakingData as SpeakingTopicsData;

/*
  Every question the examiner can ask, readable before anybody has to answer one.

  The interview picks its own topics, which is right for a mock and wrong as the
  only way in: a candidate preparing for Part 2 wants to see the cue cards, read
  the bullets, and think about one before the clock starts. Until now the only
  way to see a card was to be given it, and the only way to be given a
  particular one was luck.

  So: all of it on a page, and a card is a button. Tapping one starts a real
  interview built around it — /speaking?card=<id>, which SpeakingSession reads
  when it assembles the questions. Part 3 follows the card's topic already, so
  choosing a card settles two thirds of the interview, which is what makes the
  choice worth offering rather than a novelty.

  Part 1 is listed and not choosable, deliberately. Its questions are small talk
  about your home and your job; nobody prepares for one in particular, and
  offering to start an interview from "Do you live in a house or an apartment?"
  would be offering a control that does not mean anything.
*/

const PARTS = [
  { id: "part1", label: "Part 1 — about you" },
  { id: "part2", label: "Part 2 — the long turn" },
  { id: "part3", label: "Part 3 — the discussion" },
] as const;

export default function SpeakingQuestionsPage() {
  const [part, setPart] = useState<(typeof PARTS)[number]["id"]>("part2");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-[1.375rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
          Speaking questions
        </h1>
        <p className="text-[0.9375rem] leading-7 text-slate-600">
          Every question the examiner can ask, to read before you answer one. Tap a Part 2 card to
          start an interview built around it.
        </p>
      </div>

      <div
        className="panel-toggle-base relative grid w-full rounded-xl p-0.5"
        role="tablist"
        aria-label="Interview part"
        style={{ gridTemplateColumns: `repeat(${PARTS.length}, minmax(0, 1fr))` }}
      >
        {PARTS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={part === option.id}
            onClick={() => setPart(option.id)}
            className={`relative z-10 min-w-0 truncate rounded-lg px-2 py-1.5 text-[0.8125rem] font-medium transition-colors ${
              part === option.id ? "side-rail-item-active text-slate-900" : "text-slate-600"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {part === "part1" && (
        <ul className="space-y-2.5">
          {data.part1.map((topic) => (
            <li key={topic.topic} className="card !p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[0.9375rem] font-semibold text-slate-900">{topic.topic}</h2>
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-400">
                  {topic.level}
                </span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {topic.questions.map((question) => (
                  <li key={question} className="text-[0.875rem] leading-6 text-slate-600">
                    {question}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {part === "part2" && (
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {data.part2.map((card) => (
            <li key={card.id} className="min-w-0">
              {/* The whole card starts the interview, for the reason the module
                  library gives: the thing being read is the thing being chosen. */}
              <IntentPrefetchLink
                href={`/speaking?card=${encodeURIComponent(card.id)}`}
                className="card hub-menu-card flex h-full min-w-0 flex-col !p-4 text-left active:translate-y-px"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[0.9375rem] font-semibold text-slate-900">{card.topic}</span>
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-400">
                    {card.level}
                  </span>
                </span>
                <span className="mt-1 block text-[0.875rem] leading-6 text-slate-700">
                  {card.cueCard}
                </span>
                <ul className="mt-1.5 space-y-0.5">
                  {card.bullets.map((bullet) => (
                    <li key={bullet} className="text-[0.8125rem] leading-5 text-slate-500">
                      · {bullet}
                    </li>
                  ))}
                </ul>
                <span className="mt-auto pt-2.5 text-[0.875rem] font-medium text-indigo-700">
                  Practise this card →
                </span>
              </IntentPrefetchLink>
            </li>
          ))}
        </ul>
      )}

      {part === "part3" && (
        <ul className="space-y-2.5">
          {data.part3.map((topic) => (
            <li key={topic.topic} className="card !p-4">
              <h2 className="text-[0.9375rem] font-semibold text-slate-900">{topic.topic}</h2>
              <ul className="mt-1.5 space-y-1">
                {topic.questions.map((question) => (
                  <li key={question} className="text-[0.875rem] leading-6 text-slate-600">
                    {question}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[0.8125rem] leading-6 text-slate-500">
        Part 3 follows whichever Part 2 card you sit, so choosing a card chooses the discussion
        too. <Link href="/speaking" className="underline underline-offset-2">Start a random interview</Link> instead.
      </p>
    </div>
  );
}
