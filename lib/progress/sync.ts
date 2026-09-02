"use client";

import { authedFetch, currentAccountId } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { mergeProfiles, mergeDrillScores, mergeLookups } from "./merge";
import {
  clearMockExamSession,
  learnerItemUpdatedAt,
  PROGRESS_KEYS as KEYS,
  progressOwner,
  readLearnerItem,
  setProgressOwner,
  type ProgressKey as StoreKey,
  writeLearnerItem,
} from "./storage";
import { restoreAcceptedOrganizationHistory } from "@/lib/organizations/history-policy";

/*
  Carrying a learner's progress between their devices.

  The order of operations here is the whole safety argument, so it is written
  out rather than left to be inferred:

    1. Read the account.               Never write first.
    2. Merge it with what is local.    lib/progress/merge.ts, pure and tested.
    3. Write the merged result back.
    4. Write the merged result local.  Last, and only if 3 succeeded.

  Step 1 before step 3 is what makes the second device safe. A client that
  wrote its own state first would replace the other device's work with its own
  and there would be nothing left to merge with.

  Step 4 last is what makes failure safe. The tab's working copy is never
  cleared or narrowed before the account accepts the merge; if any of this
  fails, the browser still holds everything it held before, and the learner
  has lost nothing. That is ACCOUNTS.md threat 5, and it is the reason this
  file returns a result instead of throwing.
*/

/*
  The keys that sync are PROGRESS_KEYS from ./storage, imported above as KEYS
  (and its type as StoreKey) so the rest of this file reads unchanged. That
  file is now the one place the three key names are written down — mirroring
  the CHECK constraint in the schema, as before — so that what syncs and what
  a device-clear or a sign-out wipes cannot quietly name different keys.
*/

/** Where the last successful sync is remembered, so it can be shown. */
const SYNCED_AT = "bandup.sync.v1";
/*
  Whether this device's most recent sync attempt failed to reach the account,
  so a sync that has been silently failing on every attempt is visible on the
  account page instead of merely looking like it has not run in a while.
  Cleared the moment an attempt next succeeds.
*/
const SYNC_FAILED = "bandup.sync-failed.v1";

export type SyncOutcome =
  | {
      status: "done";
      at: string;
      /*
        Whether the account also deleted the underlying progress rows outright,
        rather than merely accepting an emptied/tombstoned payload for them.
        Only ever present when this outcome came from clearSyncedProgress with
        deleteRowsAfterClear set — an ordinary sync never asks for deletion, so
        this stays absent for it, exactly as before this field existed. See the
        SyncOptions comment below and app/api/account/progress/route.ts.
      */
      rowsDeleted?: boolean;
    }
  | { status: "signed-out" }
  | { status: "unavailable" };

export type ClearSyncedProgressOutcome = SyncOutcome | { status: "restricted" };

interface SyncOptions {
  /*
    A device wipe must not destroy the browser copy before the account has
    accepted its history tombstone. Supplying this timestamp makes the sync
    operate on a hypothetical cleared profile; the ordinary working copy is
    only replaced in step 4, after a successful PUT.
  */
  clearHistoryAt?: string;
  /*
    Four more tombstones, one per separately-synced record, none of them
    folded into clearHistoryAt or into each other. clearSyncedProgress below
    is currently the only caller, and it sets every one of these together —
    but they stay four separate fields rather than one boolean, matching how
    they are carried from here on: as four separate fields on the profile
    (placementClearedAt, drillsClearedAt, lookupsClearedAt — see
    lib/types.ts) or, for history, as the emptying of results and mockReports
    themselves. Without a tombstone of its own, a cleared record survives
    untouched on the account and the very next ordinary sync downloads it
    straight back — each of these merges independently of the others, which
    is correct for an unrelated edit to just one of them but was exactly
    wrong for a device clear, first noticed for placement (commit e21c544)
    and now fixed the same way for drills and lookups.
  */
  clearPlacementAt?: string;
  /** Drill scores (bandup.drills.v1) — see clearPlacementAt above. */
  clearDrillsAt?: string;
  /** Saved words (bandup.lookups.v1) — see clearPlacementAt above. */
  clearLookupsAt?: string;
  /*
    Asks the account to delete the drills and lookups rows outright once the
    emptied/tombstoned profile above has been accepted, rather than leave
    them present-but-empty. Deliberately not extended to the profile row
    itself: that row is where placementClearedAt/drillsClearedAt/
    lookupsClearedAt actually live (lib/types.ts), and deleting it would
    delete the very tombstones that stop a device which has not synced since
    the clear from re-uploading its stale copy the next time it does — see
    the WHY note on deleteLearnerProgressRows in lib/cloudflare/data-router.ts.
  */
  deleteRowsAfterClear?: boolean;
}

