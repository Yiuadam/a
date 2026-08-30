import { after, NextResponse } from "next/server";
import {
  isProgressKey,
  organizationHistoryClearPolicy,
} from "@/lib/auth/supabase";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { cloudflareHistoryClearAllowed } from "@/lib/cloudflare/organizations";
import {
  getLearnerProgressSnapshots,
  compareAndSwapLearnerProgressSnapshots,
  deleteLearnerProgressRows,
} from "@/lib/cloudflare/data-router";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import {
  organizationAttempts,
  organizationHistoryClearWatermark,
  syncOrganizationAttempts,
} from "@/lib/organizations/server";
import {
  drainCloudflareOrganizationAttemptOutbox,
  enqueueCloudflareOrganizationAttemptSync,
} from "@/lib/cloudflare/organization-attempt-outbox";
import { reconcileOrganizationAttemptObjects } from "@/lib/cloudflare/organization-attempt-objects";
import {
  mergeProgressSnapshotPayload,
  progressClearTombstones,
} from "@/lib/progress/server-snapshots";

type ClearTombstones = ReturnType<typeof progressClearTombstones>;

/*
  Reading and writing a signed-in learner's synced progress.

  Two rules shape this route, both from ACCOUNTS.md threat 5.

  It is signed-in only, with no anonymous fallback. Everywhere else in this
  system anonymous is an ordinary state to handle gracefully; here there is
  nothing to read and nowhere to write, and pretending otherwise would mean
  inventing an identity for someone who has not got one.

  The client performs the first merge because only it can see this browser's
  storage. The server performs the merge again against the latest committed
  account rows and uses compare-and-swap. That second merge closes the window
  where two devices both read the same old account and then overwrite each
  other in arrival order.
*/

export const dynamic = "force-dynamic";

/* Detailed sitting reviews include essays, transcripts and question wording.
   Two megabytes holds the complete 100-result archive while still putting a
   firm ceiling on the only endpoint that accepts arbitrary account JSON. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COMMIT_ATTEMPTS = 4;

interface SubmittedProgressSnapshot {
  storeKey: string;
  payload: unknown;
  clientUpdatedAt: string | null;
}

function submittedProgressSnapshots(value: unknown): SubmittedProgressSnapshot[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const parsed: SubmittedProgressSnapshot[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    const row = (entry ?? {}) as {
      storeKey?: unknown;
      payload?: unknown;
      clientUpdatedAt?: unknown;
    };
    if (!isProgressKey(row.storeKey) || row.payload === undefined || keys.has(row.storeKey)) {
      return null;
    }
    let clientUpdatedAt: string | null = null;
    if (row.clientUpdatedAt !== undefined && row.clientUpdatedAt !== null) {
      if (typeof row.clientUpdatedAt !== "string"
        || !Number.isFinite(Date.parse(row.clientUpdatedAt))) {
        return null;
      }
      clientUpdatedAt = new Date(row.clientUpdatedAt).toISOString();
    }
    keys.add(row.storeKey);
    parsed.push({
      storeKey: row.storeKey,
      payload: row.payload,
      clientUpdatedAt,
    });
  }
  return parsed;
}

/*
  A stable, machine-readable partner to the human message below. Without this
  a client sees a bare 413 or 503 and cannot tell a request that was simply
  too big apart from a policy check that could not run or an atomic write
  that failed — three different situations, one indistinguishable response.
  `reason` is always one of the fixed strings in the type below, chosen here
  by the route itself; it must never carry an upstream error's own text, or
  this would defeat the whole point of safeJsonError's messages in the first
  place (see lib/auth/errors.ts) by leaking database detail through a
  different field instead.
*/
type ProgressFailureReason = "too-large" | "history-policy-unavailable" | "write-unavailable";

