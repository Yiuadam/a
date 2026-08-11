import type { ModuleName, ModuleResult, Profile } from "./types";

/*
  "New" describes unfinished work, not unseen navigation.

  A click is not progress: somebody can open a paper, close it immediately and
  still need the same invitation when they return.  These helpers deliberately
  read only durable completion records written after results/feedback are
  shown.  Keeping that rule here prevents individual card lists from quietly
  drifting back to click- or visit-based behaviour.
*/

export function moduleNeedsNewBadge(
  profile: Pick<Profile, "results">,
  module: ModuleName,
): boolean {
  return !profile.results.some((result) => result.module === module);
}

export function paperNeedsNewBadge(
  results: readonly ModuleResult[],
  testId: string,
): boolean {
  return !results.some((result) => result.testId === testId);
}

export function drillNeedsNewBadge(
  scores: Readonly<Record<string, unknown>>,
  topicId: string,
): boolean {
  return scores[topicId] === undefined;
}

/*
  The dashboard must not import the two full drill banks just to answer one
  yes/no question. They are roughly 100 KB of prompts and answer keys. This
  compact index keeps that material off the home-page client bundle; the test
  suite compares it with both JSON banks so a newly authored topic cannot be
  forgotten here.
*/
export const DRILL_TOPIC_IDS = {
  grammar: [
    "present-perfect",
    "articles",
    "conditionals",
    "verb-patterns",
    "passive",
    "relative-clauses",
    "modals",
    "word-order",
    "prepositions",
    "countable",
  ],
  vocabulary: [
    "collocations",
    "phrasal-verbs",
    "word-formation",
    "academic-verbs",
    "describing-change",
    "confusables",
    "linking",
    "topic-people",
  ],
} as const;

export type DrillBadgeKind = keyof typeof DRILL_TOPIC_IDS;

export function drillSectionNeedsNewBadge(
  scores: Readonly<Record<string, unknown>>,
  kind: DrillBadgeKind,
): boolean {
  return DRILL_TOPIC_IDS[kind].every((topicId) => drillNeedsNewBadge(scores, topicId));
}
