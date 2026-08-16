import { bandUpCloudflareBindings, cloudflareDataMode } from "./bindings";
import { cloudflareReplicaOutboxStatus } from "./replica-outbox";
import { lastScheduledReplicaDrain } from "./scheduled-replica-drain";

/*
  Is the D1/R2 mirror still moving — booleans only, to anyone who asks.

  ---------------------------------------------------------------------------
  Why this looks so much like lib/billing/health.ts

  Because it is the same failure, twice. Billing broke on a calendar rather
  than on a git push, so .github/workflows/billing-health.yml asks the live
  site once an hour whether anybody can pay. The mirror broke on a calendar
  too: nothing was deployed between 14 and 16 August, the queue simply stopped
  being drained, and the only place that said so was a counter behind an admin
  session that nobody had a reason to open. Two days.

  So this endpoint is deliberately the same shape as billing's, is checked by
  a workflow that is deliberately a copy of billing's, and reaches the owner
  by the same route: a failing scheduled run, which GitHub emails to the
  repository owner with nothing to configure and no third party to pay. A
  second alerting mechanism would be a second thing to keep alive.

  ---------------------------------------------------------------------------
  Boolean-only, and why that is safe here

  This route needs no session, because the thing calling it is a workflow that
  has none — the same reason billing's is open. What it may therefore say is
  limited to which fixed check failed: never a count, never a queue depth,
  never an operation name, never a learner id. "The mirror is behind" tells a
  prober nothing they can use; how far behind, on which operations, for which
  subjects, is operational detail that stays where it already is, behind
  `isAdminEmail` on /api/admin/cloudflare/replica-outbox and on /admin.

  ---------------------------------------------------------------------------
  What is *not* checked, on purpose

  Dead-lettered rows and rows frozen by an account-deletion tombstone are both
  real and both currently non-zero in production. Neither fails this check.
  An alarm that is red on the day it is installed, and stays red until somebody
  does unrelated repair work, is an alarm that gets a filter rule written for
  it — and then the next outage is silent again for the same two days. This
  check answers one question, the one nothing was asking: is the queue being
  drained at all. The rest is named on the admin readiness report, which exists
  and is the right place for detail that needs a person's judgement.
*/

/** A run older than this means the schedule is not firing. Cron is 5-minutely. */
const DRAIN_STALE_MS = 30 * 60 * 1000;
/**
 * How long the oldest drainable row may sit before that is a fault.
 *
 * Six hours is far longer than a healthy queue ever needs — a row that fails
 * every attempt exhausts the twelve-attempt budget in under three — and far
 * shorter than the two days this went unnoticed. A single row that is merely
 * unlucky must not page anybody.
 */
const BACKLOG_STALE_MS = 6 * 60 * 60 * 1000;

export interface ReplicaHealthCheck {
  name: string;
  ok: boolean;
}

export interface ReplicaHealth {
  ok: boolean;
  checks: ReplicaHealthCheck[];
}

export interface ReplicaHealthInput {
  lastRunAt: string | null;
  oldestRetryablePendingAt: string | null;
  nowMs: number;
}

function ageMs(at: string | null, nowMs: number): number | null {
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? nowMs - parsed : null;
}

/** Pure, so the thresholds can be tested without a Worker or a database. */
export function evaluateReplicaHealth(input: ReplicaHealthInput): ReplicaHealth {
  const drainAge = ageMs(input.lastRunAt, input.nowMs);
  const backlogAge = ageMs(input.oldestRetryablePendingAt, input.nowMs);
  const checks: ReplicaHealthCheck[] = [
    // No receipt at all is a failure, not an unknown: before this change there
    // was no receipt at all, and that was the outage.
    { name: "replica_drain_ran_recently", ok: drainAge !== null && drainAge <= DRAIN_STALE_MS },
    // An empty queue has no oldest row, and an empty queue is the healthy case.
    { name: "replica_backlog_within_bound", ok: backlogAge === null || backlogAge <= BACKLOG_STALE_MS },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

/**
 * The live answer. `supabase` mode has no mirror to keep up, so it is healthy
 * by definition rather than permanently failing on a queue nobody writes to.
 */
export async function cloudflareReplicaHealth(
  nowMs: number = Date.now(),
): Promise<ReplicaHealth> {
  if (cloudflareDataMode() === "supabase") {
    return { ok: true, checks: [{ name: "replica_mirror_inactive", ok: true }] };
  }
  const bindings = await bandUpCloudflareBindings();
  if (!bindings) {
    // Dual mode without D1 or R2 is a mirror that cannot be written at all.
    return { ok: false, checks: [{ name: "replica_bindings_available", ok: false }] };
  }
  const [marker, status] = await Promise.all([
    lastScheduledReplicaDrain(bindings).catch(() => null),
    cloudflareReplicaOutboxStatus(bindings, nowMs).catch(() => null),
  ]);
  if (!status) {
    return { ok: false, checks: [{ name: "replica_status_readable", ok: false }] };
  }
  return evaluateReplicaHealth({
    lastRunAt: marker?.ranAt ?? null,
    oldestRetryablePendingAt: status.oldestRetryablePendingAt,
    nowMs,
  });
}
