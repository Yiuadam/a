import { LEVELS, SKILLS, roundToHalf } from "./band";
import type { CEFRLevel, PlacementQuestion, PlacementResult } from "./types";

/*
  ---------------------------------------------------------------------------
  The adaptive engine
  ---------------------------------------------------------------------------
  This is item response theory (IRT), the method real computer-adaptive exams
  use, rather than the up-a-bit / down-a-bit staircase it replaces.

  Three things make it more accurate than a staircase:

  1. Every answer is scored against a *model* of how likely it was. Getting a
     C2 item right when the estimate says B1 is surprising and moves the
     estimate a long way; getting an A1 item right when the estimate says C1
     is expected and moves it barely at all. A staircase moves the same
     distance either way and throws that information away.

  2. Guessing is modelled. These are four-option questions, so a candidate who
     knows nothing still gets one in four right. Without a guessing floor the
     estimate drifts upwards for weak candidates — the single biggest source of
     error in a short multiple-choice test.

  3. The next item is the one that will *tell us the most* at the current
     estimate (maximum Fisher information), not merely one at the current
     level. Information peaks where an item is genuinely 50/50, so the test
     naturally seeks out the questions that discriminate.

  The estimate itself is EAP — the mean of the posterior over a grid of ability
  values, starting from a normal prior. Unlike maximum likelihood it stays
  finite when someone answers everything right or everything wrong, and it
  yields a standard error for free, which is what lets the test stop early once
  it is confident rather than always running to a fixed length.
*/

/*
  Ability and difficulty share one logit scale, roughly -2.5 (A1) to +2.5 (C2).
  The grid runs wider than the items so a candidate at the very top or bottom
  is not squeezed against the edge of what the estimator can represent.
*/
const THETA_MIN = -3.8;
const THETA_MAX = 3.8;
const GRID_STEPS = 77;

/** Difficulty of an item at each CEFR level, on the ability scale. */
const LEVEL_DIFFICULTY: Record<CEFRLevel, number> = {
  A1: -2.5,
  A2: -1.5,
  B1: -0.5,
  B2: 0.5,
  C1: 1.5,
  C2: 2.5,
};

/*
  Discrimination and guessing. Without response data from real candidates these
  cannot be calibrated per item, so every item of a kind shares a value —
  standard practice for a new bank, and far better than ignoring them.
  Vocabulary items discriminate a little more sharply than reading ones, where
  a candidate can sometimes reason their way to the answer.
*/
const DISCRIMINATION: Record<PlacementQuestion["skill"], number> = {
  grammar: 1.25,
  vocabulary: 1.35,
  reading: 1.05,
};

/** Four options, so a candidate who knows nothing still scores about 1 in 4. */
const GUESS = 0.25;

/*
  The prior is deliberately almost flat.

  A tight prior makes mid-range estimates a little steadier, but it does so by
  dragging genuinely strong and genuinely weak candidates towards the middle —
  scripts/simulate-placement.mjs measured that pull at more than a full band at
  the top of the scale. Reporting a band 8.5 learner as a 7.4 is a much worse
  failure than a slightly noisier band 5, so the prior is widened until the
  bias disappears and the noise is left where it belongs.
*/
const PRIOR_MEAN = 0;
const PRIOR_SD = 4;

/** Stop once the estimate is this precise — roughly ±0.55 of a band. */
const TARGET_SE = 0.42;

export type TestLength = 5 | 10;

/**
 * How many questions each sitting length asks.
 *
 * `min` is the floor before early stopping is even considered — an estimate
 * from six answers can look precise by luck, and stopping there would report a
 * band the test has not really earned.
 */
export const LENGTHS: Record<TestLength, { max: number; min: number }> = {
  5: { max: 15, min: 9 },
  10: { max: 25, min: 14 },
};

export interface AdaptiveState {
  /** Ability estimate in logits. */
  theta: number;
  /** Standard error of that estimate — how sure we are. */
  se: number;
  asked: PlacementQuestion[];
  answers: Record<string, number | undefined>;
  length: TestLength;
}

const GRID: number[] = Array.from({ length: GRID_STEPS }, (_, i) =>
  THETA_MIN + ((THETA_MAX - THETA_MIN) * i) / (GRID_STEPS - 1),
);

const PRIOR: number[] = GRID.map((theta) =>
  Math.exp(-((theta - PRIOR_MEAN) ** 2) / (2 * PRIOR_SD ** 2)),
);

/** Probability of a correct answer under the three-parameter logistic model. */
function pCorrect(theta: number, question: PlacementQuestion): number {
  const a = DISCRIMINATION[question.skill];
  const b = LEVEL_DIFFICULTY[question.level];
  return GUESS + (1 - GUESS) / (1 + Math.exp(-a * (theta - b)));
}

/**
 * Fisher information: how much this item would tell us about a candidate whose
 * ability is `theta`. Highest where the item is a genuine coin-flip for them,
 * which is exactly the item worth asking next.
 */
function information(theta: number, question: PlacementQuestion): number {
  const a = DISCRIMINATION[question.skill];
  const p = pCorrect(theta, question);
  if (p <= GUESS || p >= 1) return 0;
  // Standard 3PL information formula.
  return (a * a * (1 - p) * (p - GUESS) ** 2) / (p * (1 - GUESS) ** 2);
}

