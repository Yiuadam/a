"use client";

import { getSnapshot as sessionSnapshot } from "@/lib/account";
import { syncProgress } from "./sync";

/*
  Sync without a button.

  The learner's mental model is "I finished the exercise, so my account has it".
  The button model was "I finished the exercise, and later I remembered to
  press a thing". This module closes that gap: stores announce a write (see
  events.ts), and a few seconds later — batched, in the background, only when
  signed in — the ordinary two-way sync runs.

  Why a debounce rather than sync-per-write: finishing one practice test writes
  several times in quick succession (result, generated test, plan input). One
  merged sync a few seconds after the last write carries all of it, and a
  visibility changes force an immediate pass before browsers start throttling
  background work, and the next signed-in open reconciles again.

  Everything here is fire-and-forget by design. A failed sync must cost the
  learner nothing: the browser keeps its copy, and the next trigger tries
  again with bounded backoff. There is no manual control to remember:
  successful account sign-in and each completed change schedule this
  automatically.
*/

const DEBOUNCE_MS = 1500;
const RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 300_000] as const;
/*
  This whole site shares one Cloudflare Workers Free-plan budget of 100,000
  requests/day; a sync the account keeps rejecting must not keep asking every
  five minutes for as long as the tab happens to stay open — that is exactly
  how the two real 1027 outages started. RETRY_BUDGET bounds the number of
  unattended retries since the last success (mirrors RESTART_BUDGET in
  components/speaking/SpeakingSession.tsx for the same shape of problem): once
  it is spent, scheduleRetry stops arming further timers on its own. At the
  five-minute floor, twenty retries is still roughly ninety minutes of trying
  — long enough to sit out a deploy, a rollback, or a rough patch of network,
  short enough that a genuinely broken route goes quiet within a sitting
  rather than for the rest of the day.

  retryFailures is deliberately separate from retryAttempt (which only picks
  the delay) and is NOT reset by scheduleSync/flushProgressSync — only a
  successful sync, or signing out, clears it. scheduleSync resetting
  retryAttempt is what lets returning to a tab retry immediately rather than
  waiting out whatever backoff step it was on, and that is worth keeping: it
  is how a device notices another device's practice soon after being looked
  at again. But if retryFailures reset the same way, a learner who keeps
  switching tabs could refill the budget indefinitely and reproduce the same
  unbounded loop with extra steps. Once the budget is spent, a real trigger
  (a write, a sign-in, coming back online) can still ask for a sync — this
  module never refuses to try — it just won't schedule a follow-up by itself
  until one of those attempts actually succeeds.
*/
const RETRY_BUDGET = 20;

let timer: number | null = null;
let inFlight = false;
let runAgain = false;
let retryAttempt = 0;
let retryFailures = 0;

function signedIn(): boolean {
  return sessionSnapshot() !== null;
}

async function run(): Promise<void> {
  if (!signedIn()) {
    cancelScheduledSync();
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (inFlight) {
    // A write arrived while a sync was mid-flight; that sync read the stores
    // before the write, so one more pass is owed once it finishes.
    runAgain = true;
    return;
  }
  inFlight = true;
  let outcome: Awaited<ReturnType<typeof syncProgress>> = { status: "unavailable" };
  try {
    outcome = await syncProgress();
  } catch {
    // syncProgress reports failures as return values; this catch is for the
    // unexpected, and the answer is the same either way: try again next time.
  }
  inFlight = false;
  if (runAgain) {
    runAgain = false;
    scheduleSync(0);
    return;
  }
  if (outcome.status === "done") {
    retryAttempt = 0;
    retryFailures = 0;
  }
  /* A payload the server refuses as too large stays too large until the
     learner clears something; retrying it every minute would only repeat the
     refusal, so it waits for the next real write like the other final states. */
  else if (
    outcome.status === "signed-out"
    || outcome.status === "not-entitled"
    || outcome.status === "too-large"
  ) cancelScheduledSync();
  else scheduleRetry();
}

function setTimer(delayMs: number): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void run();
  }, Math.max(0, delayMs));
}

function scheduleRetry(): void {
  if (!signedIn() || navigator.onLine === false || document.hidden) return;
  // The budget is spent: stop arming timers by ourselves. run() is still
  // reachable from a fresh external trigger, so this is a pause, not a dead
  // end — see the WHY note on RETRY_BUDGET above.
  if (retryFailures >= RETRY_BUDGET) return;
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryFailures += 1;
  setTimer(delay);
}

/** Ask for a sync soon. Coalesces with any already pending. */
export function scheduleSync(delayMs: number = DEBOUNCE_MS): void {
  if (typeof window === "undefined" || !signedIn()) return;
  retryAttempt = 0;
  setTimer(delayMs);
}

/** Run as soon as possible, including when a write arrives during a request. */
export function flushProgressSync(): void {
  scheduleSync(0);
}

/** Cancel pending work when the account signs out. */
export function cancelScheduledSync(): void {
  if (typeof window !== "undefined" && timer !== null) window.clearTimeout(timer);
  timer = null;
  runAgain = false;
  retryAttempt = 0;
  retryFailures = 0;
}
