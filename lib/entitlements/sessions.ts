import type { ModuleName } from "@/lib/types";

/*
  How many practice sessions each tier may sit in a week, per skill.

  ---------------------------------------------------------------------------
  Why this is separate from the AI allowance

  They limit different things and they are not interchangeable. The AI
  allowance (lib/usage/limits.ts) is a cost control: every metered request
  spends real money, so it is counted and capped. This is a product decision:
  how much of the app you get before you make an account, and before you pay.

  A learner can be well inside their AI allowance and still be out of reading
  papers for the week, and that is correct — reading papers are marked from an
  answer key and cost nothing to serve, so the AI cap would never stop anyone
  sitting a hundred of them.

  ---------------------------------------------------------------------------
  Why anonymous gets no writing and no speaking

  Because both are marked by the model, and anonymous callers get no model at
  all (ANONYMOUS_DAILY_AI_CALLS is 0 — see lib/usage/limits.ts for why). A
  writing session without marking hands somebody a blank box, forty minutes,
  and nothing at the end. The owner's own words on this: "what's the point of
  doing the writing practice?" — and the same argument retires speaking, which
  is marked the same way.

  Listening and reading are the two that genuinely work with no model behind
  them, because they are marked against an answer key that ships in the bundle.
  So they are exactly the right two to give away, and a visitor who has never
  signed in gets a real paper with a real band at the end of it.

  ---------------------------------------------------------------------------
  Why `null` for a subscriber

  Standard does not ration sessions at all; its limit is the daily AI
  allowance, which is 500 rather than 20. That is the honest shape of the
  thing — the sessions are unlocked and the model time is what is metered —
  and the pricing page says both halves rather than only the flattering one.
*/

export type SessionTier = "anonymous" | "free" | "pro" | "admin";

export interface SkillAllowance {
  /** Sessions per week, or null for no limit. */
  perWeek: number | null;
  /**
   * How many questions of a session are answerable, or null for all of them.
   *
   * Only speaking uses this. A real speaking test runs to several questions
   * across three parts, and a free account gets one — enough to hear what the
   * examiner does with an answer, which is the thing worth trying before you
   * pay for it.
   */
  maxQuestions: number | null;
}

const LOCKED: SkillAllowance = { perWeek: 0, maxQuestions: 0 };
const UNLIMITED: SkillAllowance = { perWeek: null, maxQuestions: null };

export const SESSION_LIMITS: Record<SessionTier, Record<ModuleName, SkillAllowance>> = {
  anonymous: {
    listening: { perWeek: 1, maxQuestions: null },
    reading: { perWeek: 1, maxQuestions: null },
    writing: LOCKED,
    speaking: LOCKED,
  },
  free: {
    listening: { perWeek: 2, maxQuestions: null },
    reading: { perWeek: 2, maxQuestions: null },
    writing: { perWeek: 1, maxQuestions: null },
    speaking: { perWeek: 1, maxQuestions: 1 },
  },
  pro: {
    listening: UNLIMITED,
    reading: UNLIMITED,
    writing: UNLIMITED,
    speaking: UNLIMITED,
  },
  admin: {
    listening: UNLIMITED,
    reading: UNLIMITED,
    writing: UNLIMITED,
    speaking: UNLIMITED,
  },
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
 * standing between them and the feature. "subscribe" for a free account, where
 * an account is not the missing piece. Null when nothing is in the way.
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
 * rather than "perWeek: 1", and the speaking caveat stated rather than left
 * for them to discover at question two.
 */
export function allowanceLabel(tier: SessionTier, module: ModuleName): string {
  const { perWeek, maxQuestions } = allowanceFor(tier, module);
  if (perWeek === null) return "Unlimited";
  if (perWeek === 0) return tier === "anonymous" ? "Sign in to use this" : "On Standard";
  const sessions = perWeek === 1 ? "1 session a week" : `${perWeek} sessions a week`;
  if (maxQuestions === null) return sessions;
  return maxQuestions === 1 ? `${sessions}, 1 question` : `${sessions}, ${maxQuestions} questions`;
}
