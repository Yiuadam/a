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

function deletionMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, deletedAt] of Object.entries(value)) {
    const valid = validIso(deletedAt);
    if (id && valid) out[id] = valid;
  }
  return out;
}

/*
  A profile can be rewritten for many reasons after its placement test: a
  learner may change their target band, open a new module, or choose a new
  plan length. The profile snapshot stamp therefore says nothing reliable about
  which placement result is newer. Compare the dated result itself instead.

  Old snapshots can lack a date. A valid dated result beats an undated one;
  when neither side supplies a valid date, keep the local value deterministically
  rather than treating an unrelated profile rewrite as a new placement.
*/
function placementStamp(placement: Profile["placement"] | null | undefined): number | null {
  const date = validIso(placement?.date);
  return date ? Date.parse(date) : null;
}

/**
 * Whether a placement survives a placement-clear tombstone: present, and
 * (while a clear is in effect) dated strictly after it. An undated placement
 * cannot prove it was earned after the clear, so a clear in effect treats it
 * the same as one from before it. With no clear in effect this is simply
 * "is there a placement here at all", so it changes nothing about the
 * ordinary cross-device case below.
 */
function survivesPlacementClear(
  placement: Profile["placement"] | null | undefined,
  clearedAt: number | null,
): boolean {
  if (placement == null) return false;
  if (clearedAt === null) return true;
  const stamp = placementStamp(placement);
  return stamp !== null && stamp > clearedAt;
}

/**
 * Whether a dated item — a drill score, a saved word — survives a clear
 * tombstone: no tombstone in effect, or a valid date strictly after it. The
 * same reasoning as survivesPlacementClear above applies to an undated item:
 * it cannot prove it was created after the clear, so while a clear is in
 * effect it is treated the same as one from before it. Unlike
 * survivesPlacementClear this does not itself judge absence — it is only
 * ever asked about an item a caller already has in hand, so there is nothing
 * here that needs a `== null` case of its own.
 */
function survivesClear(at: unknown, clearedAt: number | null): boolean {
  if (clearedAt === null) return true;
  const iso = validIso(at);
  return iso !== undefined && Date.parse(iso) > clearedAt;
}

function mergePlacement(
  local: Profile["placement"] | null | undefined,
  remote: Profile["placement"] | null | undefined,
  clearedAt: number | null,
): Profile["placement"] | undefined {
  const localOk = survivesPlacementClear(local, clearedAt) ? local : null;
  const remoteOk = survivesPlacementClear(remote, clearedAt) ? remote : null;
  if (localOk == null) return remoteOk ?? undefined;
  if (remoteOk == null) return localOk;

  const localStamp = placementStamp(localOk);
  const remoteStamp = placementStamp(remoteOk);
  if (localStamp === null) return remoteStamp === null ? localOk : remoteOk;
  if (remoteStamp === null) return localOk;
  return remoteStamp > localStamp ? remoteOk : localOk;
}

/**
 * Combines two profiles without discarding anything countable.
 *
 * Lists are unioned. Most single values — the target band, for example —
 * cannot be unioned, so they are taken from whichever profile snapshot is
 * newer. A placement is different: its own completion date is the timestamp
 * for that result, and it must not be displaced by an unrelated later profile
 * write such as changing the target band.
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
  const placementClearedAt = latestIso(a.placementClearedAt, b.placementClearedAt);
  /*
    drillsClearedAt and lookupsClearedAt live on this profile even though the
    scores and words they govern do not (see the doc comments on lib/types.ts's
    Profile) — this is the one document both devices always merge, so it is
    where the two tombstones can be found and combined the same way
    historyClearedAt and placementClearedAt already are. Callers merging the
    other two synced documents — lib/progress/sync.ts and
    lib/progress/server-snapshots.ts — read the values back off the profile
    this function returns and hand them to mergeDrillScores/mergeLookups.
  */
  const drillsClearedAt = latestIso(a.drillsClearedAt, b.drillsClearedAt);
  const lookupsClearedAt = latestIso(a.lookupsClearedAt, b.lookupsClearedAt);

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

  const localDeletedGenTests = deletionMap(a.deletedGenTests);
  const remoteDeletedGenTests = deletionMap(b.deletedGenTests);
  const deletedGenTests: Record<string, string> = { ...localDeletedGenTests };
  for (const [id, deletedAt] of Object.entries(remoteDeletedGenTests)) {
    if (!deletedGenTests[id] || deletedAt > deletedGenTests[id]) {
      deletedGenTests[id] = deletedAt;
    }
  }

  const genTests = unionBy(
    asArray<GeneratedTest>(a.genTests),
    asArray<GeneratedTest>(b.genTests),
    (t) => String(t?.test?.id ?? JSON.stringify(t)),
  ).filter((generated) => {
    const id = generated?.test?.id;
    if (typeof id !== "string" || !id) return false;
    const deletedAt = deletedGenTests[id];
    /* A generated paper created after an old tombstone is a deliberate newer
       action and survives. This also makes a repeated provider id recoverable. */
    return !deletedAt || generated.createdAt > deletedAt;
  });

  /*
    A placement is its own dated learner result. A device that has never sat
    the test cannot erase one that did, and a later target-band or plan change
    cannot hide a newer placement received from another browser.

    placementClearedAt is the one deliberate exception: a tombstone, independent
    of historyClearedAt, that both "Clear all history"
    (components/history/ClearHistoryButton.tsx) and "clear this device"
    (components/account/ClearDeviceSection.tsx) now set. They were originally
    split so history could go without placement; the owner has since asked
    that either control remove everything a learner owns, so both set every
    tombstone on this profile together and neither is narrower than the
    other any more. A placement dated at or before the tombstone is treated
    as cleared; one dated after it — a genuine re-sit, on any device — merges
    in exactly as before.
  */
  const placement = mergePlacement(
    a.placement,
    b.placement,
    placementClearedAt ? Date.parse(placementClearedAt) : null,
  );
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
    placementClearedAt,
    drillsClearedAt,
    lookupsClearedAt,
    deletedGenTests,
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
 *
 * `clearedAt` is the drill-clearing tombstone (Profile.drillsClearedAt,
 * mergeProfiles above) as an epoch, or null while none is in effect. A topic
 * is dropped once its chosen (later-wins) score fails to survive it — see
 * survivesClear — which is what stops a stale score on a device that missed
 * the clear from riding back in on its next sync.
 */
