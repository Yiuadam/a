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
  learner closing the tab inside that window loses nothing — the next open of
  any signed-in page pulls and pushes the same state.

  Everything here is fire-and-forget by design. A failed sync must cost the
  learner nothing: the browser keeps its copy, and the next trigger tries
  again. There is no retry loop and no error surface — the account page's
  status line still exists for anyone who wants to see or force it.
*/

const DEBOUNCE_MS = 4000;

let timer: number | null = null;
let inFlight = false;
let runAgain = false;

function signedIn(): boolean {
  return sessionSnapshot() !== null;
}

async function run(): Promise<void> {
  if (inFlight) {
    // A write arrived while a sync was mid-flight; that sync read the stores
    // before the write, so one more pass is owed once it finishes.
    runAgain = true;
    return;
  }
  inFlight = true;
  try {
    await syncProgress();
  } catch {
    // syncProgress reports failures as return values; this catch is for the
    // unexpected, and the answer is the same either way: try again next time.
  }
  inFlight = false;
  if (runAgain) {
    runAgain = false;
    scheduleSync(0);
  }
}

/** Ask for a sync soon. Coalesces with any already pending. */
export function scheduleSync(delayMs: number = DEBOUNCE_MS): void {
  if (typeof window === "undefined" || !signedIn()) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void run();
  }, delayMs);
}
