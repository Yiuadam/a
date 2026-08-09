"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useProfile } from "@/lib/hooks";
import { useTier } from "@/lib/billing/useTier";
import { allowanceFor, lockReason, sessionsLeft, type LockReason, type SessionTier } from "./sessions";
import type { ModuleName, ModuleResult } from "@/lib/types";

/*
  What this learner may sit right now, per skill.

  ---------------------------------------------------------------------------
  What this decides, and what it does not

  It decides what the screen draws — a lock, a counter, or nothing. It is not
  the enforcement, and for two of the four skills there is no enforcement to
  speak of, which is worth saying plainly rather than implying otherwise:

    writing and speaking are marked by the model, so the real gate is on the
      server — requireFeature and the AI allowance, which a client cannot talk
      its way past.
    reading and listening are marked against an answer key that ships in the
      bundle. Sitting one costs nothing to serve, so the weekly limit on them
      is a product decision rather than a cost control, and somebody who edits
      it in dev tools gets to mark their own reading paper. That is a fine
      thing to lose.

  Putting a server-side counter on the two free ones would mean a round trip
  and a table write for something that costs nothing and protects nothing.

  ---------------------------------------------------------------------------
  The week

  A rolling seven days, matching how the AI allowance rolls over 24 hours —
  same reasoning: no reset hour, so no argument about whose Monday it is and
  nobody staying up to catch a refill.

  Sessions are counted from the results already in the profile, which is what
  makes this work signed out. A visitor's sitting is in localStorage, so their
  one free reading paper is remembered without an account, and syncing to an
  account later brings the count with it.
*/

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/*
  An hourly clock as an external store. Same shape as the minute clock in
  components/billing/UsageMeter.tsx, and there for the same reason: getSnapshot
  has to return a stable value between ticks or React re-renders forever
  looking for it to settle.

  The server snapshot is the same function rather than null, because unlike a
  countdown this value only decides which of a learner's own sittings fall
  inside the last seven days — a server and a client an hour apart reach the
  same answer, and there is nothing to mismatch.
*/
const HOUR = 60 * 60 * 1000;

function subscribeHourly(onChange: () => void): () => void {
  const id = setInterval(onChange, HOUR);
  return () => clearInterval(id);
}

function hourNow(): number {
  return Math.floor(Date.now() / HOUR) * HOUR;
}

export interface SkillAccess {
  /** Locked outright for this tier. */
  locked: boolean;
  /** Where a locked card should send them, or null when nothing is locked. */
  reason: LockReason;
  /** Sessions sat in the last seven days. */
  satThisWeek: number;
  /** Sessions still available, or null when there is no limit. */
  left: number | null;
  /** Out of sessions, but not locked — a different message and a different fix. */
  usedUp: boolean;
  /** Questions answerable in one session, or null for all of them. */
  maxQuestions: number | null;
}

function countThisWeek(results: readonly ModuleResult[], module: ModuleName, now: number): number {
  let n = 0;
  for (const r of results) {
    if (r.module !== module) continue;
    const t = Date.parse(r.date);
    /*
      An unparseable date counts as inside the week rather than outside it.
      Both readings are wrong for somebody; this one is wrong in the direction
      of the learner having used a session, which is recoverable — the other
      hands out free ones to anybody who can write a bad timestamp.
    */
    if (!Number.isFinite(t) || now - t < WEEK_MS) n += 1;
  }
  return n;
}

export function useSessionAccess(): Record<ModuleName, SkillAccess> & { tier: SessionTier } {
  const profile = useProfile();
  const account = useTier();

  /*
    The tier for session purposes, which is not quite the billing tier.

    Signed out is its own row in the table and is not a tier anybody has. And
    while the account is still loading — or on a deployment with accounts
    switched off entirely — this reports the most generous answer rather than
    the safest one, so a subscriber never watches their own paid features
    appear locked for a moment on a slow connection. The server is what
    refuses; being briefly optimistic here costs nothing.
  */
  const tier: SessionTier =
    account.phase !== "ready" || !account.accountsEnabled
      ? "pro"
      : !account.signedIn
        ? "anonymous"
        : account.tier === "admin"
          ? "admin"
          : account.tier === "pro"
            ? "pro"
            : "free";

  /*
    The clock comes from a store rather than from Date.now() in render.

    react-hooks/purity rejects the direct call, and it is right to: a render
    that reads the wall clock is a render that cannot be replayed, and React
    reserves the right to replay one. Quantised to the hour, which is plenty
    for a boundary seven days away and means the value is stable across the
    re-renders of a single interaction — two skills can never disagree about
    where the week ends.
  */
  const now = useSyncExternalStore(subscribeHourly, hourNow, hourNow);

  return useMemo(() => {
    const of = (module: ModuleName): SkillAccess => {
      const sat = countThisWeek(profile.results, module, now);
      const left = sessionsLeft(tier, module, sat);
      const locked = allowanceFor(tier, module).perWeek === 0;
      return {
        locked,
        reason: lockReason(tier, module),
        satThisWeek: sat,
        left,
        usedUp: !locked && left === 0,
        maxQuestions: allowanceFor(tier, module).maxQuestions,
      };
    };
    return {
      tier,
      listening: of("listening"),
      reading: of("reading"),
      writing: of("writing"),
      speaking: of("speaking"),
    };
  }, [profile.results, tier, now]);
}