function progressFailure(
  message: string,
  status: number,
  reason: ProgressFailureReason,
): NextResponse {
  return NextResponse.json(
    { error: message, reason },
    {
      status,
      // Matches safeJsonError's header exactly — this response carries the
      // same identity-specific state and needs the same protection.
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

async function requireUser(req: Request) {
  if (!accountRuntimeEnabled()) return { error: "off" as const };
  const user = await getSessionUser(req);
  if (!user) return { error: "anon" as const };
  return { user };
}

async function handleGET(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const rows = await getLearnerProgressSnapshots(auth.user);
  if (rows === null) {
    logInternal("account/progress GET", new Error("snapshot read failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  if (organizationDataMode() !== "supabase") {
    after(async () => {
      // The primary snapshot is the durable repair source. Re-enqueue it on
      // every signed-in read so a D1 outage during the original PUT heals even
      // when the learner only comes back to review their work.
      const profile = rows.find((row) => row.storeKey === "ielts-prep-v1");
      const attempts = organizationAttempts(
        (profile?.payload as { results?: unknown } | undefined)?.results,
      );
      const historyClearedAt = organizationHistoryClearWatermark(profile?.payload);
      if (attempts.length > 0 || historyClearedAt !== null) {
        await enqueueCloudflareOrganizationAttemptSync(
          auth.user,
          attempts,
          `progress-read-repair:${auth.user.id}:${crypto.randomUUID()}`,
          historyClearedAt,
        ).catch((error) => logInternal("account/progress organization read repair", error));
      }
      await drainCloudflareOrganizationAttemptOutbox({ userId: auth.user.id, limit: 2 })
        .catch((error) => logInternal("account/progress organization read drain", error));
      await reconcileOrganizationAttemptObjects(undefined, { limit: 8 })
        .catch((error) => logInternal("account/progress organization read cleanup", error));
    });
  }

  return NextResponse.json({
    snapshots: rows.map((r) => ({
      storeKey: r.storeKey,
      payload: r.payload,
      clientUpdatedAt: r.clientUpdatedAt,
    })),
  });
}

async function handlePUT(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const raw = await req.text();
  /*
    A cap, because this is the one route a client can post arbitrary JSON to.
    Two megabytes holds all three browser progress keys, including saved
    reviews, while remaining far less than enough to be useful as unrelated
    storage.
  */
  if (raw.length > MAX_BYTES) {
    return progressFailure(
      "That's more progress than we can store. Please contact support.",
      413,
      "too-large",
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  const submittedSnapshots = submittedProgressSnapshots(
    (body as { snapshots?: unknown })?.snapshots,
  );
  if (!submittedSnapshots) {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  const receivedAt = new Date().toISOString();
  const clearPolicy = organizationDataMode() === "cloudflare"
    ? await cloudflareHistoryClearAllowed(auth.user)
        .then((allowed) => allowed ? "allowed" as const : "restricted" as const)
        .catch(() => "unavailable" as const)
    : await organizationHistoryClearPolicy(auth.user.id);
  if (clearPolicy === "unavailable") {
    return progressFailure(
      "History permissions could not be checked. Nothing was changed.",
      503,
      "history-policy-unavailable",
    );
  }
  const restrictedHistory = clearPolicy === "restricted";
  let acceptedSnapshots: {
    storeKey: string;
    payload: unknown;
    clientUpdatedAt: string;
  }[] | null = null;
  let stamp = receivedAt;

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const existing = await getLearnerProgressSnapshots(auth.user);
    if (existing === null) {
      logInternal("account/progress PUT", new Error("snapshot read failed before atomic write"));
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }
    const existingByKey = new Map(existing.map((row) => [row.storeKey, row]));
    const expected = submittedSnapshots.map((entry) => {
      const previous = existingByKey.get(entry.storeKey);
      return {
        storeKey: entry.storeKey,
        exists: previous !== undefined,
        payload: previous?.payload ?? null,
        clientUpdatedAt: previous?.clientUpdatedAt ?? null,
      };
    });
    const mergeOne = (entry: SubmittedProgressSnapshot, tombstones?: ClearTombstones) => {
      const previous = existingByKey.get(entry.storeKey);
      const submittedAt = entry.clientUpdatedAt
        ? Date.parse(entry.clientUpdatedAt)
        : Date.parse(receivedAt);
      const storedAt = previous?.clientUpdatedAt
        ? Date.parse(previous.clientUpdatedAt)
        : null;
      return {
        storeKey: entry.storeKey,
        payload: mergeProgressSnapshotPayload(
          entry.storeKey,
          entry.payload,
          previous?.payload,
          submittedAt,
          storedAt,
          restrictedHistory,
          tombstones,
        ),
      };
    };
    /*
      The profile goes first, alone, because the other two keys depend on its
      answer. drillsClearedAt and lookupsClearedAt are submitted on the
      profile but govern bandup.drills.v1 and bandup.lookups.v1 (lib/types.ts
      explains why they cannot live on the records they govern), so those two
      merges cannot be run until this one has decided which tombstones were
      actually accepted — which, for a restricted organisation student, is
      none of the submitted ones.

      When this PUT carries no profile at all — nothing in the client does
      that today, but the route accepts any one to three keys — the account's
      own stored profile answers instead, so a device that uploads only its
      drills still has a clear from another device applied to them.
    */
    const submittedProfile = submittedSnapshots.find(
      (entry) => entry.storeKey === "ielts-prep-v1",
    );
    const mergedProfile = submittedProfile ? mergeOne(submittedProfile) : null;
    const tombstones = progressClearTombstones(
      mergedProfile
        ? mergedProfile.payload
        : existingByKey.get("ielts-prep-v1")?.payload,
    );
    const merged = submittedSnapshots.map((entry) => (
      entry === submittedProfile && mergedProfile
        ? mergedProfile
        : mergeOne(entry, tombstones)
    ));
    const write = await compareAndSwapLearnerProgressSnapshots(
      auth.user,
      expected,
      merged,
    );
    if (write.status === "conflict") continue;
    if (write.status === "unavailable") {
      logInternal("account/progress PUT", new Error("atomic snapshot write failed"));
      return progressFailure(MESSAGES.accountUnavailable, 503, "write-unavailable");
    }
    if (write.cloudflareReplica === false) {
      logInternal(
        "account/progress Cloudflare replica",
        new Error("Cloudflare progress batch replication failed"),
      );
    }
    stamp = write.at;
    acceptedSnapshots = merged.map((entry) => ({
      ...entry,
      clientUpdatedAt: write.at,
    }));
    break;
  }

  if (!acceptedSnapshots) {
    logInternal("account/progress PUT", new Error("progress remained busy after atomic retries"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  const written = acceptedSnapshots.length;

  /*
    Deleting the rows a clear just emptied.

    An emptied row is not the same as no row. "Delete everything" that leaves
    `{}` sitting in the account under this learner's id is a promise half
    kept: the data is gone but the record of them having had it is not, and
    on an app heading for the App Store that is the difference between a
    deletion and a redaction.

    Three rules hold this in place, and each is load-bearing:

      Only after the account accepted the clear. This runs below the
        compare-and-swap loop, which has by now committed the emptied,
        tombstoned payload; a delete that ran before it could take a row the
        write then failed to replace, which is data loss dressed as a
        feature.

      Never for a protected organisation student. restrictedHistory means
        the merge above deliberately kept their history, so there is nothing
        here that was cleared and nothing to delete. Without this line a
        student's bypassed clear would be refused by the merge and then
        granted by the delete.

      Never the profile row. That row is where historyClearedAt,
        placementClearedAt, drillsClearedAt and lookupsClearedAt now live
        (lib/types.ts). Deleting it would delete the tombstones themselves,
        and the next sync from a device that had not heard about the clear
        would re-upload its stale copy into an account with nothing left to
        refuse it — a delete that undoes itself. Those two rows carry no
        tombstone of their own, so they can go outright.

    A failure here is reported, not raised. The rows are already empty and
    already tombstoned, which is exactly the behaviour that shipped before
    this existed; turning that into a 503 would tell a learner nothing was
    cleared when in truth almost all of it was. `rowsDeleted: false` says
    which of the two happened without pretending either way.
  */
  const deleteRows = (body as { deleteRows?: unknown })?.deleteRows === true;
  const deletableRows = ["bandup.drills.v1", "bandup.lookups.v1"] as const;
  let rowsDeleted = false;
  if (deleteRows && !restrictedHistory) {
    rowsDeleted = await deleteLearnerProgressRows(auth.user, [...deletableRows])
      .catch(() => false);
    if (!rowsDeleted) {
      logInternal(
        "account/progress row delete",
        new Error("cleared progress rows could not be deleted; emptied rows remain"),
      );
    }
    // Whatever survives in the account is what the client must be told it
    // has, or its local merge in step 4 works from a payload the account
    // never held. A successful delete leaves nothing, so the accepted
    // snapshots for those keys are emptied to match.
    if (rowsDeleted) {
      acceptedSnapshots = acceptedSnapshots.map((entry) => (
        (deletableRows as readonly string[]).includes(entry.storeKey)
          ? { ...entry, payload: {} }
          : entry
      ));
    }
  }

  /*
    The learner snapshot is the primary write and remains completely usable if
    the organization ledger is unavailable. Once that write has succeeded,
    copy only normalized completed attempts into the durable ledger after the
    response. This makes organization reporting additive rather than a new
    failure mode for ordinary progress sync.

    The database RPC is idempotent and owns the transaction/permissions. A
    retry can therefore repeat this whole batch without duplicating a sitting.
  */
  let profileEntry = acceptedSnapshots.find(
    (entry) => (entry as { storeKey?: unknown })?.storeKey === "ielts-prep-v1",
  ) as { payload?: { results?: unknown } } | undefined;
  let organizationSourceReadFailed = false;
  if (!profileEntry) {
    // Re-read the durable primary on every non-profile PUT. Besides handling
    // this request, that makes any earlier best-effort organization enqueue
    // outage self-healing the next time this account saves anything.
    const primarySnapshots = await getLearnerProgressSnapshots(auth.user);
    if (primarySnapshots === null) {
      organizationSourceReadFailed = true;
      logInternal(
        "account/progress organization source read",
        new Error("primary progress could not be read for organization repair"),
      );
    } else {
      profileEntry = primarySnapshots.find((entry) => entry.storeKey === "ielts-prep-v1") as
        | { payload?: { results?: unknown } }
        | undefined;
    }
  }
  const attempts = organizationAttempts(profileEntry?.payload?.results);
  const historyClearedAt = organizationHistoryClearWatermark(profileEntry?.payload);
  let organizationSync: "not-needed" | "queued" | "retry-scheduled" =
    organizationSourceReadFailed ? "retry-scheduled" : "not-needed";
  if (attempts.length > 0 || historyClearedAt !== null) {
    const idempotencyKey = `progress:${auth.user.id}:${crypto.randomUUID()}`;
    let queued = organizationDataMode() === "supabase";
    if (organizationDataMode() !== "supabase") {
      try {
        await enqueueCloudflareOrganizationAttemptSync(
          auth.user,
          attempts,
          idempotencyKey,
          historyClearedAt,
        );
        queued = true;
        organizationSync = "queued";
      } catch (error) {
        organizationSync = "retry-scheduled";
        logInternal("account/progress organization outbox", error);
      }
    }
    after(async () => {
      const copied = await syncOrganizationAttempts(
        auth.user,
        attempts,
        idempotencyKey,
        historyClearedAt,
      );
      if (!copied) {
        logInternal(
          "account/progress organization attempt copy",
          new Error("organization attempt sync failed after primary snapshot write"),
        );
      }
      // A true cross-provider transaction is impossible while Supabase is the
      // learner primary. If both the immediate queue write and direct copy
      // missed, re-read the accepted primary and make one more idempotent
      // attempt. A later PUT repeats this repair again if the outage persists.
      if (!copied && !queued) {
        const latest = await getLearnerProgressSnapshots(auth.user).catch(() => null);
        const latestProfile = latest?.find((entry) => entry.storeKey === "ielts-prep-v1");
        const retryAttempts = organizationAttempts(
          (latestProfile?.payload as { results?: unknown } | undefined)?.results,
        );
        const retryWatermark = organizationHistoryClearWatermark(latestProfile?.payload);
        if (retryAttempts.length > 0 || retryWatermark !== null) {
          const retryKey = `progress-repair:${auth.user.id}:${crypto.randomUUID()}`;
          await enqueueCloudflareOrganizationAttemptSync(
            auth.user,
            retryAttempts,
            retryKey,
            retryWatermark,
          ).catch((error) => {
            logInternal("account/progress organization outbox repair", error);
          });
        }
      }
      if (organizationDataMode() !== "supabase") {
        await drainCloudflareOrganizationAttemptOutbox({ userId: auth.user.id, limit: 2 })
          .catch((error) => logInternal("account/progress organization outbox drain", error));
        await reconcileOrganizationAttemptObjects(undefined, { limit: 8 })
          .catch((error) => logInternal("account/progress organization object cleanup", error));
      }
    });
  } else if (organizationSourceReadFailed) {
    // The source read itself can be transient even though the submitted
    // snapshot was accepted. Retry in the response lifecycle, then rely on
    // the same read-through repair on the next PUT if the provider stays down.
    after(async () => {
      const latest = await getLearnerProgressSnapshots(auth.user).catch(() => null);
      const latestProfile = latest?.find((entry) => entry.storeKey === "ielts-prep-v1");
      const retryAttempts = organizationAttempts(
        (latestProfile?.payload as { results?: unknown } | undefined)?.results,
      );
      const retryWatermark = organizationHistoryClearWatermark(latestProfile?.payload);
      if (retryAttempts.length === 0 && retryWatermark === null) return;
      const retryKey = `progress-repair:${auth.user.id}:${crypto.randomUUID()}`;
      if (organizationDataMode() !== "supabase") {
        await enqueueCloudflareOrganizationAttemptSync(
          auth.user,
          retryAttempts,
          retryKey,
          retryWatermark,
        ).catch((error) => logInternal("account/progress organization source repair", error));
      }
      await syncOrganizationAttempts(
        auth.user,
        retryAttempts,
        retryKey,
        retryWatermark,
      ).catch((error) => logInternal("account/progress organization source copy", error));
    });
  }

  return NextResponse.json({
    written,
    at: stamp,
    snapshots: acceptedSnapshots,
    historyProtected: restrictedHistory,
    rowsDeleted,
    organizationSync,
  });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const PUT = withCors(handlePUT);
