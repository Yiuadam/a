"use client";

import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { mergeProfiles, mergeDrillScores, mergeLookups } from "./merge";
import { readLearnerItem, writeLearnerItem } from "./storage";

/*
  Carrying a learner's progress between their devices.

  The order of operations here is the whole safety argument, so it is written
  out rather than left to be inferred:

    1. Read the account.               Never write first.
    2. Merge it with what is local.    lib/progress/merge.ts, pure and tested.
    3. Write the merged result back.
    4. Write the merged result local.  Last, and only if 3 succeeded.

  Step 1 before step 3 is what makes the second device safe. A client that
  wrote its own state first would replace the other device's work with its own
  and there would be nothing left to merge with.

  Step 4 last is what makes failure safe. The tab's working copy is never
  cleared or narrowed before the account accepts the merge; if any of this
  fails, the browser still holds everything it held before, and the learner
  has lost nothing. That is ACCOUNTS.md threat 5, and it is the reason this
  file returns a result instead of throwing.
*/

/** The keys that sync. Mirrors the CHECK constraint in the schema. */
const KEYS = ["ielts-prep-v1", "bandup.drills.v1", "bandup.lookups.v1"] as const;
type StoreKey = (typeof KEYS)[number];

/** Where the last successful sync is remembered, so it can be shown. */
const SYNCED_AT = "bandup.sync.v1";

export type SyncOutcome =
  | { status: "done"; at: string }
  | { status: "signed-out" }
  | { status: "unavailable" };

function readLocal(key: StoreKey): unknown {
  try {
    /*
      Learner work lives in sessionStorage, behind this helper. Reading
      localStorage directly here meant autosync always uploaded an empty
      profile after the storage privacy change, so `visited` never reached the
      account and every new browser showed the "New" badges again.

      The helper also performs the one-time migration from old localStorage
      builds, so sync and the UI now read the exact same working copy.
    */
    const raw = readLearnerItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Unreadable local data is treated as absent rather than as a reason to
    // stop. The account's copy is then the better of the two, which is exactly
    // the case sync exists to rescue.
    return null;
  }
}

function writeLocal(key: StoreKey, value: unknown): void {
  try {
    writeLearnerItem(key, JSON.stringify(value));
  } catch {
    // Storage full, or private mode. The account holds the merged copy, so the
    // work is safe even though this tab will not show it until it can write.
  }
}

interface Snapshot {
  storeKey: string;
  payload: unknown;
  clientUpdatedAt: string | null;
}

function stampOf(snapshot: Snapshot | undefined): number | null {
  if (!snapshot?.clientUpdatedAt) return null;
  const t = Date.parse(snapshot.clientUpdatedAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * Merges this browser's progress with the account's, in both directions.
 *
 * Safe to call more than once, and safe to call on a device with nothing on
 * it: merging an empty browser with a full account yields the full account,
 * and merging a full browser with an empty account yields the browser.
 */
export async function syncProgress(): Promise<SyncOutcome> {
  if (typeof window === "undefined") return { status: "unavailable" };

  // --- 1. read the account -------------------------------------------------
  let remote: Snapshot[];
  try {
    const res = await authedFetch(apiUrl("/api/account/progress"));
    if (res.status === 401) return { status: "signed-out" };
    if (!res.ok) return { status: "unavailable" };
    const body = (await res.json()) as { snapshots?: Snapshot[] };
    remote = Array.isArray(body.snapshots) ? body.snapshots : [];
  } catch {
    return { status: "unavailable" };
  }

  const bySnapshotKey = new Map(remote.map((s) => [s.storeKey, s]));

  // --- 2. merge ------------------------------------------------------------
  /*
    The local stamp is "now", because whatever is in this browser is by
    definition its current state. That makes the account's copy win a
    single-value tie only when the account was written more recently than this
    page loaded, which is the behaviour a learner expects: the device they
    used last is the one that is right.
  */
  const localAt = Date.now();

  const profile = mergeProfiles(
    readLocal("ielts-prep-v1") as never,
    bySnapshotKey.get("ielts-prep-v1")?.payload as never,
    localAt,
    stampOf(bySnapshotKey.get("ielts-prep-v1")),
  );
  const drills = mergeDrillScores(
    readLocal("bandup.drills.v1") as never,
    bySnapshotKey.get("bandup.drills.v1")?.payload as never,
  );
  const lookups = mergeLookups(
    readLocal("bandup.lookups.v1") as never,
    bySnapshotKey.get("bandup.lookups.v1")?.payload as never,
  );

  const merged: Record<StoreKey, unknown> = {
    "ielts-prep-v1": profile,
    "bandup.drills.v1": drills,
    "bandup.lookups.v1": lookups,
  };

  // --- 3. write it to the account ------------------------------------------
  let at: string;
  try {
    const res = await authedFetch(apiUrl("/api/account/progress"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshots: KEYS.map((storeKey) => ({ storeKey, payload: merged[storeKey] })),
      }),
    });
    if (res.status === 401) return { status: "signed-out" };
    if (!res.ok) return { status: "unavailable" };
    at = ((await res.json()) as { at?: string }).at ?? new Date().toISOString();
  } catch {
    return { status: "unavailable" };
  }

  // --- 4. and only then to this browser ------------------------------------
  /*
    Last on purpose. Everything above can fail without the learner losing
    anything, because until this line runs the browser still holds exactly what
    it held before. Writing here first would mean a failed upload had already
    rewritten local state with a merge nobody had accepted.
  */
  for (const key of KEYS) writeLocal(key, merged[key]);
  try {
    // This timestamp is a device preference/status line, not learner work, so
    // it deliberately remains durable across tabs.
    window.localStorage.setItem(SYNCED_AT, at);
  } catch {
    // Cosmetic only — it drives the "last synced" line on the account page.
  }

  /*
    The stores are read through useSyncExternalStore and cache their snapshots,
    so a write that goes around them is invisible until something tells them to
    look again. `storage` normally only fires in *other* tabs; dispatching it
    here makes this tab re-read too, which is what repaints the plan and the
    saved words without a reload.
  */
  for (const key of KEYS) {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }

  return { status: "done", at };
}

/** When this browser last completed a sync, or null. */
export function lastSyncedAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SYNCED_AT);
  } catch {
    return null;
  }
}
