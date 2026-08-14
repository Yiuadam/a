import type { ProgressSnapshot } from "@/lib/auth/supabase";

export interface AdminProgressFields {
  placement: Record<string, unknown> | null;
  results: unknown[];
  mockReports: unknown[];
  drillScores: Record<string, unknown>;
  profileSyncedAt: string | null;
  drillsSyncedAt: string | null;
  progressAvailable: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function afterHistoryClear(
  entry: unknown,
  field: "date" | "completedAt",
  clearedAt: string | null,
): boolean {
  if (!clearedAt) return true;
  const value = record(entry)?.[field];
  return typeof value === "string" && value > clearedAt;
}

/**
 * Selects the owner-visible history from the same snapshot authority used by
 * learner sync. The deletion tombstone is applied here as defence in depth so
 * an older stored array cannot make a cleared sitting reappear in the console.
 *
 * `null` means "keep the RPC copy" while Supabase is authoritative, but means
 * "show unavailable" after Cloudflare cutover; silently falling back after a
 * cutover would present a stale replica as current data.
 */
export function adminProgressFromSnapshots(
  snapshots: ProgressSnapshot[] | null,
  unavailableIsAuthoritative: boolean,
): AdminProgressFields | null {
  if (snapshots === null) {
    return unavailableIsAuthoritative
      ? {
          placement: null,
          results: [],
          mockReports: [],
          drillScores: {},
          profileSyncedAt: null,
          drillsSyncedAt: null,
          progressAvailable: false,
        }
      : null;
  }

  const profileSnapshot = snapshots.find((item) => item.storeKey === "ielts-prep-v1");
  const drillsSnapshot = snapshots.find((item) => item.storeKey === "bandup.drills.v1");
  const profile = record(profileSnapshot?.payload) ?? {};
  const clearedAt = typeof profile.historyClearedAt === "string" ? profile.historyClearedAt : null;

  return {
    placement: record(profile.placement),
    results: Array.isArray(profile.results)
      ? profile.results.filter((entry) => afterHistoryClear(entry, "date", clearedAt))
      : [],
    mockReports: Array.isArray(profile.mockReports)
      ? profile.mockReports.filter((entry) => afterHistoryClear(entry, "completedAt", clearedAt))
      : [],
    drillScores: record(drillsSnapshot?.payload) ?? {},
    profileSyncedAt: profileSnapshot?.clientUpdatedAt ?? null,
    drillsSyncedAt: drillsSnapshot?.clientUpdatedAt ?? null,
    progressAvailable: true,
  };
}
