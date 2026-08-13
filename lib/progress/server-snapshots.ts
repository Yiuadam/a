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
 * Merge one browser snapshot into the latest authoritative server snapshot.
 *
 * The browser still performs its first merge so it can include local storage,
 * but that read can become stale before its PUT arrives. Repeating the merge
 * here is what makes two simultaneous devices additive rather than
 * last-writer-wins.
 */
export function mergeProgressSnapshotPayload(
  storeKey: string,
  submitted: unknown,
  stored: unknown,
  submittedAt: number,
  storedAt: number | null,
  historyRestricted: boolean,
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
    );
  }
  if (storeKey === "bandup.lookups.v1") {
    return mergeLookups(
      submitted as Parameters<typeof mergeLookups>[0],
      stored as Parameters<typeof mergeLookups>[1],
    );
  }
  return submitted;
}
