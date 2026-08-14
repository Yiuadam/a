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

let timer: number | null = null;
let inFlight = false;
let runAgain = false;
let retryAttempt = 0;

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
  if (outcome.status === "done") retryAttempt = 0;
  else if (outcome.status === "signed-out") cancelScheduledSync();
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
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
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
}