/** Re-estimate ability and its standard error from every answer so far. */
function estimate(
  asked: PlacementQuestion[],
  answers: Record<string, number | undefined>,
): { theta: number; se: number } {
  const posterior = GRID.map((theta, i) => {
    let likelihood = PRIOR[i];
    for (const q of asked) {
      const p = pCorrect(theta, q);
      likelihood *= answers[q.id] === q.answer ? p : 1 - p;
    }
    return likelihood;
  });

  const total = posterior.reduce((sum, v) => sum + v, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    return { theta: PRIOR_MEAN, se: PRIOR_SD };
  }

  let mean = 0;
  for (let i = 0; i < GRID.length; i++) mean += GRID[i] * (posterior[i] / total);

  let variance = 0;
  for (let i = 0; i < GRID.length; i++) {
    variance += (GRID[i] - mean) ** 2 * (posterior[i] / total);
  }

  return { theta: mean, se: Math.sqrt(variance) };
}

export function startAdaptive(length: TestLength = 5): AdaptiveState {
  return { theta: PRIOR_MEAN, se: PRIOR_SD, asked: [], answers: {}, length };
}

/**
 * Choose the next item: the most informative one the learner has not met
 * recently.
 *
 * Always picking the single best item would make every sitting at a given
 * level identical, so the choice is made at random from the few best. That
 * costs almost nothing in precision — the top handful carry nearly the same
 * information — and it is what keeps repeat sittings from becoming a memory
 * test.
 *
 * Exclusion relaxes rather than fails: if honouring the full history would
 * leave nothing to ask, it drops the oldest sitting and tries again, and only
 * ever repeats an item within the same sitting as a last resort.
 */
export function nextQuestion(
  bank: PlacementQuestion[],
  state: AdaptiveState,
  recentSittings: string[][] = [],
): PlacementQuestion | null {
  const thisSitting = new Set(state.asked.map((q) => q.id));

  // Progressively weaker exclusions: all history, then just the last sitting,
  // then only what this sitting has already asked.
  const attempts = [
    new Set([...recentSittings.flat(), ...thisSitting]),
    new Set([...(recentSittings[0] ?? []), ...thisSitting]),
    thisSitting,
  ];

  // Keep the skills roughly balanced so a sitting is never all grammar.
  const skillCounts = new Map<string, number>();
  for (const q of state.asked) skillCounts.set(q.skill, (skillCounts.get(q.skill) ?? 0) + 1);
  const leastUsed = Math.min(...SKILLS.map((s) => skillCounts.get(s) ?? 0));

  for (const excluded of attempts) {
    const available = bank.filter((q) => !excluded.has(q.id));
    if (available.length === 0) continue;

    // Prefer under-used skills, but only while that leaves a real choice.
    const balanced = available.filter((q) => (skillCounts.get(q.skill) ?? 0) === leastUsed);
    const pool = balanced.length >= 3 ? balanced : available;

    const ranked = pool
      .map((q) => ({ q, info: information(state.theta, q) }))
      .sort((a, b) => b.info - a.info);

    const topN = Math.min(4, ranked.length);
    return ranked[Math.floor(Math.random() * topN)].q;
  }
  return null;
}

/** Fold one answer in and re-estimate from scratch — order must not matter. */
export function recordAnswer(
  state: AdaptiveState,
  question: PlacementQuestion,
  choice: number | undefined,
): AdaptiveState {
  const asked = [...state.asked, question];
  const answers = { ...state.answers, [question.id]: choice };
  const { theta, se } = estimate(asked, answers);
  return { ...state, theta, se, asked, answers };
}

/**
 * Whether the test has learned enough to stop.
 *
 * Two conditions end it: the estimate is precise enough (so more questions
 * would only confirm what we know), or the sitting has used its full length.
 */
export function shouldStop(state: AdaptiveState): boolean {
  const { max, min } = LENGTHS[state.length];
  if (state.asked.length >= max) return true;
  return state.asked.length >= min && state.se <= TARGET_SE;
}

/**
 * Convert ability to an IELTS band.
 *
 * Anchored so that the CEFR difficulty of each level lands near its usual band
 * equivalent: B1 (θ = −0.5) ≈ 4.5, B2 (θ = 0.5) ≈ 5.5, C1 (θ = 1.5) ≈ 7,
 * C2 (θ = 2.5) ≈ 8.5.
 */
export function thetaToBand(theta: number): number {
  return Math.max(1, Math.min(9, roundToHalf(5 + theta * 1.3)));
}

/** The band range we are actually confident about, at roughly 95%. */
export function bandRange(state: AdaptiveState): [number, number] {
  return [
    thetaToBand(state.theta - 1.96 * state.se),
    thetaToBand(state.theta + 1.96 * state.se),
  ];
}

/**
 * Turn a finished sitting into the result the rest of the app stores.
 *
 * The band comes from the ability estimate rather than a raw score, because in
 * an adaptive test the score is close to meaningless: a well-targeted run
 * leaves nearly everyone answering roughly half their questions correctly. The
 * information is in *which* ones, and that is what the estimate captures. The
 * by-skill and by-level tallies are kept for the breakdown.
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
    band: thetaToBand(state.theta),
    date: new Date().toISOString(),
    bySkill,
    byLevel,
  };
}

