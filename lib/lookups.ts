"use client";

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

function read(): Cache {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Cache) : {};
  } catch {
    return {};
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

function snapshot(): Cache {
  if (cache === null) cache = read();
  return cache;
}

function invalidate(next: Cache): void {
  cache = next;
  sorted = null;
  for (const listener of listeners) listener();
}

export function subscribeLookups(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Newest first, for the saved-words list. Stable until the data changes. */
export function savedWords(): Definition[] {
  if (sorted === null) {
    sorted = Object.values(snapshot()).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }
  return sorted;
}

export function getServerSavedWords(): Definition[] {
  return [];
}

export function cachedLookup(term: string): Definition | undefined {
  return snapshot()[term.trim().toLowerCase()];
}

function persist(next: Cache): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable localStorage just means no caching.
  }
}

export function saveLookup(definition: Definition): void {
  const next: Cache = { ...snapshot(), [definition.term.trim().toLowerCase()]: definition };
  const keys = Object.keys(next);
  if (keys.length > LIMIT) delete next[keys[0]];
  persist(next);
  invalidate(next);
}

export function forgetLookup(term: string): void {
  const next = { ...snapshot() };
  delete next[term.trim().toLowerCase()];
  persist(next);
  invalidate(next);
}
