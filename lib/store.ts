"use client";

import type {
  GeneratedTest,
  MockExamReport,
  ModuleResult,
  PlacementResult,
  Profile,
} from "./types";
import { PROGRESS_WRITE_EVENT } from "./progress/events";
import { readLearnerItem, writeLearnerItem } from "./progress/storage";

const KEY = "ielts-prep-v1";

const EMPTY: Profile = Object.freeze({ results: [], genTests: [] }) as Profile;

/*
  The profile lives in sessionStorage — see lib/progress/storage.ts for why.
  It is exposed as an external store so
  components can read it with `useSyncExternalStore` — that keeps server and
  client renders consistent without loading state inside an effect.
*/

let cache: Profile | null = null;
const listeners = new Set<() => void>();

function read(): Profile {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = readLearnerItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      placement: parsed.placement,
      targetBand: parsed.targetBand,
      planDays: parsed.planDays,
      placementHistory: parsed.placementHistory ?? [],
      /*
        Must be listed here as well as written by its setter. This function
        rebuilds the profile field by field, so anything missing from it is
        dropped silently on the next load — the field would appear to save and
        then quietly forget itself.
      */
      visited: parsed.visited ?? [],
      results: parsed.results ?? [],
      mockReports: parsed.mockReports ?? [],
      historyClearedAt: parsed.historyClearedAt,
      placementClearedAt: parsed.placementClearedAt,
      deletedGenTests: parsed.deletedGenTests ?? {},
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
      writeLearnerItem(KEY, JSON.stringify(next));
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
 * How long the study plan runs, in days.
 *
 * Days rather than "2 weeks", so the plan can divide the window between its
 * blocks without parsing a label back into arithmetic. Which lengths are on
 * offer is lib/plan.ts's business; this only records the number it was handed,
 * and `resolveDuration` decides what to make of it on the way back out.
 */
export function setPlanDays(days: number): Profile {
  return commit({ ...getSnapshot(), planDays: days });
}

export function addResult(result: ModuleResult): Profile {
  const p = getSnapshot();
  return commit({ ...p, results: [result, ...p.results].slice(0, 100) });
}

/** Keeps one durable, sitting-level report for every completed full mock. */
export function addMockReport(report: MockExamReport): Profile {
  const p = getSnapshot();
  const previous = p.mockReports ?? [];
  const reports = [report, ...previous.filter((item) => item.id !== report.id)]
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, 30);
  return commit({ ...p, mockReports: reports });
}

/**
 * Clears the score archive without letting another device restore it.
 *
 * Empty arrays alone are not enough because account sync unions both copies.
 * The timestamp is a tombstone: mergeProfiles discards any sitting completed
 * before it, whichever device submits that sitting later.
 */
export function clearHistory(at = new Date().toISOString()): Profile {
  const p = getSnapshot();
  return commit({
    ...p,
    results: [],
    mockReports: [],
    historyClearedAt: at,
  });
}

export function addGeneratedTest(test: GeneratedTest): Profile {
  const p = getSnapshot();
  const id = test.test.id;
  const deletedGenTests = { ...(p.deletedGenTests ?? {}) };
  /* Defensive rather than ordinarily necessary: generated ids are unique,
     but if a provider repeats one, deliberately generating it again is a
     newer action than the old deletion. */
  delete deletedGenTests[id];
  return commit({ ...p, deletedGenTests, genTests: [test, ...p.genTests].slice(0, 20) });
}

/**
 * Throws away one generated test.
 *
 * By id rather than by index, because the list is rendered filtered by kind
 * and re-sorted, so the position a learner tapped is not the position in the
 * array. An id that is not there is a no-op rather than an error — two taps on
 * the same card, or a card removed in another tab, are both ordinary.
 *
 * Nothing else is touched. A generated test a learner has already sat leaves
 * its result behind in `results`, where it belongs: they did sit it, and their
 * history should not quietly lose a band because they tidied up afterwards.
 */
export function removeGeneratedTest(id: string): Profile {
  const p = getSnapshot();
  const next = p.genTests.filter((g) => g.test.id !== id);
  if (next.length === p.genTests.length) return p;
  return commit({
    ...p,
    genTests: next,
    deletedGenTests: {
      ...(p.deletedGenTests ?? {}),
      [id]: new Date().toISOString(),
    },
  });
}
