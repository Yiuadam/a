import type { Profile, ModuleResult, GeneratedTest, MockExamReport } from "@/lib/types";

/*
  Merging a learner's progress from two devices.

  This is the piece ACCOUNTS.md calls out as the one with a real chance of
  destroying something a learner cares about (threat 5). Somebody practises for
  a month, signs in for the first time, and is shown an empty study plan: they
  have been robbed by their own app, and there is no undo.

  So every function here is pure and total. Nothing reads localStorage, nothing
  calls the network, nothing throws on malformed input. That is what makes the
  rules testable, and the tests are the actual safety.

  The four rules, from ACCOUNTS.md:

    1. localStorage is never cleared on sign-in. It stays as the local copy,
       so a failed upload loses nothing. Enforced in sync.ts, not here.
    2. The first sign-in uploads, it does not download. An account with no
       snapshot takes what the browser has.
    3. A conflict merges, it does not overwrite. Nothing is discarded for
       arriving second.
    4. Signing out leaves the local copy alone.

  Rule 3 is the one with teeth, and it is why nothing below ever picks a whole
  object as the winner when it could union the parts.
*/

/** Milliseconds. A snapshot with no timestamp loses every comparison. */
export type Stamp = number | null | undefined;

function newer(a: Stamp, b: Stamp): boolean {
  return (a ?? 0) > (b ?? 0);
}

/*
  The identity of a sitting.

  ACCOUNTS.md says results are "unioned by test id". Taken literally that loses
  a re-sit: a learner who takes reading-1 twice, once on each device, would end
  up with one of the two attempts silently dropped, and losing an attempt is
  exactly the harm this whole file exists to prevent.

  Keying on the module, the test and the moment it was recorded is a superset
  of that rule. Two devices holding the same sitting produce the same key and
  collapse to one; two genuinely different attempts produce different keys and
  both survive.
*/
function resultKey(r: ModuleResult): string {
  return `${r.module}|${r.testId}|${r.date}`;
}

