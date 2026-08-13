"use client";

import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { mergeProfiles, mergeDrillScores, mergeLookups } from "./merge";
import {
  learnerItemUpdatedAt,
  readLearnerItem,
  writeLearnerItem,
} from "./storage";
import { restoreAcceptedOrganizationHistory } from "@/lib/organizations/history-policy";

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

export type ClearSyncedProgressOutcome = SyncOutcome | { status: "restricted" };

interface SyncOptions {
  /*
    A device wipe must not destroy the browser copy before the account has
    accepted its history tombstone. Supplying this timestamp makes the sync
    operate on a hypothetical cleared profile; the ordinary working copy is
    only replaced in step 4, after a successful PUT.
  */
  clearHistoryAt?: string;
}

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

function writeLocal(key: StoreKey, value: unknown, clientUpdatedAt: string | null): void {
  try {
    writeLearnerItem(key, JSON.stringify(value), { clientUpdatedAt });
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

function stampNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function newestStamp(left: string | null, right: string | null): string | null {
  const leftTime = stampNumber(left);
  const rightTime = stampNumber(right);
  if (leftTime === null) return rightTime === null ? null : right;
  if (rightTime === null) return left;
  return rightTime > leftTime ? right : left;
}

/**
 * Merges this browser's progress with the account's, in both directions.
 *
 * Safe to call more than once, and safe to call on a device with nothing on
 * it: merging an empty browser with a full account yields the full account,
 * and merging a full browser with an empty account yields the browser.
 */
async function syncProgressWithOptions(
  options: SyncOptions = {},
): Promise<ClearSyncedProgressOutcome> {
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
  const storedLocalProfile = readLocal("ielts-prep-v1");
  const localProfile = options.clearHistoryAt
    ? {
        ...(storedLocalProfile && typeof storedLocalProfile === "object"
          && !Array.isArray(storedLocalProfile)
          ? storedLocalProfile
          : {}),
        results: [],
        mockReports: [],
        historyClearedAt: options.clearHistoryAt,
      }
    : storedLocalProfile;
  const localPayload: Record<StoreKey, unknown> = {
    "ielts-prep-v1": localProfile,
    "bandup.drills.v1": readLocal("bandup.drills.v1"),
    "bandup.lookups.v1": readLocal("bandup.lookups.v1"),
  };
  const localStamps: Record<StoreKey, string | null> = {
    "ielts-prep-v1": options.clearHistoryAt
      ?? learnerItemUpdatedAt("ielts-prep-v1"),
    "bandup.drills.v1": learnerItemUpdatedAt("bandup.drills.v1"),
    "bandup.lookups.v1": learnerItemUpdatedAt("bandup.lookups.v1"),
  };

  const profile = mergeProfiles(
    localPayload["ielts-prep-v1"] as never,
    bySnapshotKey.get("ielts-prep-v1")?.payload as never,
    stampNumber(localStamps["ielts-prep-v1"]),
    stampOf(bySnapshotKey.get("ielts-prep-v1")),
  );
  const drills = mergeDrillScores(
    localPayload["bandup.drills.v1"] as never,
    bySnapshotKey.get("bandup.drills.v1")?.payload as never,
  );
  const lookups = mergeLookups(
    localPayload["bandup.lookups.v1"] as never,
    bySnapshotKey.get("bandup.lookups.v1")?.payload as never,
  );

  const merged: Record<StoreKey, unknown> = {
    "ielts-prep-v1": profile,
    "bandup.drills.v1": drills,
    "bandup.lookups.v1": lookups,
  };
  const mergedStamps: Record<StoreKey, string | null> = {
    "ielts-prep-v1": newestStamp(
      localStamps["ielts-prep-v1"],
      bySnapshotKey.get("ielts-prep-v1")?.clientUpdatedAt ?? null,
    ),
    "bandup.drills.v1": newestStamp(
      localStamps["bandup.drills.v1"],
      bySnapshotKey.get("bandup.drills.v1")?.clientUpdatedAt ?? null,
    ),
    "bandup.lookups.v1": newestStamp(
      localStamps["bandup.lookups.v1"],
      bySnapshotKey.get("bandup.lookups.v1")?.clientUpdatedAt ?? null,
    ),
  };

  // --- 3. write it to the account ------------------------------------------
  let at: string;
  const accepted: Record<StoreKey, Snapshot> = Object.fromEntries(
    KEYS.map((storeKey) => [storeKey, {
      storeKey,
      payload: merged[storeKey],
      clientUpdatedAt: mergedStamps[storeKey],
    }]),
  ) as Record<StoreKey, Snapshot>;
  let historyProtected = false;
  try {
    const res = await authedFetch(apiUrl("/api/account/progress"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshots: KEYS.map((storeKey) => ({
          storeKey,
          payload: merged[storeKey],
          clientUpdatedAt: mergedStamps[storeKey],
        })),
      }),
    });
    if (res.status === 401) return { status: "signed-out" };
    if (!res.ok) return { status: "unavailable" };
    const response = (await res.json()) as {
      at?: string;
      snapshots?: { storeKey?: unknown; payload?: unknown; clientUpdatedAt?: unknown }[];
      historyProtected?: unknown;
    };
    at = response.at ?? new Date().toISOString();
    historyProtected = response.historyProtected === true;
    if (Array.isArray(response.snapshots)) {
      const serverAccepted = new Map<StoreKey, Snapshot>(
        response.snapshots.flatMap((snapshot) =>
          typeof snapshot.storeKey === "string" && KEYS.includes(snapshot.storeKey as StoreKey)
            ? [[snapshot.storeKey as StoreKey, {
                storeKey: snapshot.storeKey,
                payload: snapshot.payload,
                clientUpdatedAt: typeof snapshot.clientUpdatedAt === "string"
                  ? snapshot.clientUpdatedAt
                  : at,
              }] as const]
            : [],
        ),
      );
      for (const key of KEYS) {
        accepted[key] = serverAccepted.get(key) ?? {
          storeKey: key,
          payload: merged[key],
          clientUpdatedAt: at,
        };
      }
    }
  } catch {
    return { status: "unavailable" };
  }

  /*
    Membership can change between rendering the clear control and submitting
    it. The server is authoritative. If it protected organisation-linked
    history, leave the browser untouched too instead of presenting a clear
    that the next sync would immediately undo.
  */
  if (options.clearHistoryAt && historyProtected) {
    return { status: "restricted" };
  }

  // --- 4. and only then to this browser ------------------------------------
  /*
    Last on purpose. Everything above can fail without the learner losing
    anything, because until this line runs the browser still holds exactly what
    it held before. Writing here first would mean a failed upload had already
    rewritten local state with a merge nobody had accepted.
  */
  /*
    A learner can finish or delete something while the GET/PUT above is in
    flight. Writing the earlier merge verbatim here would roll that newer
    action back in this tab before autosync gets its promised second pass.

    Merge once more with the *current* working copy before touching storage.
    The next scheduled pass uploads these late changes; this pass merely makes
    sure downloading the account can never undo them locally.
  */
  const latest: Record<StoreKey, unknown> = {
    "ielts-prep-v1": mergeProfiles(
      (historyProtected
        ? restoreAcceptedOrganizationHistory(
            readLocal("ielts-prep-v1"),
            accepted["ielts-prep-v1"].payload,
          )
        : readLocal("ielts-prep-v1")) as never,
      accepted["ielts-prep-v1"].payload as never,
      stampNumber(learnerItemUpdatedAt("ielts-prep-v1")),
      stampOf(accepted["ielts-prep-v1"]),
    ),
    "bandup.drills.v1": mergeDrillScores(
      readLocal("bandup.drills.v1") as never,
      accepted["bandup.drills.v1"].payload as never,
    ),
    "bandup.lookups.v1": mergeLookups(
      readLocal("bandup.lookups.v1") as never,
      accepted["bandup.lookups.v1"].payload as never,
    ),
  };
  for (const key of KEYS) {
    writeLocal(
      key,
      latest[key],
      newestStamp(learnerItemUpdatedAt(key), accepted[key].clientUpdatedAt),
    );
  }
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

export async function syncProgress(): Promise<SyncOutcome> {
  const outcome = await syncProgressWithOptions();
  // `restricted` is only produced when clearHistoryAt is supplied. Keep the
  // public autosync result narrow, with a defensive fallback if that invariant
  // is ever changed.
  return outcome.status === "restricted" ? { status: "unavailable" } : outcome;
}

/**
 * Permanently clear sitting history from a signed-in account without first
 * mutating this browser's working copy.
 *
 * If the request fails, local practice remains available. If the server
 * accepted the tombstone but its response was lost, a later ordinary sync
 * will observe that durable tombstone and converge on the cleared state.
 */
export async function clearSyncedProgress(
  at = new Date().toISOString(),
): Promise<ClearSyncedProgressOutcome> {
  return syncProgressWithOptions({ clearHistoryAt: at });
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