function readLocal(key: StoreKey): unknown {
  try {
    /*
      Learner work lives in sessionStorage, behind this helper. Reading
      localStorage directly here meant autosync always uploaded an empty
      profile after the storage privacy change, so `visited` never reached the
      account and every new browser showed the "New" badges again.

      The helper also performs the one-time migration from old localStorage
      builds, so sync and the UI now read the exact same working copy.
    */
    const raw = readLearnerItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Unreadable local data is treated as absent rather than as a reason to
    // stop. The account's copy is then the better of the two, which is exactly
    // the case sync exists to rescue.
    return null;
  }
}

function writeLocal(key: StoreKey, value: unknown, clientUpdatedAt: string | null): void {
  try {
    writeLearnerItem(key, JSON.stringify(value), { clientUpdatedAt });
  } catch {
    // Storage full, or private mode. The account holds the merged copy, so the
    // work is safe even though this tab will not show it until it can write.
  }
}

interface Snapshot {
  storeKey: string;
  payload: unknown;
  clientUpdatedAt: string | null;
}

function stampOf(snapshot: Snapshot | undefined): number | null {
  if (!snapshot?.clientUpdatedAt) return null;
  const t = Date.parse(snapshot.clientUpdatedAt);
  return Number.isFinite(t) ? t : null;
}

function stampNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function newestStamp(left: string | null, right: string | null): string | null {
  const leftTime = stampNumber(left);
  const rightTime = stampNumber(right);
  if (leftTime === null) return rightTime === null ? null : right;
  if (rightTime === null) return left;
  return rightTime > leftTime ? right : left;
}

/**
 * Whether any of the four clear tombstones was asked for.
 *
 * One predicate rather than a four-way `||` repeated at each of its call
 * sites below, so the day a fifth tombstone is added there is exactly one
 * place that has to learn about it rather than several that could each learn
 * about it differently.
 */
function isClearRequest(options: SyncOptions): boolean {
  return Boolean(
    options.clearHistoryAt || options.clearPlacementAt
      || options.clearDrillsAt || options.clearLookupsAt,
  );
}

/**
 * Merges this browser's progress with the account's, in both directions.
 *
 * Safe to call more than once, and safe to call on a device with nothing on
 * it: merging an empty browser with a full account yields the full account,
 * and merging a full browser with an empty account yields the browser.
 *
 * Also safe to call when this browser's progress belongs to a *different*
 * account than the one now signed in. That local data is discarded rather
 * than merged or uploaded — this tab ends up holding the newly signed-in
 * account's own copy instead, exactly as if it had never held anything. See
 * the owner marker in lib/progress/storage.ts.
 */
