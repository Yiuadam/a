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

  /*
    Folded shut by default. The topics are what the page is for; this is the
    learner's own collection, which they open when they want it — and the count
    in the summary is what tells them it is worth opening.
  */
  return (
    <details className="card !p-4 group" data-lookupable>
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="text-slate-400 transition-transform group-open:rotate-90"
        >
          ›
        </span>
        <h2 className="text-sm font-semibold text-slate-900">Words you looked up</h2>
        <span className="text-xs text-slate-500">
          {words.length} saved on this device, collected while you were reading
        </span>
      </summary>
      {/*
        Two columns and its own scrollbar. However many words a learner has
        collected, the list stays a panel on the page rather than a page of its
        own: every entry is still here, and the whole of each one is shown.
      */}
      <ul className="mt-2 max-h-[15rem] gap-x-6 overflow-y-auto sm:columns-2">
        {words.slice(0, 40).map((w) => (
          <li key={w.term} className="flex break-inside-avoid items-start gap-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-5 text-slate-600">
                <span className="font-medium text-slate-900">{w.term}</span> — {w.short}
              </p>
              {w.example && (
                <p className="text-xs italic leading-5 text-slate-500">{w.example}</p>
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
        <p className="mt-2 text-xs text-slate-400">
          Showing the 40 most recent of {words.length}.
        </p>
      )}
    </details>
  );
}

export default function VocabularyPage() {
  return (
    <div className="space-y-3" data-vocabulary-practice>
      <DrillSection
        compact
        kind="vocabulary"
        title="Vocabulary practice"
        intro="Eight topics of words that raise your band. Read the note, then answer the questions."
        topics={topics}
      />
      <MyWords />
      <p className="text-xs leading-5 text-slate-400">
        Looking for exam-format practice instead?{" "}
        <Link href="/practice" className="text-indigo-600 hover:underline">
          Reading, listening and writing tests
        </Link>{" "}
        are scored on the 9-band scale.
      </p>
    </div>
  );
}