/*
  Newest first, matching what lib/store.ts addResult produces on a single
  device. Both orders are defensible; having two is not. Every reader of this
  list was written against addResult's order — the dashboard slices the first
  six as "recent", lib/plan.ts calls the first match `latest` — so a merged
  list in the opposite order silently answered those questions with the
  learner's oldest sitting. See lib/results.ts.
*/
function byDate(a: { date: string }, b: { date: string }): number {
  return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function latestIso(a: unknown, b: unknown): string | undefined {
  const left = validIso(a);
  const right = validIso(b);
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

/** Union two lists on a key, keeping the first occurrence of each. */
function unionBy<T>(first: T[], second: T[], key: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of [...first, ...second]) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * A sitting may exist in an old snapshot as a score-only row and in a newer
 * snapshot with its saved review. They are the same sitting, but discarding
 * the richer copy would recreate the history bug during the next sync.
 */
function unionResults(first: ModuleResult[], second: ModuleResult[]): ModuleResult[] {
  const out = new Map<string, ModuleResult>();
  for (const result of [...first, ...second]) {
    const key = resultKey(result);
    const current = out.get(key);
    if (!current || (!current.review && result.review)) out.set(key, result);
  }
  return [...out.values()];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Combines two profiles without discarding anything countable.
 *
 * Lists are unioned. Single values — the placement result, the target band —
 * cannot be unioned, so they are taken from whichever snapshot is newer, which
 * is the only place a timestamp decides anything.
 */
export function mergeProfiles(
  local: Partial<Profile> | null | undefined,
  remote: Partial<Profile> | null | undefined,
  localAt: Stamp,
  remoteAt: Stamp,
): Profile {
  const a = local ?? {};
  const b = remote ?? {};
  const remoteIsNewer = newer(remoteAt, localAt);
  const historyClearedAt = latestIso(a.historyClearedAt, b.historyClearedAt);

  /*
    Every attempt from both devices, newest first. Sorting matters beyond
    tidiness: the dashboard and the study plan both read this list positionally,
    so arrival order would show a learner a band they got months ago.
  */
  const results = unionResults(
    asArray<ModuleResult>(a.results),
    asArray<ModuleResult>(b.results),
  )
    .filter((result) => !historyClearedAt || result.date > historyClearedAt)
    .sort(byDate);

  const mockReports = unionBy(
    asArray<MockExamReport>(a.mockReports),
    asArray<MockExamReport>(b.mockReports),
    (report) => report.id,
  )
    .filter((report) => !historyClearedAt || report.completedAt > historyClearedAt)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, 30);

  const genTests = unionBy(
    asArray<GeneratedTest>(a.genTests),
    asArray<GeneratedTest>(b.genTests),
    (t) => String((t as { id?: unknown }).id ?? JSON.stringify(t)),
  );

  /*
    A single value cannot be merged, so the newer snapshot wins — but only if
    it actually holds one. A device that has never sat the placement test must
    not erase the result from a device that has, merely by having synced more
    recently.
  */
  const placement = remoteIsNewer ? (b.placement ?? a.placement) : (a.placement ?? b.placement);
  const targetBand = remoteIsNewer
    ? (b.targetBand ?? a.targetBand)
    : (a.targetBand ?? b.targetBand);
  /*
    Same rule for the plan's length, and it needs it: a learner who has never
    opened the plan page on this device has no length stored, and absent must
    not be allowed to mean "four weeks" here. It would overwrite the five days
    the learner chose on their phone the evening before the exam.
  */
  const planDays = remoteIsNewer ? (b.planDays ?? a.planDays) : (a.planDays ?? b.planDays);

  const localHistory = asArray<string[]>(a.placementHistory);
  const remoteHistory = asArray<string[]>(b.placementHistory);
  const placementHistory = remoteIsNewer
    ? remoteHistory.length > 0
      ? remoteHistory
      : localHistory
    : localHistory.length > 0
      ? localHistory
      : remoteHistory;

  /* Opened on either device means opened. Nothing here is ever un-set. */
  const visited = [...new Set([...asArray<string>(a.visited), ...asArray<string>(b.visited)])];

  return {
    placement,
    targetBand,
    planDays,
    placementHistory,
    visited,
    results,
    mockReports,
    historyClearedAt,
    genTests,
  };
}

export interface DrillScore {
  correct: number;
  total: number;
  at: string;
}

/**
 * Combines drill scores, keeping the later attempt for each drill.
 *
 * Later rather than better, deliberately. On one device a fresh attempt
 * already replaces the previous score, so keeping the best across devices
 * would make syncing behave differently from not syncing — and a learner who
 * saw a score they had just beaten downwards get restored would rightly
 * consider it a bug.
 */
export function mergeDrillScores(
  local: Record<string, DrillScore> | null | undefined,
  remote: Record<string, DrillScore> | null | undefined,
): Record<string, DrillScore> {
  const out: Record<string, DrillScore> = { ...(local ?? {}) };
  for (const [key, score] of Object.entries(remote ?? {})) {
    const mine = out[key];
    if (!mine || String(score?.at ?? "") > String(mine.at ?? "")) out[key] = score;
  }
  return out;
}

/**
 * Combines saved words.
 *
 * A word means the same thing on both devices, so which definition survives a
 * collision does not matter; that nothing is dropped does. The cap matches
 * lib/lookups.ts, and the newest entries are the ones kept when two devices
 * together hold more than the limit.
 */
export function mergeLookups<T>(
  local: Record<string, T> | null | undefined,
  remote: Record<string, T> | null | undefined,
  limit = 300,
): Record<string, T> {
  const merged: Record<string, T> = { ...(remote ?? {}), ...(local ?? {}) };
  const keys = Object.keys(merged);
  if (keys.length <= limit) return merged;

  const trimmed: Record<string, T> = {};
  for (const key of keys.slice(keys.length - limit)) trimmed[key] = merged[key];
  return trimmed;
}
