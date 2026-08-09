import type { DrillTopic } from "@/lib/drills";
import type { CEFRLevel } from "@/lib/types";
import type { LockReason, SessionTier } from "./sessions";

/*
  How many grammar and vocabulary topics each tier may open.

  ---------------------------------------------------------------------------
  Why drills are capped at all, when they cost nothing to serve

  They are marked from an answer key in the bundle, same as reading and
  listening, so this is not a cost control. It is the same product decision as
  the papers: a visitor gets one of each and can see exactly what the rest are
  before deciding whether an account is worth making. What a visitor must never
  get is a wall — so what they do get is a whole topic, teaching note included,
  worked end to end.

  ---------------------------------------------------------------------------
  Which one they get, and why it is the middle one

  A drill list runs A2 to C1. Handing a visitor the A2 topic would sell the app
  short — articles are not why anyone downloads an IELTS app — and handing them
  the C1 one would lose most of them on the second question. B1 is where the
  audience actually is, and it is the level at which a good explanation is
  visibly worth something, so B1 is what leads.

  `MEDIUM_FIRST` is a preference order over the whole CEFR scale rather than a
  single level, so a data file with no B1 topic at all still resolves to
  something sensible instead of falling back to position zero.
*/

export type DrillKind = "grammar" | "vocabulary";

/** Topics openable per kind. Null is no limit. */
export const DRILL_LIMITS: Record<SessionTier, number | null> = {
  anonymous: 1,
  free: 2,
  pro: null,
  admin: null,
};

export function drillLimit(tier: SessionTier): number | null {
  return DRILL_LIMITS[tier];
}

/** Nearest-to-medium first: B1, then out in both directions. */
const MEDIUM_FIRST: CEFRLevel[] = ["B1", "B2", "A2", "C1", "A1", "C2"];

function rank(level: CEFRLevel): number {
  const i = MEDIUM_FIRST.indexOf(level);
  return i === -1 ? MEDIUM_FIRST.length : i;
}

/**
 * The topics, in the order they should be drawn for this tier.
 *
 * With no limit the authored order is returned untouched — a subscriber should
 * see the curriculum the way it was written, not sorted by how hard it is.
 *
 * With a limit, the openable ones are moved to the front, medium first, and the
 * rest follow in their authored order. That way the first card on the page is
 * one the learner can actually open, which is the difference between a page
 * that starts with an invitation and a page that starts with a padlock.
 *
 * The sort is stable and depends on nothing but the input, so the server render
 * and the client render agree.
 */
export function orderTopics(topics: DrillTopic[], tier: SessionTier): DrillTopic[] {
  const limit = drillLimit(tier);
  if (limit === null || limit >= topics.length) return topics;

  const open = [...topics]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.level) - rank(b.t.level) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.t);

  const openIds = new Set(open.map((t) => t.id));
  return [...open, ...topics.filter((t) => !openIds.has(t.id))];
}

/**
 * Why a topic past the allowance is out of reach, which decides where its card
 * sends you. Same two answers as the practice papers.
 */
export function drillLockReason(tier: SessionTier): Exclude<LockReason, null> {
  return tier === "anonymous" ? "sign-in" : "subscribe";
}
