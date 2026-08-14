"use client";

import { PROGRESS_WRITE_EVENT } from "./progress/events";
import { readLearnerItem, writeLearnerItem } from "./progress/storage";

export interface Definition {
  term: string;
  partOfSpeech?: string;
  short: string;
  example?: string;
  inContext?: string;
  /** Where it came from, so the panel can say so honestly. */
  source: "glossary" | "ai" | "cache";
  /** When it was first looked up — drives the "words you looked up" list. */
  at?: string;
  /**
   * A learner-controlled revision, deliberately separate from the definition.
   * `false` is kept too: it is the tombstone that stops an old device from
   * restoring a word the learner has just unpinned on another one.
   */
  favourite?: boolean;
  favouriteUpdatedAt?: string;
  /**
   * A learner can pin a word even while the definition service is unavailable.
   * Keep that lightweight record in history, but never treat it as a usable
   * cached definition: the next lookup must still retry the service.
   */
  pendingDefinition?: boolean;
}

/*
  Looked-up words are kept on the device.

  Two reasons: a repeat lookup should be instant and free rather than another
  request, and the list of words a learner has had to look up is itself the
  most personal vocabulary list they could have — far more use to them than any
  generic word list, because every entry is one they actually met and did not
  know.
*/
const KEY = "bandup.lookups.v1";
const LIMIT = 300;

type Cache = Record<string, Definition>;

/*
  Frozen empties, handed out by identity for the same reason the sorted list
  below is memoised: a snapshot that returns a fresh value every call is a new
  value to React on every render. Neither is ever mutated in place — saveLookup
  and forgetLookup both build a new object — so sharing one instance is safe.
*/
const EMPTY_CACHE: Cache = Object.freeze({}) as Cache;
const EMPTY_WORDS: Definition[] = Object.freeze([]) as unknown as Definition[];

function read(): Cache {
  if (typeof window === "undefined") return EMPTY_CACHE;
  try {
    const raw = readLearnerItem(KEY);
    return raw ? (JSON.parse(raw) as Cache) : EMPTY_CACHE;
  } catch {
    return EMPTY_CACHE;
  }
}

const listeners = new Set<() => void>();
let cache: Cache | null = null;
/*
  The sorted list is memoised alongside the cache it was built from.

  useSyncExternalStore compares snapshots by identity, so a getSnapshot that
  sorts on every call hands React a brand-new array each render and it loops
  forever. The list must stay the same object until the data behind it changes.
*/
let sorted: Definition[] | null = null;
let favourites: Definition[] | null = null;

function snapshot(): Cache {
  if (cache === null) cache = read();
  return cache;
}

function invalidate(next: Cache): void {
  cache = next;
  sorted = null;
  favourites = null;
  for (const listener of listeners) listener();
}

export function subscribeLookups(listener: () => void): () => void {
  listeners.add(listener);
  /*
    A write from another tab — or from a progress sync in this one — has to
    invalidate the cached snapshot, or the page keeps rendering data that is no
    longer what is stored. `storage` fires in other tabs by default; sync.ts
    dispatches it here as well so a merge repaints without a reload.
  */
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = null;
    sorted = null;
    favourites = null;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Newest first, for the learner's lookup history. Stable until data changes. */
export function lookupHistory(): Definition[] {
  if (sorted === null) {
    const words = Object.values(snapshot());
    // Nothing saved is the case the server rendered, so hand back the very
    // same array it did rather than an equal-but-different empty one.
    sorted =
      words.length === 0
        ? EMPTY_WORDS
        : words.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }
  return sorted;
}

/** Backwards-compatible name used by the Vocabulary page. */
export function savedWords(): Definition[] {
  return lookupHistory();
}

/** Pinned lookup words, most recently pinned first. */
export function favouriteWords(): Definition[] {
  if (favourites === null) {
    const words = lookupHistory().filter((word) => word.favourite === true);
    favourites =
      words.length === 0
        ? EMPTY_WORDS
        : words.sort((a, b) =>
            (b.favouriteUpdatedAt ?? b.at ?? "").localeCompare(a.favouriteUpdatedAt ?? a.at ?? ""),
          );
  }
  return favourites;
}

export function getServerSavedWords(): Definition[] {
  return EMPTY_WORDS;
}

/** Return the saved record, including a word pinned while offline. */
export function savedLookup(term: string): Definition | undefined {
  return snapshot()[term.trim().toLowerCase()];
}

/** A complete cached definition. A pinned-offline record must be retried. */
export function cachedLookup(term: string): Definition | undefined {
  const saved = savedLookup(term);
  return saved?.pendingDefinition ? undefined : saved;
}

function persist(next: Cache): void {
  try {
    writeLearnerItem(KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable localStorage just means no caching.
  }
  // Lets a signed-in account follow along — see lib/progress/autosync.ts.
  window.dispatchEvent(new Event(PROGRESS_WRITE_EVENT));
}

function lookupKey(term: string): string {
  return term.trim().toLowerCase();
}

function trimHistory(next: Cache): void {
  const entries = Object.entries(next);
  if (entries.length <= LIMIT) return;

  /* A pinned word is a deliberate study choice, so only evict it if every
     lookup is pinned. The oldest unpinned entries leave first. */
  const oldestFirst = (left: [string, Definition], right: [string, Definition]) =>
    (left[1].at ?? "").localeCompare(right[1].at ?? "");
  const removable = entries
    .filter(([, definition]) => definition.favourite !== true)
    .sort(oldestFirst);
  const candidates = removable.length >= entries.length - LIMIT
    ? removable
    : [...removable, ...entries.filter(([, definition]) => definition.favourite === true).sort(oldestFirst)];

  for (const [key] of candidates.slice(0, entries.length - LIMIT)) delete next[key];
}

/**
 * Save or refresh a word after a successful lookup. A re-lookup must not wipe
 * a favourite flag that may have been set from History on this or another tab.
 */
export function saveLookup(definition: Definition): Definition {
  const key = lookupKey(definition.term);
  const current = snapshot()[key];
  const saved: Definition = {
    ...definition,
    favourite: definition.favourite ?? current?.favourite,
    favouriteUpdatedAt: definition.favouriteUpdatedAt ?? current?.favouriteUpdatedAt,
  };
  const next: Cache = { ...snapshot(), [key]: saved };
  trimHistory(next);
  persist(next);
  invalidate(next);
  return saved;
}

/**
 * Save a word for revision when its definition cannot be fetched yet. This
 * gives the panel's favourite control a real, syncable record without
 * poisoning the definition cache.
 */
export function saveLookupForLater(term: string): Definition | null {
  const clean = term.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const current = savedLookup(clean);
  if (current) return current;
  return saveLookup({
    term: clean,
    short: "Saved for review — look it up again when you are connected.",
    source: "cache",
    at: new Date().toISOString(),
    pendingDefinition: true,
  });
}

/** Pin or unpin a saved word without deleting its definition or lookup history. */
export function setLookupFavourite(term: string, favourite: boolean): Definition | null {
  const key = lookupKey(term);
  const current = snapshot()[key];
  if (!current) return null;
  const saved: Definition = {
    ...current,
    favourite,
    favouriteUpdatedAt: new Date().toISOString(),
  };
  const next: Cache = { ...snapshot(), [key]: saved };
  persist(next);
  invalidate(next);
  return saved;
}

export function forgetLookup(term: string): void {
  const next = { ...snapshot() };
  delete next[lookupKey(term)];
  persist(next);
  invalidate(next);
}
