import { LEVELS, SKILLS, roundToHalf } from "./band";
import type { CEFRLevel, PlacementQuestion, PlacementResult } from "./types";

/** Fisher-Yates: a genuinely uniform shuffle, unlike sort(() => Math.random() - 0.5). */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How many questions one sitting asks. */
export const TEST_LENGTH = 15;

/*
  The test adapts as it goes, in the manner of a computer-adaptive exam.

  A fixed paper wastes most of its questions: a strong candidate breezes
  through the easy half and a weak one guesses at the hard half, and neither
  section says much about where they actually are. Instead the test tracks an
  ability estimate on the CEFR scale (1 = A1 … 6 = C2), asks a question at that
  level, and moves the estimate up on a correct answer and down on a wrong one.

  The step shrinks as the test proceeds. Early answers move the estimate a
  long way so the test reaches the right region quickly; later ones refine it.
  This converges far faster than a fixed ladder, which is why 15 adaptive
  questions locate a learner better than 18 fixed ones.
*/

const FIRST_STEP = 1.25;
const STEP_DECAY = 0.82;
const MIN_STEP = 0.28;

export interface AdaptiveState {
  /** Current ability estimate, 1 (A1) to 6 (C2). */
  ability: number;
  step: number;
  asked: PlacementQuestion[];
  answers: Record<string, number | undefined>;
}

export function startAdaptive(): AdaptiveState {
  return {
    // Begin at B1: the middle of the range, so the test converges from either side.
    ability: 3,
    step: FIRST_STEP,
    asked: [],
    answers: {},
  };
}

function levelOf(ability: number): CEFRLevel {
  const index = Math.min(LEVELS.length - 1, Math.max(0, Math.round(ability) - 1));
  return LEVELS[index];
}

/**
 * Choose the next question: one at the current ability level that the learner
 * has not met in this sitting or in their previous two.
 *
 * If that level is exhausted, the search widens outwards rather than repeating
 * a question — a slightly-off difficulty is a smaller problem than showing
 * someone a question they have just answered.
 */
export function nextQuestion(
  bank: PlacementQuestion[],
  state: AdaptiveState,
  recentlyUsed: string[] = [],
): PlacementQuestion | null {
  const excluded = new Set([...recentlyUsed, ...state.asked.map((q) => q.id)]);
  const target = LEVELS.indexOf(levelOf(state.ability));

  for (let distance = 0; distance < LEVELS.length; distance++) {
    for (const index of [target - distance, target + distance]) {
      if (index < 0 || index >= LEVELS.length) continue;
      const candidates = bank.filter((q) => q.level === LEVELS[index] && !excluded.has(q.id));
      if (candidates.length === 0) continue;

      // Prefer a skill this sitting has used least, so a test is never all grammar.
      const counts = new Map<string, number>();
      for (const q of state.asked) counts.set(q.skill, (counts.get(q.skill) ?? 0) + 1);
      const ranked = shuffle(candidates).sort(
        (a, b) => (counts.get(a.skill) ?? 0) - (counts.get(b.skill) ?? 0),
      );
      return ranked[0];
    }
  }
  return null;
}

/** Fold one answer into the estimate and return the updated state. */
export function recordAnswer(
  state: AdaptiveState,
  question: PlacementQuestion,
  choice: number | undefined,
): AdaptiveState {
  const correct = choice === question.answer;
  const ability = Math.min(6, Math.max(1, state.ability + (correct ? state.step : -state.step)));
  return {
    ability,
    step: Math.max(MIN_STEP, state.step * STEP_DECAY),
    asked: [...state.asked, question],
    answers: { ...state.answers, [question.id]: choice },
  };
}

/**
 * Convert the final ability estimate to an IELTS band.
 *
 * Ability runs 1 (A1) to 6 (C2); bands run 1 to 9. A learner who cannot hold
 * A1 lands near band 1.5, one performing consistently at C2 near band 9.
 */
export function abilityToBand(ability: number): number {
  return Math.max(1, Math.min(9, roundToHalf(1.5 + ((ability - 1) / 5) * 7.5)));
}

/**
 * Turn a finished sitting into the result the rest of the app stores.
 *
 * The band comes from the ability estimate rather than a raw score, because in
 * an adaptive test the score is close to meaningless: a well-calibrated run
 * leaves nearly everyone answering roughly half their questions correctly. The
 * information is in *which* questions they were, and that is what ability
 * tracks. The by-skill and by-level tallies are kept for the breakdown.
 */
export function finishAdaptive(state: AdaptiveState): PlacementResult {
  const bySkill = {} as PlacementResult["bySkill"];
  const byLevel = {} as PlacementResult["byLevel"];
  for (const skill of SKILLS) bySkill[skill] = { correct: 0, total: 0 };
  for (const level of LEVELS) byLevel[level] = { correct: 0, total: 0 };

  for (const q of state.asked) {
    bySkill[q.skill].total += 1;
    byLevel[q.level].total += 1;
    if (state.answers[q.id] === q.answer) {
      bySkill[q.skill].correct += 1;
      byLevel[q.level].correct += 1;
    }
  }

  return {
    band: abilityToBand(state.ability),
    date: new Date().toISOString(),
    bySkill,
    byLevel,
  };
}

/** Whether the bank can support a full sitting without reusing questions. */
export function bankIsSufficient(bank: PlacementQuestion[], recentlyUsed: string[] = []): boolean {
  const available = bank.filter((q) => !recentlyUsed.includes(q.id));
  return available.length >= TEST_LENGTH;
}
