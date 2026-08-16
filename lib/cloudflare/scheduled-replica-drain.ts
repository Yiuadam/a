import type { BandUpCloudflareBindings } from "./bindings";
import {
  cloudflareReplicaOutboxStatus,
  drainCloudflareReplicaObjectCleanup,
  drainCloudflareReplicaOutbox,
  type CloudflareReplicaDrainResult,
  type CloudflareReplicaExecutor,
  type CloudflareReplicaOutboxStatus,
} from "./replica-outbox";
import { executeCloudflareReplicaTask } from "./replica-replay";

/*
  The drain that runs whether or not anybody is using the app.

  ---------------------------------------------------------------------------
  What was missing

  Every drain this project had was hung off a learner's own write: finish a
  practice session, and your request advances two rows of the queue. That is a
  fine accelerator and a hopeless guarantee, and the two were being confused
  for each other. Two of the drains also filter by the writing learner's own
  user id, so a pending row belonging to somebody who has stopped using BandUp
  is not retried slowly — it is never retried at all. The backoff schedule
  caps at an hour, which is a promise about *when* a row becomes due again and
  no promise whatever that anything will come and look.

  Nothing came and looked between 14 and 16 August. Twelve progress snapshots,
  twenty usage events, two cost events, a profile and a username sat in D1 two
  days behind Supabase, and the queue's own counters said "4 pending" the whole
  time, which is exactly what a queue that is about to be drained looks like.

  ---------------------------------------------------------------------------
  The numbers, and why these ones

  Twenty-five outbox rows and fifty cleanup keys per run, every five minutes.

  * Per run: each outbox row is a lease UPDATE, a payload read (inline for
    almost all of them, one R2 GET for the few that are not), the target write
    itself and a DELETE. Call it five or six subrequests, so twenty-five rows
    is roughly 150 against a Worker limit of 1000, on an invocation with a
    30-second CPU ceiling and no user waiting behind it.
  * Per hour: 300 outbox rows and 600 cleanup keys. The backlog measured on 16
    August was 34 rows; this clears that on the first run. A thousand-row
    backlog — far larger than anything this app has produced — clears inside
    four hours.
  * Against the sources: none of this touches Supabase. The drain replays an
    already-captured payload into D1 and R2, so the load lands on the two
    stores that are behind, and 300 small D1 writes an hour is noise next to
    ordinary request traffic.

  Five minutes rather than one: the recovery this exists for is measured in
  hours, the mirror is not on any read path while `CLOUDFLARE_DATA_MODE` is
  `dual`, and twelve invocations an hour that usually find an empty queue is
  the cheapest honest way to keep the guarantee. Five minutes rather than an
  hour: with an hourly job the *first* thing an operator would want after a
  fix is to see it work, and waiting up to an hour for that is how people
  start running drains by hand instead.

  Retry rules are untouched. The backoff, the twelve-attempt cap and the
  dead-letter status all still belong to `drainCloudflareReplicaOutbox`; this
  module chooses a page size and a clock, and nothing else. A dead row stays
  dead until the owner asks for it back through the admin route.
*/

export const SCHEDULED_REPLICA_OUTBOX_BATCH = 25;
export const SCHEDULED_REPLICA_CLEANUP_BATCH = 50;

/**
 * Where the last run leaves its receipt.
 *
 * A cron trigger that silently never fires looks exactly like a cron trigger
 * with nothing to do, and this project has just spent two days learning what
 * that costs. So each run writes a small object saying when it ran and what it
 * found, and `lib/cloudflare/replica-health.ts` reads it back — which makes
 * "did the schedule fire?" a question anybody can answer from outside, without
 * a Cloudflare login and without tailing a log.
 *
 * R2 rather than a D1 table because a new table means a migration, and a
 * migration against this project's production is not a previewable act. The
 * key sits outside every per-user prefix, so account deletion's object sweep
 * never sees it and the pointer-safe cleanup queue never considers it.
 */
export const REPLICA_DRAIN_MARKER_KEY = "private/ops/replica-drain-last-run.json";

export interface ReplicaDrainRun {
  ranAt: string;
  outbox: CloudflareReplicaDrainResult;
  cleanup: CloudflareReplicaDrainResult;
  status: CloudflareReplicaOutboxStatus;
}

export interface ReplicaDrainMarker {
  ranAt: string;
  outbox: CloudflareReplicaDrainResult;
  cleanup: CloudflareReplicaDrainResult;
  pending: number;
  dead: number;
  cleanupPending: number;
  cleanupDead: number;
  blockedByAccountDeletion: number;
  oldestRetryablePendingAt: string | null;
}

function marker(run: ReplicaDrainRun): ReplicaDrainMarker {
  return {
    ranAt: run.ranAt,
    outbox: run.outbox,
    cleanup: run.cleanup,
    pending: run.status.pending,
    dead: run.status.dead,
    cleanupPending: run.status.cleanupPending,
    cleanupDead: run.status.cleanupDead,
    blockedByAccountDeletion: run.status.blockedByAccountDeletion,
    oldestRetryablePendingAt: run.status.oldestRetryablePendingAt,
  };
}

/** Counts and timestamps only — never a payload, a key or a learner id. */
export async function runScheduledReplicaDrain(
  bindings: BandUpCloudflareBindings,
  options: { nowMs?: number; execute?: CloudflareReplicaExecutor } = {},
): Promise<ReplicaDrainRun> {
  const nowMs = options.nowMs ?? Date.now();
  const execute = options.execute ?? executeCloudflareReplicaTask;
  const outbox = await drainCloudflareReplicaOutbox(execute, bindings, {
    limit: SCHEDULED_REPLICA_OUTBOX_BATCH,
    nowMs,
  });
  const cleanup = await drainCloudflareReplicaObjectCleanup(bindings, {
    limit: SCHEDULED_REPLICA_CLEANUP_BATCH,
    nowMs,
  });
  const status = await cloudflareReplicaOutboxStatus(bindings, nowMs);
  const run: ReplicaDrainRun = {
    ranAt: new Date(nowMs).toISOString(),
    outbox,
    cleanup,
    status,
  };
  /*
    The receipt is written even when the run found nothing, because "nothing to
    do" is the answer the health check most needs to be able to trust, and it
    is written last so that it records what actually happened rather than what
    was about to be attempted.
  */
  await bindings.files.put(
    REPLICA_DRAIN_MARKER_KEY,
    JSON.stringify(marker(run)),
    { httpMetadata: { contentType: "application/json" } },
  );
  return run;
}

/** The last receipt, or null if there has never been one — or it is unreadable. */
export async function lastScheduledReplicaDrain(
  bindings: BandUpCloudflareBindings,
): Promise<ReplicaDrainMarker | null> {
  const object = await bindings.files.get(REPLICA_DRAIN_MARKER_KEY).catch(() => null);
  if (!object) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
    if (!parsed || typeof parsed !== "object") return null;
    const ranAt = (parsed as { ranAt?: unknown }).ranAt;
    if (typeof ranAt !== "string" || !Number.isFinite(Date.parse(ranAt))) return null;
    return parsed as ReplicaDrainMarker;
  } catch {
    // A truncated or half-written receipt is the same fact as no receipt: the
    // schedule cannot be shown to have run, and the health check must say so.
    return null;
  }
}
