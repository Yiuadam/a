import {
  WRITING_DRAFT_KEY,
  readLearnerItem,
  removeLearnerItem,
  writeLearnerItem,
} from "@/lib/progress/storage";

/*
  The half-written practice essay, kept where an accident cannot take it.

  ---------------------------------------------------------------------------
  A crash guard, not a drafts feature

  This exists for one failure and should not be read as more than that. A Task 2
  essay is twenty minutes of somebody's evening typed into a textarea, and until
  now it lived in React state alone: a pulled-to-refresh, a phone locking, a
  background tab the browser reclaimed to free memory, and it was gone with
  nothing to go back to. The mock sitting has always stored its answers as they
  are typed for exactly this reason; practice simply never did.

  So what this is for is the accident, and the owner said as much when asking
  for it — the autosave is there to survive a refresh or a tab going away. It is
  deliberately not a place where work accumulates. There is no draft list, no
  screen that announces an unfinished essay, nothing that follows a learner to
  another device. One slot per task, restored in silence by the same screen that
  wrote it, and thrown away the moment the learner is done with it: they submit,
  or they leave for somewhere that is not the writing paper.

  ---------------------------------------------------------------------------
  sessionStorage, on the promise the rest of the learner's work is kept on

  Through lib/progress/storage.ts, which explains at length why a learner's own
  work is per-tab rather than durable, and an essay is the most personal thing
  in that category. The cost is worth stating plainly rather than discovering: a
  tab that is genuinely closed and never restored takes the draft with it.

  What that leaves is still the case this was asked for. A reload keeps
  sessionStorage; so does a phone that locks and wakes; so does a background tab
  that iOS reclaims and reloads when you come back to it, which is the single
  most common way this app loses work on a phone. localStorage would additionally
  survive a closed tab, at the price of leaving somebody's essay sitting on a
  shared or borrowed computer indefinitely — the trade lib/progress/storage.ts
  already refused for every other piece of learner work, and there is no reason
  for an unfinished essay to be the exception.

  ---------------------------------------------------------------------------
  Not account-scoped, and that is a decision

  Nothing here knows or cares who is signed in, the same way the mock sitting
  does not. A guard meant to cover the minutes between a keystroke and an
  accident does not need to follow an account across devices, and making it do
  so would turn it into the resumable-drafts feature this is explicitly not.

  Signing out still takes it, along with everything else this tab holds — see
  clearProgressStore in lib/progress/storage.ts. That is not account scoping; it
  is the same rule the mock exam is cleared under, which is that signing out is
  the clearest possible statement that the next person at this browser is not
  you.

  ---------------------------------------------------------------------------
  Why a draft expires, and why twelve hours

  A restore is a rescue when it lands on the essay you were writing, and a
  surprise when it lands on a task you have moved on from — an unexpected wall
  of your own old prose in a box you expected to be empty. sessionStorage
  already ends the draft when the tab does, so the window here only has to cover
  the ways a tab can outlive the sitting. An essay begun late, a phone locked
  overnight and picked up at breakfast is the long end of what this is for;
  beyond that it is a different day's work and better gone.

  ---------------------------------------------------------------------------
  One key, every task's slot inside it

  Task 1 and Task 2 are one tap apart on the practice page, and switching
  between them must not cost the other one's draft — so a draft is keyed by
  task. Holding them as a map under a single key rather than a key per task
  keeps that promise without anything downstream ever having to sweep storage
  for keys by prefix, which is what a sign-out and a clear would otherwise have
  to do to be sure they had taken them all.
*/

/** How long a draft may sit before a restore would be a surprise. */
export const DRAFT_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * How long the page waits after the last keystroke before writing.
 *
 * Long enough that a fast typist causes one write per pause for breath rather
 * than one per letter, and short enough that all an accident can take is the
 * tail of a word. Exported so the page and the tests share one number.
 */
export const AUTOSAVE_DELAY_MS = 500;

