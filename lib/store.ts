"use client";

import type { GeneratedTest, ModuleResult, PlacementResult, Profile } from "./types";

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
  }
  for (const l of listeners) l();
  return next;
}

export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
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

/** Question ids used by the previous two placement tests. */
export function recentPlacementQuestionIds(): string[] {
  return (getSnapshot().placementHistory ?? []).flat();
}

export function setTargetBand(band: number): Profile {
  return commit({ ...getSnapshot(), targetBand: band });
}

export function addResult(result: ModuleResult): Profile {
  const p = getSnapshot();
  return commit({ ...p, results: [result, ...p.results].slice(0, 100) });
}

export function addGeneratedTest(test: GeneratedTest): Profile {
  const p = getSnapshot();
  return commit({ ...p, genTests: [test, ...p.genTests].slice(0, 20) });
}
