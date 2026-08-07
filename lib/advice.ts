import { LEVELS, SKILLS } from "./band";
import type { CEFRLevel, PlacementResult, TestQuestion } from "./types";

/*
  Advice is deliberately terse: two short lists, a few words each.

  A paragraph of coaching after a test does not get read — the learner has just
  finished concentrating for five minutes and wants to know two things, which
  went well and what to fix. Anything longer competes with the mistake review
  below it, which is where the real detail belongs.
*/
export interface AdviceReport {
  good: string[];
  improve: string[];
}

const LEVEL_TIP: Record<CEFRLevel, string> = {
  A1: "Learn everyday words",
  A2: "Master past tenses",
  B1: "Build longer sentences",
  B2: "Sharpen word choice",
  C1: "Add idiomatic range",
  C2: "Polish exam timing",
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Advice after the adaptive placement test. */
export function placementAdvice(result: PlacementResult): AdviceReport {
  const good: string[] = [];
  const improve: string[] = [];

  const rates = SKILLS.map((s) => {
    const b = result.bySkill[s];
    return { skill: s, rate: b.total > 0 ? b.correct / b.total : 0, total: b.total };
  }).filter((r) => r.total > 0);

  const sorted = [...rates].sort((a, b) => b.rate - a.rate);
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];

  // The hardest level they got anything right at says more than the band does.
  const ceiling = [...LEVELS].reverse().find((l) => result.byLevel[l].correct > 0);
  // The easiest level they dropped a mark at is where the hole is.
  const floor = LEVELS.find((l) => {
    const b = result.byLevel[l];
    return b.total > 0 && b.correct < b.total;
  });

  if (strongest && strongest.rate >= 0.6) good.push(`Strong ${strongest.skill}`);
  if (ceiling) good.push(`Handled ${ceiling} questions`);
  for (const r of rates) {
    if (r.rate === 1) good.push(`${capitalise(r.skill)} all correct`);
  }
  if (good.length === 0) good.push("Finished the whole test");

  if (weakest && strongest && weakest.skill !== strongest.skill) {
    improve.push(`More ${weakest.skill} practice`);
  } else if (weakest && weakest.rate < 1) {
    improve.push(`More ${weakest.skill} practice`);
  }
  if (floor && ceiling && LEVELS.indexOf(floor) < LEVELS.indexOf(ceiling)) {
    improve.push(`Fix ${floor} gaps`);
  }
  if (ceiling) improve.push(LEVEL_TIP[ceiling]);
  improve.push("Retake in two weeks");

  return { good: good.slice(0, 4), improve: improve.slice(0, 4) };
}

const TYPE_NAME: Record<TestQuestion["type"], string> = {
  tfng: "True/False",
  mcq: "Multiple choice",
  completion: "Completion",
};

const TYPE_FIX: Record<TestQuestion["type"], string> = {
  tfng: "Not Given means unsaid",
  mcq: "Find the line first",
  completion: "Copy the word exactly",
};

/** Advice after a reading or listening practice test. */
export function testAdvice(
  module: "reading" | "listening",
  questions: TestQuestion[],
  wrongIds: string[],
  band: number,
): AdviceReport {
  const good: string[] = [];
  const improve: string[] = [];
  const wrong = new Set(wrongIds);

  const byType = new Map<TestQuestion["type"], { wrong: number; total: number }>();
  for (const q of questions) {
    const entry = byType.get(q.type) ?? { wrong: 0, total: 0 };
    entry.total += 1;
    if (wrong.has(q.id)) entry.wrong += 1;
    byType.set(q.type, entry);
  }

  for (const [type, v] of byType) {
    if (v.wrong === 0) good.push(`${TYPE_NAME[type]} all correct`);
  }
  if (band >= 7) good.push(`Band ${band} — strong`);
  else if (band >= 6) good.push(`Band ${band} — solid`);
  if (good.length === 0) good.push("Completed under time");

  const worst = [...byType.entries()]
    .filter(([, v]) => v.wrong > 0)
    .sort((a, b) => b[1].wrong / b[1].total - a[1].wrong / a[1].total)[0];
  if (worst) improve.push(TYPE_FIX[worst[0]]);

  if (module === "listening") {
    improve.push(wrong.size > 3 ? "Replay with the transcript" : "Predict the answer type");
  } else {
    improve.push(wrong.size > 3 ? "Underline the exact line" : "Work on your speed");
  }

  improve.push(band < 6 ? "One careful test daily" : "Practise against the clock");

  return { good: good.slice(0, 4), improve: improve.slice(0, 4) };
}
