import type { ModuleName } from "@/lib/types";

/*
  How many practice sessions each tier may sit in a week, per skill.

  ---------------------------------------------------------------------------
  Why this is separate from the AI allowance

  They limit different things and they are not interchangeable. The AI
  allowance (lib/usage/limits.ts) is a cost control: every metered request
  spends real money, so it is counted and capped. This is a product decision:
  how much of the app you get before you make an account.

  A learner can be well inside their AI allowance and still be out of reading
  papers for the week, and that is correct — reading papers are marked from an
  answer key and cost nothing to serve, so the AI cap would never stop anyone
  sitting a hundred of them.

  ---------------------------------------------------------------------------
  Why every signed-in tier gets everything now

  This table used to ration Free the way an anonymous visitor is rationed —
  two reading papers a week, two listening, and writing and speaking locked
  outright, on the reasoning that a writing session nobody marks is a blank
  box, forty minutes and nothing at the end.

  The owner's decision changed the premise the second half of that reasoning
  stood on. Free now hands the essay or the transcript back afterward,
  unscored — not nothing, and worth having even without a band attached to it.
  So the whole library opens the moment somebody signs in: every reading and
  listening paper, every writing task, every speaking interview, unlimited,
  whether or not they ever pay for anything. What is not free is a place that
  remembers a sitting happened — that is Tracking, and it is a separate gate
  entirely (lib/billing/tiers.ts's `progress-sync` feature), not this one.

  Anonymous is unchanged and is the one real limit left here. A visitor who
  has not made an account gets a taste — one reading paper, one listening
  paper a week — and nothing that a model would have to mark, because an
  anonymous caller gets no model at all (ANONYMOUS_DAILY_AI_CALLS is 0 — see
  lib/usage/limits.ts) and there is no unscored fallback to hand back on a
  session with no account to remember it happened at all.
*/

export type SessionTier = "anonymous" | "free" | "tracking" | "ai" | "admin";

export interface SkillAllowance {
  /** Sessions per week, or null for no limit. */
  perWeek: number | null;
}

const LOCKED: SkillAllowance = { perWeek: 0 };
const UNLIMITED: SkillAllowance = { perWeek: null };

/** Every skill, unlimited — what every signed-in tier gets. */
const EVERYTHING: Record<ModuleName, SkillAllowance> = {
  listening: UNLIMITED,
  reading: UNLIMITED,
  writing: UNLIMITED,
  speaking: UNLIMITED,
};

export const SESSION_LIMITS: Record<SessionTier, Record<ModuleName, SkillAllowance>> = {
  anonymous: {
    listening: { perWeek: 1 },
    reading: { perWeek: 1 },
    writing: LOCKED,
    speaking: LOCKED,
  },
  free: EVERYTHING,
  tracking: EVERYTHING,
  ai: EVERYTHING,
  admin: EVERYTHING,
};

export function allowanceFor(tier: SessionTier, module: ModuleName): SkillAllowance {
  return SESSION_LIMITS[tier][module];
}

/** A skill this tier may not touch at all. */
export function isLocked(tier: SessionTier, module: ModuleName): boolean {
  return allowanceFor(tier, module).perWeek === 0;
}

export type LockReason = "sign-in" | "subscribe" | null;

/**
 * Why a skill is out of reach, which decides where its card sends you.
 *
 * "sign-in" for a visitor, because an account is free and is the only thing
 * standing between them and the feature. Every signed-in tier unlocks every
 * skill now, so "subscribe" is not reachable through this table any more —
 * it is kept as an answer rather than removed, because `SkillAccess` still
 * declares the type and a locked skill still has to name a reason if one is
 * ever added back.
 */
export function lockReason(tier: SessionTier, module: ModuleName): LockReason {
  if (!isLocked(tier, module)) return null;
  return tier === "anonymous" ? "sign-in" : "subscribe";
}

/**
 * Sessions left this week, given how many have been sat.
 *
 * Null means no limit. Never negative: a learner whose allowance was lowered
 * under them should see zero left, not a negative number they have to
 * interpret.
 */
export function sessionsLeft(
  tier: SessionTier,
  module: ModuleName,
  satThisWeek: number,
): number | null {
  const { perWeek } = allowanceFor(tier, module);
  return perWeek === null ? null : Math.max(0, perWeek - satThisWeek);
}

/**
 * One line saying what a tier gets in a skill, for a card or a tooltip.
 *
 * Written for a learner rather than assembled from the numbers: "1 a week"
 * rather than "perWeek: 1", and a lock says what would open it rather than
 * saying nothing.
 */
export function allowanceLabel(tier: SessionTier, module: ModuleName): string {
  const { perWeek } = allowanceFor(tier, module);
  if (perWeek === null) return "Unlimited";
  /* Only "anonymous" ever reaches here now — every signed-in tier is
     EVERYTHING above, so a locked skill on any of them is not a case this
     table can produce today. */
  if (perWeek === 0) return "Sign in to use this";
  return perWeek === 1 ? "1 session a week" : `${perWeek} sessions a week`;
}
