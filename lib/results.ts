import type { ModuleName, ModuleResult } from "./types";

/** JSON-safe answers for a completed sitting; unanswered questions are absent. */
export function savedAnswers(
  answers: Record<string, string | number | undefined>,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(answers).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
}

/*
  Reading a learner's results, without depending on the order they arrive in.

  This module exists because the order was not what its readers believed. Two
  places build the list and they disagreed:

    lib/store.ts addResult   prepends, so a single device is newest-first
    lib/progress/merge.ts    sorted the union oldest-first

  Every reader was written against the first of those — `results.find(r =>
  r.module === m)` named its variable `latest`, the dashboard sliced the first
  six as "recent". After a sync those same lines returned the learner's
  *oldest* sitting instead. On the dashboard that is a stale number; in
  lib/plan.ts it is worse, because the plan orders modules by band and would
  send a learner to practise whatever they were weakest at months ago.

  The merge now sorts newest-first, so the two agree. These helpers exist so
  that agreement stops being load-bearing: `latestFor` scans for the maximum
  date rather than trusting position, and cannot be wrong whichever way the
  array happens to be ordered.
*/

function timeOf(r: ModuleResult): number {
  const t = Date.parse(r.date);
  return Number.isFinite(t) ? t : 0;
}

/** Newest first. Does not mutate the input. */
export function newestFirst(results: readonly ModuleResult[]): ModuleResult[] {
  return results.slice().sort((a, b) => timeOf(b) - timeOf(a));
}

/** Oldest first — the direction a trend line reads in. */
export function oldestFirst(results: readonly ModuleResult[]): ModuleResult[] {
  return results.slice().sort((a, b) => timeOf(a) - timeOf(b));
}

/** Every sitting of one module, oldest first. */
export function seriesFor(results: readonly ModuleResult[], module: ModuleName): ModuleResult[] {
  return oldestFirst(results.filter((r) => r.module === module));
}

/**
 * The most recent sitting of a module, or undefined.
 *
 * By date, not by position — see the note at the top of this file.
 */
export function latestFor(
  results: readonly ModuleResult[],
  module: ModuleName,
): ModuleResult | undefined {
  let best: ModuleResult | undefined;
  for (const r of results) {
    if (r.module !== module) continue;
    if (best === undefined || timeOf(r) >= timeOf(best)) best = r;
  }
  return best;
}
