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
  };
  return mergeProfiles(
    protectedIncoming as Partial<Profile>,
    previous as Partial<Profile>,
    incomingAt,
    storedAt,
  );
}

/** Replace only the protected archive fields in a tab's newer working copy. */
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
    historyClearedAt: protectedProfile.historyClearedAt as Profile["historyClearedAt"],
  };
}
