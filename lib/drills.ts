import type { CEFRLevel } from "./types";

export interface DrillQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

export interface DrillTopic {
  id: string;
  title: string;
  level: CEFRLevel;
  /** One or two sentences on why this topic matters. */
  summary: string;
  /** The teaching note: the few rules that fix most of the errors. */
  points: string[];
  questions: DrillQuestion[];
}

export interface DrillData {
  topics: DrillTopic[];
}

/** Fisher-Yates: a genuinely uniform shuffle. */
export function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/*
  Drill scores are kept per topic so the index can show what has been done and
  how well. Only the best score is kept: a learner who comes back and improves
  should see their best work, and one who half-finishes a topic on the bus
  should not have their earlier good run overwritten.
*/
const KEY = "bandup.drills.v1";

export interface DrillScore {
  correct: number;
  total: number;
  at: string;
}

type Scores = Record<string, DrillScore>;

const listeners = new Set<() => void>();
let cache: Scores | null = null;

function read(): Scores {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Scores) : {};
  } catch {
    return {};
  }
}

export function subscribeDrills(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function drillScores(): Scores {
  if (cache === null) cache = read();
  return cache;
}

export function getServerDrillScores(): Scores {
  return {};
}

export function recordDrill(topicId: string, correct: number, total: number): void {
  const current = drillScores()[topicId];
  const isBetter = !current || correct / total >= current.correct / current.total;
  if (!isBetter) return;
  const next: Scores = {
    ...drillScores(),
    [topicId]: { correct, total, at: new Date().toISOString() },
  };
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked — keep the in-memory copy.
  }
  for (const listener of listeners) listener();
}
