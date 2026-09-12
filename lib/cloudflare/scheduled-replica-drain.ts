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
  The numbers, and why these ones — sized for the Workers Free plan

  This account runs on Workers Free and is staying there. Free caps every
  invocation — a cron tick exactly like an HTTP request — at 50 subrequests
  (developers.cloudflare.com/d1/platform/limits/ and /workers/platform/limits/
  both give "Queries per Worker invocation: 1000 (Workers Paid) / 50 (Free)";
  a D1 query and an R2 operation each cost one) and about 10ms of CPU,
  leniently enforced. The 25-row, 50-key batch this file used to run was sized
  for a Paid invocation's 1000-subrequest, 30-second-CPU ceiling; unchanged, it
  would ask Free for several times its entire per-tick budget before a single
  row's target write even ran.

  One outbox row, worst case: a lease UPDATE (1) + a payload R2 GET, when the
  payload did not fit inline (1) + the target write itself — not always the
  single statement the old "five or six subrequests" estimate assumed. Two of
  the ten operations fan out much further: `learner_profile`'s target write is
  `putCloudflareLearnerProfile` (5 — `ensureCloudflareUser` alone checks the
  account-deletion guard twice around one INSERT) followed, whenever the
  profile carries a username, by `claimCloudflareUsername` (its own
  `ensureCloudflareLearnerProfile` plus a two-statement batch) and, on a
  username collision, one more read — 13 subrequests at the worst, counting
  that batch call as costly as its two statements rather than the one round
  trip Cloudflare's docs describe `batch()` as making. `avatar_put` reaches 12
  by a different path (an R2 put, a D1 pointer swap through the same
  `ensureCloudflareLearnerProfile`, and an R2 delete of whichever object loses
  the race), with no batch() involved at all. Add the closing DELETE or
  UPDATE (1): 15 to 16 subrequests for one row, not five or six. One cleanup
  row, worst case (the object turns out unreferenced and is actually
  deleted): an `objectIsReferenced` check (1) + an R2 delete (1) + a closing
  DELETE or UPDATE (1) = 3.

  Fixed cost every tick pays, empty backlog or not: the write-barrier check
  (1), this drain's own outbox SELECT (1), `drainCloudflareReplicaOutbox`'s
  own small opportunistic cleanup pass and that pass's SELECT (1 — see
  `OUTBOX_DRAIN_CLEANUP_LIMIT` in replica-outbox.ts), the explicit cleanup
  pass below and its SELECT (1), `cloudflareReplicaOutboxStatus`'s five
  queries, and the R2 marker put (1) — 10 subrequests before any row is
  touched, which is exactly why an empty queue (today's actual state) still
  writes a marker on Free.

  So: 10 + 16 * SCHEDULED_REPLICA_OUTBOX_BATCH + 3 * OUTBOX_DRAIN_CLEANUP_LIMIT
  + 3 * SCHEDULED_REPLICA_CLEANUP_BATCH has to clear 50 with real margin. At 1,
  1 and 3 that is 10 + 16 + 3 + 9 = 38 subrequests: twelve spare against the
  hard ceiling, two spare against the 40 this file targets, so a slightly
  optimistic reading of `batch()` still does not tip it over.
  tests/replica-drain-free-budget.test.mjs runs this same arithmetic against
  the live exported constants, so a future change to any one of them that
  breaks the total fails a test rather than a cron.

  Per hour, at one tick every five minutes: 12 outbox rows, and at least 48
  cleanup keys (36 from this file's own batch, 12 more opportunistically from
  the pass folded into the outbox drain). The 34-row backlog measured on 16
  August clears in under three hours. A thousand-row backlog — larger than
  anything this app has produced — would take days rather than hours; that is
  Free's trade, not a bug in this file, and it belongs here so the owner reads
  it before an incident rather than during one.

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

export const SCHEDULED_REPLICA_OUTBOX_BATCH = 1;
export const SCHEDULED_REPLICA_CLEANUP_BATCH = 3;

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
