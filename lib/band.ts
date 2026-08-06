import type {
  CEFRLevel,
  PlacementQuestion,
  PlacementResult,
  PlacementSkill,
  TestQuestion,
} from "./types";

const LEVEL_WEIGHT: Record<CEFRLevel, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
};

export const LEVELS: CEFRLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
export const SKILLS: PlacementSkill[] = ["grammar", "vocabulary", "reading"];

export function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Score the placement test: harder questions carry more weight, and the
 * weighted proportion is mapped onto the 1-9 IELTS band scale.
 */
export function scorePlacement(
  questions: PlacementQuestion[],
  answers: Record<string, number | undefined>,
): PlacementResult {
  let earned = 0;
  let max = 0;
  const bySkill = {} as PlacementResult["bySkill"];
  const byLevel = {} as PlacementResult["byLevel"];
  for (const skill of SKILLS) bySkill[skill] = { correct: 0, total: 0 };
  for (const level of LEVELS) byLevel[level] = { correct: 0, total: 0 };

  for (const q of questions) {
    const w = LEVEL_WEIGHT[q.level];
    max += w;
    bySkill[q.skill].total += 1;
    byLevel[q.level].total += 1;
    if (answers[q.id] === q.answer) {
      earned += w;
      bySkill[q.skill].correct += 1;
      byLevel[q.level].correct += 1;
    }
  }

  const ratio = max > 0 ? earned / max : 0;
  // Map weighted ratio onto bands 1-9. A learner who only gets the A1/A2
  // items lands around band 3; a near-perfect run lands at 8.5-9.
  const band = Math.max(1, Math.min(9, roundToHalf(1.5 + ratio * 7.5)));

  return {
    band,
    date: new Date().toISOString(),
    bySkill,
    byLevel,
  };
}

/**
 * Approximate IELTS band from a raw score on a short section, scaled to the
 * official 40-question conversion tables.
 */
export function rawToBand(
  correct: number,
  total: number,
  module: "reading" | "listening",
): number {
  const scaled = total > 0 ? (correct / total) * 40 : 0;
  // Approximation of the public Academic Reading / Listening conversions.
  const table: Array<[number, number]> =
    module === "listening"
      ? [
          [39, 9], [37, 8.5], [35, 8], [32, 7.5], [30, 7], [26, 6.5], [23, 6],
          [18, 5.5], [16, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5],
        ]
      : [
          [39, 9], [37, 8.5], [35, 8], [33, 7.5], [30, 7], [27, 6.5], [23, 6],
          [19, 5.5], [15, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5],
        ];
  for (const [minRaw, band] of table) {
    if (scaled >= minRaw) return band;
  }
  return 2;
}

/** Normalise a free-text completion answer for comparison. */
function normalise(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, "")
    .replace(/\s+/g, " ");
}

export function isCorrect(
  q: TestQuestion,
  given: string | number | undefined,
): boolean {
  if (given === undefined || given === null || given === "") return false;
  if (q.type === "mcq") return Number(given) === q.answer;
  if (q.type === "tfng") return String(given) === q.answer;
  return normalise(String(given)) === normalise(q.answer);
}

export function bandLabel(band: number): string {
  if (band >= 8.5) return "Expert user";
  if (band >= 7.5) return "Very good user";
  if (band >= 6.5) return "Good user";
  if (band >= 5.5) return "Competent user";
  if (band >= 4.5) return "Modest user";
  if (band >= 3.5) return "Limited user";
  return "Extremely limited user";
}

export function cefrEstimate(band: number): string {
  if (band >= 8.5) return "C2";
  if (band >= 7) return "C1";
  if (band >= 5.5) return "B2";
  if (band >= 4) return "B1";
  if (band >= 3) return "A2";
  return "A1";
}

/**
 * Coerce a band coming from the AI examiner onto the valid IELTS scale.
 * Structured output guarantees a number, not a *sensible* number.
 */
export function clampBand(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.max(1, Math.min(9, roundToHalf(n)));
}
