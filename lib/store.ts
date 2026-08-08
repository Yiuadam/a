"use client";

import type { GeneratedTest, ModuleResult, PlacementResult, Profile } from "./types";
import { PROGRESS_WRITE_EVENT } from "./progress/events";

const KEY = "ielts-prep-v1";

const EMPTY: Profile = Object.freeze({ results: [], genTests: [] }) as Profile;

/*
  The profile lives in localStorage. It is exposed as an external store so
  components can read it with `useSyncExternalStore` — that keeps server and
  client renders consistent without loading state inside an effect.
*/

let cache: Profile | null = null;
const listeners = new Set<() => void>();

function read(): Profile {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      placement: parsed.placement,
      targetBand: parsed.targetBand,
      placementHistory: parsed.placementHistory ?? [],
      /*
        Must be listed here as well as written by its setter. This function
        rebuilds the profile field by field, so anything missing from it is
        dropped silently on the next load — the field would appear to save and
        then quietly forget itself.
      */
      visited: parsed.visited ?? [],
      results: parsed.results ?? [],
      genTests: parsed.genTests ?? [],
    };
  } catch {
    return EMPTY;
  }
}

function commit(next: Profile): Profile {
  cache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage can be full or blocked (private mode) — keep the in-memory copy.
    }
    // Signed in, this is what makes the account copy follow along — see
    // lib/progress/autosync.ts. Signed out, nothing listens.
    window.dispatchEvent(new Event(PROGRESS_WRITE_EVENT));
  }
  for (const l of listeners) l();
  return next;
}

export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  /*
    A write from another tab — or from a progress sync in this one — has to
    invalidate the cached snapshot, or the page keeps rendering data that is no
    longer what is stored. `storage` fires in other tabs by default; sync.ts
    dispatches it here as well so a merge repaints without a reload.
  */
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = null;
    onChange();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Stable snapshot — the same object identity until something changes. */
export function getSnapshot(): Profile {
  if (cache === null) cache = read();
  return cache;
}

export function getServerSnapshot(): Profile {
  return EMPTY;
}

export function loadProfile(): Profile {
  return getSnapshot();
}

export function setPlacement(result: PlacementResult, questionIds: string[] = []): Profile {
  const p = getSnapshot();
  // Keep the last two sittings so the next test can avoid both, giving three
  // consecutive tests with no question in common.
  const history = [questionIds, ...(p.placementHistory ?? [])].slice(0, 2);
  return commit({ ...p, placement: result, placementHistory: history });
}

/**
 * The previous two sittings, newest first, each as its own list of ids.
 *
 * They stay separate rather than flattened because the item chooser relaxes
 * one sitting at a time when the bank runs short.
 */
export function recentPlacementSittings(): string[][] {
  return getSnapshot().placementHistory ?? [];
}

export function setTargetBand(band: number): Profile {
  return commit({ ...getSnapshot(), targetBand: band });
}

/**
 * Records that a learner has opened a module, which retires its "New" badge.
 *
 * Returns without writing when it is already recorded. Every write now
 * schedules a sync, so a no-op write would mean a network round trip each
 * time the dashboard link is followed.
 */
export function markVisited(key: string): Profile {
  const p = getSnapshot();
  const seen = p.visited ?? [];
  if (seen.includes(key)) return p;
  return commit({ ...p, visited: [...seen, key] });
}

export function addResult(result: ModuleResult): Profile {
  const p = getSnapshot();
  return commit({ ...p, results: [result, ...p.results].slice(0, 100) });
}

export function addGeneratedTest(test: GeneratedTest): Profile {
  const p = getSnapshot();
  return commit({ ...p, genTests: [test, ...p.genTests].slice(0, 20) });
}
