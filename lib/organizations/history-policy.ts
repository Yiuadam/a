import { mergeProfiles } from "@/lib/progress/merge";
import type { Profile } from "@/lib/types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Preserve the server's complete sitting archive for an organization student.
 *
 * A modified client can bypass a hidden button and PUT an empty snapshot. For
 * restricted learners the API therefore unions the submitted profile with the
 * stored profile, while refusing a new history tombstone. Ordinary edits —
 * plans, generated-test cleanup, saved settings — still merge normally.
 */
export function preserveOrganizationStudentHistory(
  incoming: unknown,
  stored: unknown,
  incomingAt: number,
  storedAt: number | null,
): Profile {
  const next = record(incoming);
  const previous = record(stored);
  const protectedIncoming = {
    ...next,
    historyClearedAt: previous.historyClearedAt,
    /*
      The device-clear button that could submit a new placementClearedAt (and,
      alongside it, drillsClearedAt and lookupsClearedAt) is already hidden
      for a restricted student (useHistoryClearPolicy), so this matters only
      against a client bypassing it — but a bypass must not be able to erase
      placement, drill scores or saved words any more than it can erase
      results.
    */
    placementClearedAt: previous.placementClearedAt,
    drillsClearedAt: previous.drillsClearedAt,
    lookupsClearedAt: previous.lookupsClearedAt,
  };
  return mergeProfiles(
    protectedIncoming as Partial<Profile>,
    previous as Partial<Profile>,
    incomingAt,
    storedAt,
  );
}

/**
 * Replace only the protected archive fields in a tab's newer working copy.
 *
 * drillsClearedAt and lookupsClearedAt are included here for the same reason
 * placementClearedAt is: this profile is the one place all three tombstones
 * live (see lib/types.ts), so restoring the account's protected profile after
 * a restricted sync must restore its tombstones too, or a later merge on this
 * device would compare against ones that were never actually accepted.
 */
export function restoreAcceptedOrganizationHistory(
  current: unknown,
  accepted: unknown,
): Partial<Profile> {
  const next = record(current);
  const protectedProfile = record(accepted);
  return {
    ...next,
    results: protectedProfile.results as Profile["results"],
    mockReports: protectedProfile.mockReports as Profile["mockReports"],
    /* A retake is part of the sitting archive a restricted student may not
       empty, so it is restored alongside the reports it names rather than left
       to a tab's working copy that may have tried to drop it. */
    mockRetakes: protectedProfile.mockRetakes as Profile["mockRetakes"],
    historyClearedAt: protectedProfile.historyClearedAt as Profile["historyClearedAt"],
    placement: protectedProfile.placement as Profile["placement"],
    placementClearedAt: protectedProfile.placementClearedAt as Profile["placementClearedAt"],
    drillsClearedAt: protectedProfile.drillsClearedAt as Profile["drillsClearedAt"],
    lookupsClearedAt: protectedProfile.lookupsClearedAt as Profile["lookupsClearedAt"],
  };
}