export function mergeDrillScores(
  local: Record<string, DrillScore> | null | undefined,
  remote: Record<string, DrillScore> | null | undefined,
  clearedAt: number | null = null,
): Record<string, DrillScore> {
  const out: Record<string, DrillScore> = { ...(local ?? {}) };
  for (const [key, score] of Object.entries(remote ?? {})) {
    const mine = out[key];
    if (!mine || String(score?.at ?? "") > String(mine.at ?? "")) out[key] = score;
  }
  if (clearedAt !== null) {
    for (const [key, score] of Object.entries(out)) {
      if (!survivesClear(score?.at, clearedAt)) delete out[key];
    }
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
function lookupRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lookupFavouriteUpdate(value: Record<string, unknown>): string | null {
  return validIso(value.favouriteUpdatedAt) ?? null;
}

/*
  Definitions retain the established local-first collision rule. Favourite
  state is a separate learner action: its explicit revision timestamp wins,
  including `false` after an unpin. This prevents an older browser from
  restoring a star simply because it happens to sync afterwards.
*/
function mergeLookupEntry<T>(local: T, remote: T): T {
  const localRecord = lookupRecord(local);
  const remoteRecord = lookupRecord(remote);
  if (!localRecord || !remoteRecord) return local;

  const merged: Record<string, unknown> = { ...remoteRecord, ...localRecord };
  const localUpdated = lookupFavouriteUpdate(localRecord);
  const remoteUpdated = lookupFavouriteUpdate(remoteRecord);
  const winner =
    localUpdated && remoteUpdated
      ? localUpdated >= remoteUpdated
        ? localRecord
        : remoteRecord
      : localUpdated
        ? localRecord
        : remoteUpdated
          ? remoteRecord
          : null;

  if (winner) {
    merged.favourite = winner.favourite === true;
    merged.favouriteUpdatedAt = winner.favouriteUpdatedAt;
  } else if (localRecord.favourite === true || remoteRecord.favourite === true) {
    // Legacy entries predate the timestamp field. Preserve a legacy star
    // until a modern pin/unpin gives it an unambiguous revision.
    merged.favourite = true;
  }
  return merged as T;
}

function lookupNewestAt(value: unknown): string {
  const record = lookupRecord(value);
  return record && typeof record.at === "string" ? record.at : "";
}

function lookupIsFavourite(value: unknown): boolean {
  return lookupRecord(value)?.favourite === true;
}

/**
 * `clearedAt` is the saved-word tombstone (Profile.lookupsClearedAt,
 * mergeProfiles above) as an epoch, or null while none is in effect. A word
 * is dropped once its merged entry fails to survive it — judged on `at`, the
 * word's own lookup date, deliberately not `favouriteUpdatedAt`: a clear
 * empties the learner's lookup history, and a pin recorded against a word
 * looked up before the clear is not a reason to keep the word, any more than
 * a re-attempted drill topic is kept for a score recorded before it.
 */
export function mergeLookups<T>(
  local: Record<string, T> | null | undefined,
  remote: Record<string, T> | null | undefined,
  limit = 300,
  clearedAt: number | null = null,
): Record<string, T> {
  const merged: Record<string, T> = { ...(remote ?? {}) };
  for (const [key, localEntry] of Object.entries(local ?? {})) {
    const remoteEntry = merged[key];
    merged[key] = remoteEntry === undefined
      ? localEntry
      : mergeLookupEntry(localEntry, remoteEntry);
  }

  if (clearedAt !== null) {
    for (const [key, value] of Object.entries(merged)) {
      if (!survivesClear(lookupRecord(value)?.at, clearedAt)) delete merged[key];
    }
  }

  const entries = Object.entries(merged);
  if (entries.length <= limit) return merged;

  const oldestFirst = (left: [string, T], right: [string, T]) =>
    lookupNewestAt(left[1]).localeCompare(lookupNewestAt(right[1]));
  const removable = entries.filter(([, value]) => !lookupIsFavourite(value)).sort(oldestFirst);
  const candidates = removable.length >= entries.length - limit
    ? removable
    : [...removable, ...entries.filter(([, value]) => lookupIsFavourite(value)).sort(oldestFirst)];
  const trimmed: Record<string, T> = { ...merged };
  for (const [key] of candidates.slice(0, entries.length - limit)) delete trimmed[key];
  return trimmed;
}
