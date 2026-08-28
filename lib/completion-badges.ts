import type { ModuleName, ModuleResult, Profile } from "./types";

/*
  The dashboard's "New" labels describe unseen destinations: once a learner
  opens a skill or study section, its homepage label should not reappear on a
  later visit. `visited` is synced and append-only so this holds across the
  learner's signed-in browsers.

  Paper and topic labels below remain completion-based. Opening one paper is
  not the same as completing it, so the more granular lists still invite the
  learner back until they submit a result or record a drill score.
*/

export function moduleNeedsNewBadge(
  profile: Pick<Profile, "results" | "visited">,
  module: ModuleName,
): boolean {
  return !profile.visited?.includes(module)
    && !profile.results.some((result) => result.module === module);
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
    "reported-speech",
    "subject-verb-agreement",
    "comparatives-superlatives",
    "embedded-questions",
    "question-formation",
    "verb-prepositions",
    "future-forms",
    "used-to-would",
    "tag-questions",
    "ing-ed-adjectives",
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
    "hedging-language",
    "quantity-and-proportion",
    "adjective-preposition-collocations",
    "register-pairs",
    "topic-education",
    "topic-environment",
    "giving-opinions",
    "topic-technology",
    "cause-and-effect-language",
    "paraphrasing-pairs",
  ],
} as const;

export type DrillBadgeKind = keyof typeof DRILL_TOPIC_IDS;

export function drillSectionNeedsNewBadge(
  profile: Pick<Profile, "visited">,
  scores: Readonly<Record<string, unknown>>,
  kind: DrillBadgeKind,
): boolean {
  return !profile.visited?.includes(kind)
    && DRILL_TOPIC_IDS[kind].every((topicId) => drillNeedsNewBadge(scores, topicId));
}
