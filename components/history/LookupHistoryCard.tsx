"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  type Definition,
  favouriteWords,
  getServerSavedWords,
  lookupHistory,
  setLookupFavourite,
  subscribeLookups,
} from "@/lib/lookups";

function lookupDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : null;
}

function WordRow({ word, pinned }: { word: Definition; pinned: boolean }) {
  const date = lookupDate(word.at);
  const toggle = () => setLookupFavourite(word.term, !pinned);

  return (
    <li className="group flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={pinned}
        aria-label={pinned ? `Remove ${word.term} from favourites` : `Add ${word.term} to favourites`}
        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base transition-colors ${
          pinned
            ? "bg-indigo-100 text-indigo-800 hover:bg-indigo-200"
            : "text-slate-400 hover:bg-slate-100 hover:text-indigo-700"
        }`}
      >
        <span aria-hidden>{pinned ? "★" : "☆"}</span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="truncate text-sm font-semibold text-slate-900">{word.term}</p>
          {word.partOfSpeech && <span className="shrink-0 text-xs italic text-slate-500">{word.partOfSpeech}</span>}
          {date && <span className="ml-auto shrink-0 text-xs text-slate-400">{date}</span>}
        </div>
        <p className="mt-0.5 text-sm leading-5 text-slate-600">{word.short}</p>
      </div>
    </li>
  );
}

/**
 * A learner-owned word record lives with their practice history, rather than
 * hiding behind the Vocabulary drill. The pinned column intentionally repeats
 * a word from the complete list: it is a focused revision list, not a second
 * copy of the data.
 */
type LookupHistoryCardProps = {
  /** A concise entry point for the main History page. */
  compact?: boolean;
};

export default function LookupHistoryCard({ compact = false }: LookupHistoryCardProps) {
  const words = useSyncExternalStore(subscribeLookups, lookupHistory, getServerSavedWords);
  const pinned = useSyncExternalStore(subscribeLookups, favouriteWords, getServerSavedWords);

  if (compact) {
    return (
      <Link
        href="/history/lookups"
        className="card group flex items-center justify-between gap-4 !p-4 transition-colors hover:border-indigo-200 hover:bg-indigo-50/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        aria-label="Open lookup history"
        data-lookup-history-card
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-800">
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current">
                <path d="M3 2.25h7.1A2.9 2.9 0 0 1 13 5.15v8.6H5.9A2.9 2.9 0 0 0 3 16z" />
                <path d="M1 2.25h1.25v13.5H1zM5.9 4h5.25v1.1H5.9zm0 2.5h5.25v1.1H5.9zm0 2.5h3.65v1.1H5.9z" fill="var(--glass-fill-strong)" />
              </svg>
            </span>
            <span className="text-base font-semibold text-slate-900">Lookup history</span>
          </span>
          <span className="mt-1 block text-sm leading-5 text-slate-600">
            Review saved words and pin difficult ones for revision.
          </span>
          <span className="mt-1 block text-xs font-medium tabular-nums text-indigo-700">
            {words.length} saved · {pinned.length} pinned
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-xl text-indigo-600 transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </Link>
    );
  }

  return (
    <section className="card !p-0" aria-labelledby="lookup-history-title" data-lookup-history>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pb-3 pt-4 sm:px-5">
        <div>
          <h2 id="lookup-history-title" className="text-base font-semibold text-slate-900">
            Lookup history
          </h2>
          <p className="mt-0.5 text-sm leading-5 text-slate-600">
            Words you have looked up while studying.
          </p>
        </div>
        <span className="text-xs font-medium tabular-nums text-slate-500">
          {words.length} saved
        </span>
      </div>

      <div className="grid divide-y divide-slate-200 border-t border-slate-200 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.85fr)] lg:divide-x lg:divide-y-0">
        <div className="min-w-0 px-4 py-3 sm:px-5">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">All lookups</h3>
            <span className="text-xs text-slate-500">Newest first</span>
          </div>
          {words.length === 0 ? (
            <p className="py-2 text-sm leading-6 text-slate-500">
              Look up a word anywhere in practice and it will appear here.
            </p>
          ) : (
            <ul className="max-h-[23rem] divide-y divide-slate-100 overflow-y-auto pr-1">
              {words.map((word) => (
                <WordRow key={word.term.toLocaleLowerCase()} word={word} pinned={word.favourite === true} />
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 bg-indigo-50/45 px-4 py-3 sm:px-5">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-indigo-950">Pinned words</h3>
            <span className="text-xs font-medium tabular-nums text-indigo-700">{pinned.length}</span>
          </div>
          {pinned.length === 0 ? (
            <p className="py-2 text-sm leading-6 text-slate-600">
              Use the star beside a lookup to keep difficult words together here.
            </p>
          ) : (
            <ul className="max-h-[23rem] divide-y divide-indigo-100 overflow-y-auto pr-1">
              {pinned.map((word) => (
                <WordRow key={word.term.toLocaleLowerCase()} word={word} pinned />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