async function syncProgressWithOptions(
  options: SyncOptions = {},
): Promise<ClearSyncedProgressOutcome> {
  if (typeof window === "undefined") return { status: "unavailable" };

  // --- 1. read the account -------------------------------------------------
  let remote: Snapshot[];
  try {
    const res = await authedFetch(apiUrl("/api/account/progress"));
    if (res.status === 401) return { status: "signed-out" };
    if (!res.ok) return { status: "unavailable" };
    const body = (await res.json()) as { snapshots?: Snapshot[] };
    remote = Array.isArray(body.snapshots) ? body.snapshots : [];
  } catch {
    return { status: "unavailable" };
  }

  const bySnapshotKey = new Map(remote.map((s) => [s.storeKey, s]));

  // --- 2. merge ------------------------------------------------------------
  /*
    Whose work is sitting in this tab, and does it match who just signed in?

      owner absent/null   — signed-out work, free to be adopted exactly as
                             before this fix. The real feature this must not
                             break.
      owner === this id   — an ordinary returning sync. Unchanged.
      owner is a different id — a different account's leftovers are sitting
                             here. This is the confirmed leak: none of it may
                             take part in the merge below, be uploaded to this
                             account, or be written back to this tab.

    `localValue`/`localStamp` make the third case true everywhere below by
    making a foreign tab look, to every line that follows, exactly like a tab
    that has never held anything — this file's own merge functions already
    promise that an empty local unioned with a full account yields the full
    account (see the doc comment above), so a foreign owner needs no bespoke
    discard path of its own.
  */
  const signedInAccountId = currentAccountId();
  const owner = progressOwner();
  const foreignOwner = owner !== null && owner !== signedInAccountId;
  const localValue = (key: StoreKey): unknown => (foreignOwner ? null : readLocal(key));
  const localStamp = (key: StoreKey): string | null =>
    foreignOwner ? null : learnerItemUpdatedAt(key);

  const storedLocalProfile = localValue("ielts-prep-v1");
  const storedLocalProfileObject = storedLocalProfile && typeof storedLocalProfile === "object"
    && !Array.isArray(storedLocalProfile)
    ? (storedLocalProfile as Record<string, unknown>)
    : {};
  /*
    Four independent hypothetical edits can each be requested here, and
    deliberately do not imply one another — see the SyncOptions comments
    above. "Clear this device" sets all four together; "Clear all history"
    (components/history/ClearHistoryButton.tsx) never sets any of them at
    all, because it commits the real thing straight to sessionStorage via
    lib/store.ts's clearHistory before calling the ordinary, option-free
    syncProgress — so nothing here needs to build a hypothetical for that
    button, only read back what it already wrote.
  */
  const localProfile = isClearRequest(options)
    ? {
        ...storedLocalProfileObject,
        ...(options.clearHistoryAt
          ? {
              results: [],
              mockReports: [],
              mockRetakes: [],
              historyClearedAt: options.clearHistoryAt,
            }
          : {}),
        ...(options.clearPlacementAt
          ? { placement: undefined, placementClearedAt: options.clearPlacementAt }
          : {}),
        ...(options.clearDrillsAt ? { drillsClearedAt: options.clearDrillsAt } : {}),
        ...(options.clearLookupsAt ? { lookupsClearedAt: options.clearLookupsAt } : {}),
      }
    : storedLocalProfile;
  const localPayload: Record<StoreKey, unknown> = {
    "ielts-prep-v1": localProfile,
    // Emptied the same hypothetical way as results/mockReports/placement
    // above: the real bandup.drills.v1/bandup.lookups.v1 keys are not
    // touched until step 4 accepts the account's answer.
    "bandup.drills.v1": options.clearDrillsAt ? {} : localValue("bandup.drills.v1"),
    "bandup.lookups.v1": options.clearLookupsAt ? {} : localValue("bandup.lookups.v1"),
  };
  const localStamps: Record<StoreKey, string | null> = {
    "ielts-prep-v1": options.clearHistoryAt
      ?? options.clearPlacementAt
      ?? options.clearDrillsAt
      ?? options.clearLookupsAt
      ?? localStamp("ielts-prep-v1"),
    "bandup.drills.v1": options.clearDrillsAt ?? localStamp("bandup.drills.v1"),
    "bandup.lookups.v1": options.clearLookupsAt ?? localStamp("bandup.lookups.v1"),
  };

  const profile = mergeProfiles(
    localPayload["ielts-prep-v1"] as never,
    bySnapshotKey.get("ielts-prep-v1")?.payload as never,
    stampNumber(localStamps["ielts-prep-v1"]),
    stampOf(bySnapshotKey.get("ielts-prep-v1")),
  );
  /*
    mergeProfiles above has already combined this device's and the account's
    drillsClearedAt/lookupsClearedAt (lib/progress/merge.ts) — read the
    answer back off its result rather than recomputing it, so the drills and
    lookups merges below are gated by the exact same tombstone the profile
    itself now carries.
  */
  const drillsClearedAt = stampNumber(profile.drillsClearedAt ?? null);
  const lookupsClearedAt = stampNumber(profile.lookupsClearedAt ?? null);
  const drills = mergeDrillScores(
    localPayload["bandup.drills.v1"] as never,
    bySnapshotKey.get("bandup.drills.v1")?.payload as never,
    drillsClearedAt,
  );
  const lookups = mergeLookups(
    localPayload["bandup.lookups.v1"] as never,
    bySnapshotKey.get("bandup.lookups.v1")?.payload as never,
    300,
    lookupsClearedAt,
  );

  const merged: Record<StoreKey, unknown> = {
    "ielts-prep-v1": profile,
    "bandup.drills.v1": drills,
    "bandup.lookups.v1": lookups,
  };
  const mergedStamps: Record<StoreKey, string | null> = {
    "ielts-prep-v1": newestStamp(
      localStamps["ielts-prep-v1"],
      bySnapshotKey.get("ielts-prep-v1")?.clientUpdatedAt ?? null,
    ),
    "bandup.drills.v1": newestStamp(
      localStamps["bandup.drills.v1"],
      bySnapshotKey.get("bandup.drills.v1")?.clientUpdatedAt ?? null,
    ),
    "bandup.lookups.v1": newestStamp(
      localStamps["bandup.lookups.v1"],
      bySnapshotKey.get("bandup.lookups.v1")?.clientUpdatedAt ?? null,
    ),
  };

  // --- 3. write it to the account ------------------------------------------
  // `at` is only ever set once the account has actually confirmed the write.
  // Its presence is what step 4 below uses to tell a confirmed sync from a
  // merge that only made it as far as this device.
  let at: string | null = null;
  const accepted: Record<StoreKey, Snapshot> = Object.fromEntries(
    KEYS.map((storeKey) => [storeKey, {
      storeKey,
      payload: merged[storeKey],
      clientUpdatedAt: mergedStamps[storeKey],
    }]),
  ) as Record<StoreKey, Snapshot>;
  let historyProtected = false;
  /*
    Whether the account deleted the underlying rows as well as accepting the
    emptied ones. Only ever true for a clear that asked for it; a route that
    could not delete says so, and this stays false, which is the caller's cue
    that the clear degraded to the emptied-row behaviour rather than failed.
  */
  let rowsDeleted = false;
  try {
    const res = await authedFetch(apiUrl("/api/account/progress"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      /*
        The four tombstones ride up inside the profile payload rather than as
        fields of their own on this body. They are part of the profile — that
        is the whole point of Profile.drillsClearedAt and
        Profile.lookupsClearedAt existing (lib/types.ts) — and mergeProfiles
        above has already folded this device's into whatever the account
        held, so `merged["ielts-prep-v1"]` is exactly the set of tombstones
        being asserted. app/api/account/progress/route.ts reads them back off
        that merged profile and applies them to the drills and lookups rows,
        which is what stops the account's second merge handing back the
        scores and words this device just emptied.

        deleteRows is the one thing that cannot ride on a payload, because it
        is a request about the rows rather than about their contents. The
        route honours it only after its own compare-and-swap has committed,
        and never for a protected organisation student.
      */
      body: JSON.stringify({
        snapshots: KEYS.map((storeKey) => ({
          storeKey,
          payload: merged[storeKey],
          clientUpdatedAt: mergedStamps[storeKey],
        })),
        ...(options.deleteRowsAfterClear ? { deleteRows: true } : {}),
      }),
    });
    if (res.status === 401) return { status: "signed-out" };
    if (!res.ok) {
      /*
        This used to return { status: "unavailable" } here, which discarded
        the merge above along with everything step 1 had just fetched from the
        account — so a device that could download fine but not upload showed
        nothing at all rather than merely lagging. `merged` is local unioned
        with the account, a superset of what this device already had, so
        falling through to step 4 and writing it locally can only add to this
        device's copy, never remove from it.

        A clear is the one case that must keep returning immediately.
        `accepted` still holds the *hypothetical* cleared profile built in
        step 2, and this device's real history, placement, drill scores and
        saved words must not be replaced by that unless the account actually
        accepted the clear — see the guard below step 4. isClearRequest
        covers all four tombstones, so a clear that only carried the two new
        ones would be guarded exactly as the original two are.
      */
      if (isClearRequest(options)) return { status: "unavailable" };
    } else {
      const response = (await res.json()) as {
        at?: string;
        snapshots?: { storeKey?: unknown; payload?: unknown; clientUpdatedAt?: unknown }[];
        historyProtected?: unknown;
        rowsDeleted?: unknown;
      };
      // Bound to its own const, rather than read back off `at` below: `at` is
      // now `string | null` for the failure path above, and a closure is not
      // guaranteed to see the narrowing from the assignment that follows.
      const confirmedAt = response.at ?? new Date().toISOString();
      at = confirmedAt;
      historyProtected = response.historyProtected === true;
      rowsDeleted = response.rowsDeleted === true;
      if (Array.isArray(response.snapshots)) {
        const serverAccepted = new Map<StoreKey, Snapshot>(
          response.snapshots.flatMap((snapshot) =>
            typeof snapshot.storeKey === "string" && KEYS.includes(snapshot.storeKey as StoreKey)
              ? [[snapshot.storeKey as StoreKey, {
                  storeKey: snapshot.storeKey,
                  payload: snapshot.payload,
                  clientUpdatedAt: typeof snapshot.clientUpdatedAt === "string"
                    ? snapshot.clientUpdatedAt
                    : confirmedAt,
                }] as const]
              : [],
          ),
        );
        for (const key of KEYS) {
          accepted[key] = serverAccepted.get(key) ?? {
            storeKey: key,
            payload: merged[key],
            clientUpdatedAt: confirmedAt,
          };
        }
      }
    }
  } catch {
    return { status: "unavailable" };
  }

  /*
    Membership can change between rendering the clear control and submitting
    it. The server is authoritative. If it protected organisation-linked
    history, leave the browser untouched too instead of presenting a clear
    that the next sync would immediately undo.
  */
  if (isClearRequest(options) && historyProtected) {
    return { status: "restricted" };
  }

  // --- 4. and only then to this browser ------------------------------------
  /*
    Last on purpose. Everything above can fail without the learner losing
    anything, because until this line runs the browser still holds exactly what
    it held before. Writing here first would mean a failed upload had already
    rewritten local state with a merge nobody had accepted.
  */
  /*
    A learner can finish or delete something while the GET/PUT above is in
    flight. Writing the earlier merge verbatim here would roll that newer
    action back in this tab before autosync gets its promised second pass.

    Merge once more with the *current* working copy before touching storage.
    The next scheduled pass uploads these late changes; this pass merely makes
    sure downloading the account can never undo them locally.

    `localValue`/`localStamp` still guard this re-read for a foreign owner,
    and deliberately: a write that raced in during this round trip belongs to
    whoever the owner marker said this tab belonged to when it happened, and
    that is the same account already being discarded above. Re-reading actual
    sessionStorage here for that case would let it back in through the one
    door left open for "late changes", which defeats the point of discarding
    it in step 2.
  */
  /*
    The same two tombstones step 2 read off the first merge, re-read off what
    the account actually accepted. Without them this last merge would union
    the emptied drills and lookups with the copies still sitting in this tab
    and put every cleared score and word straight back — this device undoing
    its own clear one line after the account agreed to it.
  */
  const acceptedProfile = accepted["ielts-prep-v1"].payload as {
    drillsClearedAt?: string;
    lookupsClearedAt?: string;
  } | null;
  const acceptedDrillsClearedAt = stampNumber(acceptedProfile?.drillsClearedAt ?? null);
  const acceptedLookupsClearedAt = stampNumber(acceptedProfile?.lookupsClearedAt ?? null);
  const latest: Record<StoreKey, unknown> = {
    "ielts-prep-v1": mergeProfiles(
      (historyProtected
        ? restoreAcceptedOrganizationHistory(
            localValue("ielts-prep-v1"),
            accepted["ielts-prep-v1"].payload,
          )
        : localValue("ielts-prep-v1")) as never,
      accepted["ielts-prep-v1"].payload as never,
      stampNumber(localStamp("ielts-prep-v1")),
      stampOf(accepted["ielts-prep-v1"]),
    ),
    "bandup.drills.v1": mergeDrillScores(
      localValue("bandup.drills.v1") as never,
      accepted["bandup.drills.v1"].payload as never,
      acceptedDrillsClearedAt,
    ),
    "bandup.lookups.v1": mergeLookups(
      localValue("bandup.lookups.v1") as never,
      accepted["bandup.lookups.v1"].payload as never,
      300,
      acceptedLookupsClearedAt,
    ),
  };
  for (const key of KEYS) {
    writeLocal(
      key,
      latest[key],
      newestStamp(localStamp(key), accepted[key].clientUpdatedAt),
    );
  }
  /*
    The in-progress mock exam, dropped here and only here on this path:
    after the account has accepted the clear, alongside the writes that
    commit it locally.

    It is not one of KEYS — a half-finished paper is not synced progress, and
    nothing above uploads it. But it is the one piece of learner work another
    person at this browser could not merely read but *continue*, so a clear
    that left it resumable would not be a clear. Doing it here rather than in
    components/account/ClearDeviceSection.tsx, which goes on to wipe the whole
    origin anyway, is what keeps it true when that wipe is the part that
    fails: storage can be full or blocked, and this has already run.
  */
  if (isClearRequest(options)) clearMockExamSession();
  /*
    Every branch that reaches this line — adopting signed-out work for the
    first time, an ordinary same-account sync, or a foreign owner's leftovers
    just discarded above — ends with this tab holding data the signed-in
    account is entitled to see, which makes this the one place that also
    needs to say whose it now is. Stamping it here, right next to the loop
    that already funnels every progress write for this call, means the marker
    cannot fall out of step with what was actually written the way a copy of
    this call pasted at each early return above could.

    This runs even when `at` is still null — an unconfirmed PUT, see step 3 —
    because the merge just written locally is already a superset of what this
    tab had, built from a GET that did succeed and did prove which account
    this is. Waiting for a confirmed PUT before marking ownership would leave
    every device stuck behind production's currently-failing write RPC
    unmarked indefinitely (see commit 7df422e), which is exactly the gap a
    second account signing into the same browser could still walk through.
  */
  setProgressOwner(signedInAccountId);
  // Only a confirmed write earns a "last synced" time. A PUT that failed
  // reaches this point too now (see step 3), and must not claim a sync that
  // did not happen — that is what the account page reads to say a device is
  // up to date, and a merge sitting only in this browser is not that.
  if (at) {
    try {
      // This timestamp is a device preference/status line, not learner work, so
      // it deliberately remains durable across tabs.
      window.localStorage.setItem(SYNCED_AT, at);
    } catch {
      // Cosmetic only — it drives the "last synced" line on the account page.
    }
  }

  /*
    The stores are read through useSyncExternalStore and cache their snapshots,
    so a write that goes around them is invisible until something tells them to
    look again. `storage` normally only fires in *other* tabs; dispatching it
    here makes this tab re-read too, which is what repaints the plan and the
    saved words without a reload.
  */
  for (const key of KEYS) {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }
  if (at) window.dispatchEvent(new StorageEvent("storage", { key: SYNCED_AT }));

  // A failed PUT falls all the way through to here now, with `at` left null —
  // see the WHY comment in step 3. The merge has been written locally either
  // way; only the reported status differs.
  return at
    ? { status: "done", at, ...(options.deleteRowsAfterClear ? { rowsDeleted } : {}) }
    : { status: "unavailable" };
}

