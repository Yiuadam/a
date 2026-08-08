"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import DrillSection from "@/components/DrillSection";
import vocabularyData from "@/data/vocabulary.json";
import type { DrillData } from "@/lib/drills";
import { forgetLookup, getServerSavedWords, savedWords, subscribeLookups } from "@/lib/lookups";

const { topics } = vocabularyData as DrillData;

/**
 * Every word the learner has looked up, kept on the device.
 *
 * This is the most useful word list they could have, because they did not
 * choose it: each entry is a word they actually met and did not know.
 */
function MyWords() {
  const words = useSyncExternalStore(subscribeLookups, savedWords, getServerSavedWords);
  if (words.length === 0) return null;

  return (
    <section className="card" data-lookupable>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Words you looked up</h2>
        <span className="text-xs text-slate-500">{words.length} saved on this device</span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Collected automatically whenever you look a word up while reading. Nothing here was
        chosen for you.
      </p>
      <ul className="mt-3 divide-y divide-slate-200">
        {words.slice(0, 40).map((w) => (
          <li key={w.term} className="flex items-start gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900">{w.term}</p>
              <p className="text-sm leading-6 text-slate-600">{w.short}</p>
              {w.example && (
                <p className="mt-0.5 text-xs italic leading-5 text-slate-500">{w.example}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => forgetLookup(w.term)}
              aria-label={`Remove ${w.term}`}
              className="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {words.length > 40 && (
        <p className="mt-3 text-xs text-slate-400">
          Showing the 40 most recent of {words.length}.
        </p>
      )}
    </section>
  );
}

export default function VocabularyPage() {
  return (
    <div className="space-y-8">
      <DrillSection
        title="Vocabulary practice"
        intro="Eight topics on the vocabulary that earns marks — collocations, phrasal verbs, word families and easy confusions. Read the note, then drill it."
        topics={topics}
      />
      <MyWords />
      <p className="text-xs text-slate-400">
        Looking for exam-format practice instead?{" "}
        <Link href="/practice" className="text-indigo-600 hover:underline">
          Reading, listening and writing tests
        </Link>{" "}
        are scored on the 9-band scale.
      </p>
    </div>
  );
}
