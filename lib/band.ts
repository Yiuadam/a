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

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
  seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70",
  eighty: "80", ninety: "90", hundred: "100",
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
  seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11",
  twelfth: "12", thirteenth: "13", fourteenth: "14", fifteenth: "15",
  sixteenth: "16", seventeenth: "17", eighteenth: "18", nineteenth: "19",
  twentieth: "20", thirtieth: "30",
};

/**
 * Normalise a free-text answer for comparison.
 *
 * The exam accepts a number written either way, so "sixty-two" and "62" must
 * both be marked right. Compound forms ("twenty-five", "a hundred and
 * twenty-five") are added together rather than concatenated.
 */
function normalise(s: string): string {
  const base = s
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"£$€%]/g, "")
    .replace(/[-–—]/g, " ")
    // "6.30pm" and "6.30 pm" are the same answer to a candidate.
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = base.split(" ").filter((t) => t !== "a");
  const out: string[] = [];
  let running: number | null = null;

  const flush = () => {
    if (running !== null) out.push(String(running));
    running = null;
  };

  for (const token of tokens) {
    // "and" joins only within a number ("a hundred and twenty-five"); between
    // two separate numbers ("one and five per cent") it must not merge them.
    if (token === "and") {
      if (running === null || running % 100 !== 0) flush();
      continue;
    }
    const digits = NUMBER_WORDS[token];
    if (digits === undefined) {
      flush();
      out.push(token);
      continue;
    }
    const value = Number(digits);
    if (running !== null && value === 100 && running < 100) running *= 100;
    else if (running !== null && running >= 20 && running % 10 === 0 && value < 10) {
      running += value;
    } else if (running !== null && running % 100 === 0 && value < 100) running += value;
    else {
      flush();
      running = value;
    }
  }
  flush();
  return out.join(" ");
}

/**
 * Mark one answer.
 *
 * A `switch` with a `never` default rather than a chain of `if`s ending in a
 * fallthrough. The fallthrough was the dangerous shape: any question type
 * added later would compile, and be marked by string comparison through the
 * number-word normaliser, whether or not that made sense for it. Now the
 * compiler refuses the type until someone decides how it is marked.
 */
export function isCorrect(
  q: TestQuestion,
  given: string | number | undefined,
): boolean {
  if (given === undefined || given === null || given === "") return false;
  switch (q.type) {
    case "mcq":
      return Number(given) === q.answer;
    case "tfng":
      return String(given) === q.answer;
    case "completion":
      return normalise(String(given)) === normalise(q.answer);
    default: {
      // Exhaustiveness: a new member of TestQuestion fails to compile here.
      const unmarked: never = q;
      // An unmarkable answer is never silently counted as correct.
      void unmarked;
      return false;
    }
  }
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