interface Draft {
  text: string;
  savedAt: number;
}

interface DraftFile {
  version: 1;
  drafts: Record<string, Draft>;
}

/**
 * Every unexpired draft in this tab, keyed by task id.
 *
 * Expired and malformed entries are dropped on the way out rather than
 * repaired. A draft is a copy of something the learner has, or had, in front of
 * them; there is nothing here worth salvaging half of.
 */
function read(now: number): Record<string, Draft> {
  const raw = readLearnerItem(WRITING_DRAFT_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as DraftFile | null;
    if (!parsed || parsed.version !== 1 || !parsed.drafts) return {};

    const kept: Record<string, Draft> = {};
    for (const [taskId, draft] of Object.entries(parsed.drafts)) {
      if (typeof draft?.text !== "string" || typeof draft?.savedAt !== "number") continue;
      /*
        Age rather than a stored expiry date, and a draft from the future is
        kept. A device whose clock jumped backwards over a timezone or a manual
        correction would otherwise throw away work that is minutes old, and
        between the two ways of being wrong the forgiving one is the one that
        does not delete an essay.
      */
      if (now - draft.savedAt >= DRAFT_LIFETIME_MS) continue;
      kept[taskId] = draft;
    }
    return kept;
  } catch {
    return {};
  }
}

function write(drafts: Record<string, Draft>): void {
  if (Object.keys(drafts).length === 0) {
    removeLearnerItem(WRITING_DRAFT_KEY);
    return;
  }

  /*
    No companion timestamp: that stamp exists so account sync can tell which
    side of a merge is newer, and nothing about a draft is ever synced or
    merged. Its own savedAt is what the expiry above reads.
  */
  const file: DraftFile = { version: 1, drafts };
  writeLearnerItem(WRITING_DRAFT_KEY, JSON.stringify(file), { clientUpdatedAt: null });
}

/**
 * What was being typed for this task, or an empty string.
 *
 * Empty covers every way there is nothing to restore — never written, already
 * submitted, expired, storage blocked, storage corrupt — because the caller has
 * exactly one thing to do with all of them, which is show an empty box.
 */
export function loadWritingDraft(taskId: string, now: number = Date.now()): string {
  return read(now)[taskId]?.text ?? "";
}

/**
 * Records what is currently in the box for this task.
 *
 * An essay emptied back to nothing removes the slot rather than storing a blank
 * one. Somebody who selects all and deletes has said what they want restored,
 * and a page that has been opened and not typed into should leave no trace at
 * all.
 *
 * Storage failure is silent by way of lib/progress/storage.ts, which is the
 * only correct behaviour here: the live copy of the essay is the one in React
 * state on screen, and a private-mode browser that refuses the write must cost
 * the learner a guard they did not know they had rather than the page they are
 * typing into.
 */
export function saveWritingDraft(taskId: string, text: string, now: number = Date.now()): void {
  const drafts = read(now);

  if (text.trim() === "") {
    if (!(taskId in drafts)) return;
    delete drafts[taskId];
  } else {
    drafts[taskId] = { text, savedAt: now };
  }

  write(drafts);
}

/** Forgets one task's draft, leaving the other task's alone. For submitting. */
export function discardWritingDraft(taskId: string, now: number = Date.now()): void {
  const drafts = read(now);
  if (!(taskId in drafts)) return;
  delete drafts[taskId];
  write(drafts);
}

/**
 * Forgets every practice writing draft in this tab.
 *
 * What a deliberate departure calls: the learner has gone back to the homepage
 * or anywhere else outside the writing paper, so both tasks are finished with,
 * not just the one that happened to be on screen. See the effect cleanup in
 * app/practice/writing/page.tsx for how a departure is told apart from a
 * reload, which must never reach here.
 */
export function discardWritingDrafts(): void {
  removeLearnerItem(WRITING_DRAFT_KEY);
}
