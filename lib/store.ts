"use client";

import type {
  GeneratedTest,
  MockExamReport,
  ModuleResult,
  PlacementResult,
  Profile,
} from "./types";
import { clearDrillScores } from "./drills";
import { clearLookups } from "./lookups";
import { PROGRESS_WRITE_EVENT } from "./progress/events";
import { readLearnerItem, removeLearnerItem, writeLearnerItem } from "./progress/storage";

const KEY = "ielts-prep-v1";

const EMPTY: Profile = Object.freeze({ results: [], genTests: [] }) as Profile;

/*
  The in-progress mock exam's storage key, duplicated from lib/exam/mock.ts
  rather than imported from it.

  That file already imports readLearnerItem/writeLearnerItem/removeLearnerItem
  from ./progress/storage, so importing it back from here — or from
  ./progress/storage itself, which is where clearHistory's sibling
  clearProgressStore lives — would be a cycle. It would also drag the whole
  exam content bundle (the question banks, lib/tests, data/writing-tasks.json)
  into this file's bundle, which today is small and imported by nearly every
  page that touches a learner's progress. A repeated string constant costs far
  less than either of those; tests/mock-exam.test.mjs asserts the two literals
  stay equal, so a rename of the real key cannot drift from this one silently.
*/
const MOCK_EXAM_KEY = "bandup-mock-exam-v1";

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
      drillsClearedAt: parsed.drillsClearedAt,
      lookupsClearedAt: parsed.lookupsClearedAt,
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
 * Clears everything this device holds of a learner's own — every saved
 * score, the placement, the drill scores and the saved words — without
 * letting another device restore any of it.
 *
 * This used to clear only the score archive, and components/history/
 * ClearHistoryButton.tsx ("Clear all history") was deliberately the narrow
 * one of the app's two clears, built so the placement — and the study plan
 * built on it — survived it. The owner has since asked that either clear
 * remove everything a learner owns, so this now matches "clear this device"
 * (components/account/ClearDeviceSection.tsx, via clearSyncedProgress) in
 * what it takes down, and the two differ only in mechanism: this one commits
 * straight to the working copy in this tab, where clearSyncedProgress asks
 * the account first and only writes here once it agrees.
 *
 * Empty values alone are not enough because account sync unions every
 * device's copy. Each field below has its own tombstone — historyClearedAt,
 * placementClearedAt, drillsClearedAt, lookupsClearedAt — because results,
 * the placement, drill scores and saved words are four separately-synced
 * records with no one stamp that could cover all of them (see the doc
 * comments on Profile in lib/types.ts). mergeProfiles, mergeDrillScores and
 * mergeLookups (lib/progress/merge.ts) each discard anything dated at or
 * before its tombstone, whichever device submits it later. All four share
 * this one instant rather than each taking its own `new Date()`, so nothing
 * timed in the gap between them can land on the wrong side of two clocks.
 *
 * Drill scores and saved words live in their own synced records
 * (bandup.drills.v1, bandup.lookups.v1), not in this profile, so clearing
 * them is delegated to the modules that own them rather than reached into
 * from here — see lib/drills.ts's clearDrillScores and lib/lookups.ts's
 * clearLookups. The in-progress mock exam is cleared alongside them for the
 * same reason it must be: it is not itself synced progress, but it is still
 * something this learner owns on this device, and a clear that left a paper
 * resumable for the next person on a shared machine would not be a clear.
 */
export function clearHistory(at = new Date().toISOString()): Profile {
  const p = getSnapshot();
  clearDrillScores();
  clearLookups();
  removeLearnerItem(MOCK_EXAM_KEY);
  return commit({
    ...p,
    results: [],
    mockReports: [],
    historyClearedAt: at,
    placement: undefined,
    placementClearedAt: at,
    drillsClearedAt: at,
    lookupsClearedAt: at,
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
