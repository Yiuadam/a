import { mergeDrillScores, mergeLookups, mergeProfiles } from "./merge";
import { preserveOrganizationStudentHistory } from "@/lib/organizations/history-policy";

export interface ProgressSnapshotExpectation {
  storeKey: string;
  exists: boolean;
  payload: unknown;
  clientUpdatedAt: string | null;
}

export interface ProgressSnapshotMutation {
  storeKey: string;
  payload: unknown;
}

/**
 * The drill and saved-word clear tombstones, as epochs, from a merged profile.
 *
 * Those two records sync as their own rows but their tombstones live on the
 * profile (see the doc comments on Profile in lib/types.ts), so the route has
 * to read them off one key and apply them to two others. It must read them
 * off the *merged* profile rather than the submitted one: a restricted
 * organisation student's submitted tombstones are discarded by
 * preserveOrganizationStudentHistory, and honouring them here anyway would
 * empty by the back door exactly what that function just refused to clear.
 */
export function progressClearTombstones(
  mergedProfile: unknown,
): { drillsClearedAt: number | null; lookupsClearedAt: number | null } {
  const profile = (mergedProfile ?? {}) as {
    drillsClearedAt?: unknown;
    lookupsClearedAt?: unknown;
  };
  const epoch = (value: unknown): number | null => {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    drillsClearedAt: epoch(profile.drillsClearedAt),
    lookupsClearedAt: epoch(profile.lookupsClearedAt),
  };
}

/**
 * Merge one browser snapshot into the latest authoritative server snapshot.
 *
 * The browser still performs its first merge so it can include local storage,
 * but that read can become stale before its PUT arrives. Repeating the merge
 * here is what makes two simultaneous devices additive rather than
 * last-writer-wins.
 *
 * `tombstones` is what stops that second merge undoing a clear. The browser
 * submits an emptied drills or lookups payload; without the tombstone this
 * function would dutifully union it with the account's stored copy and hand
 * every cleared score straight back — the account doing locally what the
 * tombstones already stop another device doing. It is optional only so a
 * caller merging a single non-profile key on its own does not have to invent
 * one; every caller that has the profile in hand should pass it.
 */
export function mergeProgressSnapshotPayload(
  storeKey: string,
  submitted: unknown,
  stored: unknown,
  submittedAt: number,
  storedAt: number | null,
  historyRestricted: boolean,
  tombstones: { drillsClearedAt: number | null; lookupsClearedAt: number | null } = {
    drillsClearedAt: null,
    lookupsClearedAt: null,
  },
): unknown {
  if (storeKey === "ielts-prep-v1") {
    return historyRestricted
      ? preserveOrganizationStudentHistory(submitted, stored, submittedAt, storedAt)
      : mergeProfiles(
          submitted as Parameters<typeof mergeProfiles>[0],
          stored as Parameters<typeof mergeProfiles>[1],
          submittedAt,
          storedAt,
        );
  }
  if (storeKey === "bandup.drills.v1") {
    return mergeDrillScores(
      submitted as Parameters<typeof mergeDrillScores>[0],
      stored as Parameters<typeof mergeDrillScores>[1],
      tombstones.drillsClearedAt,
    );
  }
  if (storeKey === "bandup.lookups.v1") {
    return mergeLookups(
      submitted as Parameters<typeof mergeLookups>[0],
      stored as Parameters<typeof mergeLookups>[1],
      300,
      tombstones.lookupsClearedAt,
    );
  }
  return submitted;
}
