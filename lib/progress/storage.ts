"use client";

/*
  Where a learner's own work is kept in the browser.

  ---------------------------------------------------------------------------
  Signed out, nothing survives the tab

  The owner's decision, and the right one for this app: somebody who has not
  made an account has not asked BandUp to remember anything about them. A
  placement result, the words they looked up and the drills they got wrong are
  a fairly complete picture of what a person is bad at in a language, and
  leaving that on a shared or borrowed machine — which, for this audience, is
  a very ordinary machine — is not something they consented to.

  So the working copy lives in sessionStorage. That gives exactly the promised
  behaviour and no more: a reload keeps your place, and closing the tab or the
  browser ends it. A second tab is a second sitting, which is the same thing an
  exam would say.

  ---------------------------------------------------------------------------
  Signed in, the account is the copy that lasts

  Nothing changes here for a signed-in learner, because nothing needed to. The
  sync already pulls from the account on load, merges, and pushes back
  (lib/progress/sync.ts, mounted by components/AutoSync.tsx). Making the local
  copy per-tab simply removes the second durable store, and with it the
  question of which of the two was right when they disagreed. The account is
  the answer; the tab is a scratchpad.

  The cost is honest and worth stating: a signed-in learner who finishes a
  paper while offline and closes the tab before it syncs loses that result.
  Before this change it would have sat in localStorage and gone up later. The
  sync runs a second and a half after load, on every write, and whenever the
  tab becomes visible again, so the window is small — but it is not zero.

  ---------------------------------------------------------------------------
  What is deliberately still in localStorage

  The session token, the theme and the speech preferences. None of them is a
  record of what a learner has done: one keeps you signed in across a restart,
  which is the whole point of it, and the other two are settings for this
  device that would be tedious to keep re-choosing. Learner *work* is what
  moves; device *preferences* stay.
*/

/*
  Data written before this change is on the old shelf, so the first read of a
  key moves it across and deletes the original. Without this, everyone loses
  their placement result on the deploy that ships this — and, worse, the old
  copy would sit in localStorage forever with nothing left that reads it.

  Once per key per tab: the delete makes it idempotent, and a key that was
  never there costs one miss.
*/
const migrated = new Set<string>();
const UPDATED_PREFIX = "bandup.progress-updated.v1:";

function updatedKey(key: string): string {
  return `${UPDATED_PREFIX}${key}`;
}

function validStamp(value: string | null): string | null {
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function migrateOnce(key: string): void {
  if (migrated.has(key)) return;
  migrated.add(key);
  try {
    const old = window.localStorage.getItem(key);
    if (old === null) return;
    if (window.sessionStorage.getItem(key) === null) {
      window.sessionStorage.setItem(key, old);
      const oldStamp = validStamp(window.localStorage.getItem(updatedKey(key)));
      window.sessionStorage.setItem(updatedKey(key), oldStamp ?? new Date().toISOString());
    }
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(updatedKey(key));
  } catch {
    /* Storage blocked entirely. Nothing to move, nothing to clean up. */
  }
}

/** Reads a learner-data key, or null. Safe on the server. */
export function readLearnerItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    migrateOnce(key);
    return window.sessionStorage.getItem(key);
  } catch {
    /* Private mode with storage disabled. The in-memory caches above each
       store still work for this tab, which is all sessionStorage promised. */
    return null;
  }
}

/**
 * When this device last changed a learner-data key.
 *
 * This is deliberately separate from the JSON payload. It lets account sync
 * compare a local scalar with the account's scalar without pretending that an
 * old tab became newer merely because sync happened to run just now.
 */
export function learnerItemUpdatedAt(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    migrateOnce(key);
    return validStamp(window.sessionStorage.getItem(updatedKey(key)));
  } catch {
    return null;
  }
}

/** Writes a learner-data key. Failure is survivable and deliberately silent. */
export function writeLearnerItem(
  key: string,
  value: string,
  options: { clientUpdatedAt?: string | null } = {},
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
    const stamp = Object.prototype.hasOwnProperty.call(options, "clientUpdatedAt")
      ? validStamp(options.clientUpdatedAt ?? null)
      : new Date().toISOString();
    if (stamp) window.sessionStorage.setItem(updatedKey(key), stamp);
    else window.sessionStorage.removeItem(updatedKey(key));
  } catch {
    /* Full, or blocked. The caller keeps its in-memory copy either way. */
  }
}

/** Forgets a learner-data key in both places, for "clear this device". */
export function removeLearnerItem(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
    window.sessionStorage.removeItem(updatedKey(key));
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(updatedKey(key));
  } catch {
    /* Nothing to do. */
  }
}
