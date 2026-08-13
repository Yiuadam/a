import type { StudentHistoryAttempt } from "./types";

export const ORGANIZATION_BAND_SKILLS = [
  "listening",
  "reading",
  "writing",
  "speaking",
] as const;

export type OrganizationBandSkill = (typeof ORGANIZATION_BAND_SKILLS)[number];

export interface OrganizationBandPoint {
  attemptId: string;
  band: number;
  submittedAt: string;
  timestamp: number;
}

export function organizationAttemptsForSkill(
  attempts: readonly StudentHistoryAttempt[],
  skill: OrganizationBandSkill | null,
): StudentHistoryAttempt[] {
  if (skill === null) return [...attempts];
  return attempts.filter((attempt) => attempt.skill === skill);
}

export function organizationBandSeries(
  attempts: readonly StudentHistoryAttempt[],
): Record<OrganizationBandSkill, OrganizationBandPoint[]> {
  const series: Record<OrganizationBandSkill, OrganizationBandPoint[]> = {
    listening: [],
    reading: [],
    writing: [],
    speaking: [],
  };

  for (const attempt of attempts) {
    if (!ORGANIZATION_BAND_SKILLS.includes(attempt.skill as OrganizationBandSkill)) continue;
    if (typeof attempt.band !== "number" || !Number.isFinite(attempt.band) || attempt.band < 0 || attempt.band > 9) continue;
    const timestamp = Date.parse(attempt.submittedAt);
    if (!Number.isFinite(timestamp)) continue;
    series[attempt.skill as OrganizationBandSkill].push({
      attemptId: attempt.id,
      band: attempt.band,
      submittedAt: attempt.submittedAt,
      timestamp,
    });
  }

  for (const skill of ORGANIZATION_BAND_SKILLS) {
    series[skill].sort((left, right) => left.timestamp - right.timestamp || left.attemptId.localeCompare(right.attemptId));
  }

  return series;
}