export async function syncProgress(): Promise<SyncOutcome> {
  const outcome = await syncProgressWithOptions();
  rememberSyncHealth(outcome);
  // `restricted` is only produced when clearHistoryAt is supplied. Keep the
  // public autosync result narrow, with a defensive fallback if that invariant
  // is ever changed.
  return outcome.status === "restricted" ? { status: "unavailable" } : outcome;
}

/**
 * Permanently clear sitting history from a signed-in account without first
 * mutating this browser's working copy.
 *
 * If the request fails, local practice remains available. If the server
 * accepted the tombstone but its response was lost, a later ordinary sync
 * will observe that durable tombstone and converge on the cleared state.
 */
export async function clearSyncedProgress(
  at = new Date().toISOString(),
): Promise<ClearSyncedProgressOutcome> {
  /*
    "Clear this device" sets all four tombstones together, at one instant —
    see the SyncOptions comments above for why they remain four options and
    not one. Sharing the instant rather than taking a `new Date()` per
    tombstone is what stops a record written during the clear landing on the
    cleared side of one stamp and the surviving side of another.

    deleteRowsAfterClear asks the account to drop the emptied drills and
    lookups rows outright once it has accepted this. It is a request, not a
    condition: an account that accepts the clear but cannot delete the rows
    still returns "done", with rowsDeleted false, because the rows are empty
    and tombstoned either way and telling a learner nothing was cleared would
    be the false half of a true story.
  */
  const outcome = await syncProgressWithOptions({
    clearHistoryAt: at,
    clearPlacementAt: at,
    clearDrillsAt: at,
    clearLookupsAt: at,
    deleteRowsAfterClear: true,
  });
  rememberSyncHealth(outcome);
  return outcome;
}

