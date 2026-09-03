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

  ---------------------------------------------------------------------------
  Whose work this is

  sessionStorage answers "does this survive the tab", not "whose is it" — and
  the second question turned out to matter just as much. Sign out of one
  account, sign into a different one in the same tab, and nothing above ever
  asked whose placement result and practice history this was; it simply
  merged whatever was sitting here into whoever signed in next. That is a
  confirmed leak, not a theoretical one: the owner watched their own trend and
  history appear under a brand-new test account, on the same browser and then
  on a second device, because it had genuinely uploaded.

  So alongside the progress itself, this file now keeps a marker for who it
  belongs to. Absent or empty means the work was done signed out, and stays
  exactly as adoptable as before — that is the real feature underneath this,
  someone practising before they make an account and expecting it to be
  theirs once they do. Set to an account's id, it means the opposite: that
  data already has an owner, and lib/progress/sync.ts must refuse to let a
  different account merge it in. See progressOwner, setProgressOwner and
  clearProgressStore below, and lib/progress/sync.ts for where the marker is
  read and acted on.
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

/*
  The progress store: which keys make it up, and whose it is.

  Everything above this point is a generic key/value primitive that happens to
  live in sessionStorage; nothing between here and the top of the file knows
  or cares that there are exactly three progress keys, or what they are
  called. Below this point does, gathered in one place on purpose — a second,
  independently maintained list of the same three keys is exactly how it would
  drift from this one, and a key added to what syncs (lib/progress/sync.ts)
  but not to what a device-clear or a sign-out wipes is how the next leak
  would happen.
*/

/** Every sessionStorage key that holds a piece of a learner's progress. */
/* The learner profile's own key, named so nothing has to repeat the string. */
export const PROFILE_STORAGE_KEY = "ielts-prep-v1";

export const PROGRESS_KEYS = [PROFILE_STORAGE_KEY, "bandup.drills.v1", "bandup.lookups.v1"] as const;
export type ProgressKey = (typeof PROGRESS_KEYS)[number];

/*
  The in-progress mock exam, which is learner work but not synced progress.

  It is deliberately not in PROGRESS_KEYS: that list is what account sync
  uploads, and a half-finished paper is a thing you are doing on this device,
  not a record of what you have done. But everything below that empties a
  learner's work has to take it too, and for a reason the list above cannot
  express — a sitting left resumable on a shared machine is the next person
  resuming *your* exam.

  The literal lives here, at the storage layer, rather than in lib/exam/mock.ts
  where it is used most. mock.ts already imports this module, so this is the
  one direction that can be imported from all three of its clearers —
  lib/store.ts's clearHistory, lib/progress/sync.ts's accepted device clear,
  and clearProgressStore below — without a cycle, and without any of them
  pulling the exam content bundle (the question banks, lib/tests,
  data/writing-tasks.json) in behind it.
*/
export const MOCK_EXAM_KEY = "bandup-mock-exam-v1";

/**
 * Forgets any in-progress mock exam on this device.
 *
 * The storage event is what makes this visible without a reload: lib/exam/mock
 * .ts holds the sitting in a module-level cache for `useSyncExternalStore`,
 * and a write that goes around that cache is invisible to it until something
 * says to look again — the same trick the progress stores already use.
 */
export function clearMockExamSession(): void {
  removeLearnerItem(MOCK_EXAM_KEY);
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new StorageEvent("storage", { key: MOCK_EXAM_KEY }));
  } catch {
    /* Older or stubbed environments without StorageEvent. The key is gone
       either way, which is the part that matters for the next person here. */
  }
}

/*
  The practice essay somebody is in the middle of, held on the same terms and
  for much the same reason as the sitting above.

  Not in PROGRESS_KEYS either, and for the same distinction: it is a crash
  guard rather than a record of anything, so there is nothing about it worth
  uploading — lib/writing-draft.ts is where what it is for, and when it is
  thrown away, is written down. But like the sitting it is a piece of the
  learner's own work sitting in this browser, so everything below that empties
  their work has to take it too.

  The literal lives here rather than beside the code that writes it for the
  narrower of the two reasons that put MOCK_EXAM_KEY here: clearProgressStore
  below has to be able to drop it, and lib/writing-draft.ts already imports
  this module to read and write it, so declaring it there and importing it back
  would leave these two files importing each other for the sake of one string.
*/
export const WRITING_DRAFT_KEY = "bandup.writing-draft.v1";

/*
  Which account, if any, the progress above belongs to. An ordinary
  learner-data key, deliberately: it should live, migrate and clear exactly
  like the progress it describes, on the same "gone when the tab closes"
  promise made to someone who has not made an account.
*/
const OWNER_KEY = "bandup.progress-owner.v1";

/**
 * Which account's work is currently held in this tab, or null for work done
 * signed out.
 *
 * Null covers both "never set" and "set to an empty string", so a caller only
 * ever has one falsy case to handle rather than two.
 */
export function progressOwner(): string | null {
  const raw = readLearnerItem(OWNER_KEY);
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Records which account the progress in this tab belongs to. Pass null for
 * signed-out work, so the next sign-in knows it is free to adopt it.
 */
export function setProgressOwner(userId: string | null): void {
  if (userId) {
    // No clientUpdatedAt companion key: this marker is a label on the
    // progress, not itself a piece of progress a merge ever compares
    // timestamps against, so it does not need one of its own.
    writeLearnerItem(OWNER_KEY, userId, { clientUpdatedAt: null });
  } else {
    removeLearnerItem(OWNER_KEY);
  }
}

/**
 * Forgets every piece of locally-held progress, and who it belonged to.
 *
 * Built from PROGRESS_KEYS and removeLearnerItem above rather than its own
 * list, so it can never quietly drift from what actually syncs. Note this is
 * not what components/account/ClearDeviceSection.tsx calls for "clear this
 * device" — that clears the whole origin directly, keeping only a short named
 * list — but it is exactly what a sign-out needs (lib/account.ts): everything
 * this tab knows about a learner's work, gone, without also touching the
 * theme or speech preferences a device-clear is careful to keep.
 *
 * The in-progress mock exam goes with it. Signing out is the clearest possible
 * statement that the next person at this browser is not you, and a paper left
 * resumable across that boundary is the one piece of learner work that another
 * person can not merely read but continue — under your name, into your next
 * report, if they sign back in as you never having noticed. It is not in
 * PROGRESS_KEYS because it is not synced (see MOCK_EXAM_KEY above), so it has
 * to be named separately here.
 *
 * Any half-written practice essay goes with it, and needs no more argument
 * than the sitting does: it is unfinished work in somebody's own words, and
 * signing out is where it stops being restorable by whoever sits down next.
 * That the draft is not scoped to an account is precisely why this line has to
 * exist — nothing else about it would notice that the learner had changed.
 */
export function clearProgressStore(): void {
  for (const key of PROGRESS_KEYS) removeLearnerItem(key);
  removeLearnerItem(OWNER_KEY);
  removeLearnerItem(WRITING_DRAFT_KEY);
  clearMockExamSession();
}