/*
  Recorded once, here, so both public entry points above leave the same
  trail behind: a device that cannot sync should say so on the account page
  whether the failing attempt was an ordinary autosync pass or a history
  clear. `restricted` counts as reaching the account — the server gave a real
  answer, it just declined the clear on policy grounds, which is not an
  outage. `signed-out` touches neither flag: an expired token is neither new
  evidence the write pipeline is broken nor evidence that a previous failure
  is now fixed, so whatever was last recorded is left standing until an
  attempt actually resolves it one way or the other.
*/
function rememberSyncHealth(outcome: ClearSyncedProgressOutcome): void {
  if (typeof window === "undefined" || outcome.status === "signed-out") return;
  try {
    if (outcome.status === "unavailable") window.localStorage.setItem(SYNC_FAILED, "1");
    else window.localStorage.removeItem(SYNC_FAILED);
  } catch {
    // Cosmetic only, exactly like the SYNCED_AT write in step 4 above.
  }
  window.dispatchEvent(new StorageEvent("storage", { key: SYNC_FAILED }));
}

/** When this browser last completed a sync, or null. */
export function lastSyncedAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SYNCED_AT);
  } catch {
    return null;
  }
}

/** Whether this browser's most recent sync attempt failed to reach the account. */
export function lastSyncFailed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SYNC_FAILED) === "1";
  } catch {
    return false;
  }
}

/**
 * Subscribes to changes in this device's sync status, for `useSyncExternalStore`.
 *
 * The same trick lib/store.ts and lib/account.ts use: a real `storage` event
 * only reaches *other* tabs, so the writes above dispatch a synthetic one on
 * this tab too. Without this, the account page would only ever show the sync
 * status as it stood at the moment the page was loaded, not the moment a
 * background autosync actually succeeded or started failing.
 */
export function subscribeSyncStatus(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === SYNCED_AT || e.key === SYNC_FAILED || e.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
