import { assertServerOnly } from "@/lib/auth/server-only";
import {
  bandUpCloudflareBindings,
  type BandUpCloudflareBindings,
  type CloudflareDataMode,
} from "./bindings";

/*
  No import of ./replica-outbox here, on purpose: that module imports
  `cutoverWriteBarrierArmed` from this one to gate its own drain, and armed-
  check is the hot path every remaining Supabase writer calls — it has to stay
  a plain, cheap, statically-resolvable function with no import cycle behind
  it. armCutoverWriteBarrier below therefore reads the same four outbox
  counts cloudflareReplicaOutboxStatus reports, directly, rather than
  importing that function. It is a few lines of duplication for one rare,
  owner-triggered call, which is a better trade than either module reaching
  back into the other.
*/

const MODULE = "lib/cloudflare/write-barrier.ts";

/**
 * The write-authority domains a barrier can be armed for — the same two
 * `CLOUDFLARE_DATA_MODE` / `ORGANIZATION_DATA_MODE` domains `bindings.ts`
 * already establishes, not the nine-domain read registry in
 * `cutover-domains.ts`. Every writer this file's callers guard
 * (lib/auth/supabase.ts, lib/usage/guard.ts, lib/ai/cost-tracking.ts,
 * lib/billing/subscriptions.ts, lib/admin/settings.ts) is read by
 * `cloudflareDataMode()`, so in practice only "learner" is ever armed by this
 * codebase today. "organization" exists so the table's shape does not have to
 * change the day an organization write barrier is needed too.
 */
export type CutoverWriteBarrierDomain = "learner" | "organization";

export interface CutoverWriteBarrierRecord {
  domain: CutoverWriteBarrierDomain;
  fromAuthority: CloudflareDataMode;
  toAuthority: "cloudflare";
  barrierAt: string;
  recordedBy: string;
  status: "armed";
}

interface BarrierRow {
  domain: string;
  from_authority: string;
  to_authority: string;
  barrier_at: string;
  recorded_by: string;
  status: string;
}

function isDomain(value: string): value is CutoverWriteBarrierDomain {
  return value === "learner" || value === "organization";
}

function isFromAuthority(value: string): value is CloudflareDataMode {
  return value === "supabase" || value === "dual" || value === "read_cloudflare";
}

/*
  Whether `cutover_write_barriers` exists, keyed by D1 binding object identity
  rather than a single module-level flag — a Worker isolate's `env.BANDUP_DB`
  is a stable reference for that isolate's whole life, so this caches
  correctly there, and a test harness that builds a fresh binding per fixture
  gets a fresh, correctly-scoped answer rather than one test's result leaking
  into the next.

  Applying scripts/hand-run-cutover-write-barrier.sql is deliberately not a
  numbered migration — see that file's header — so code that reads this table
  ships before the SQL that creates it does, and has to for however long that
  gap lasts in each environment. "No such table" is therefore not a fault to
  surface; it is the ordinary, expected shape of "nobody has armed anything
  yet, and the table proving that isn't even there." Once a query succeeds
  once, the table cannot un-exist, so `true` is cached forever; `false` is
  cached only for the exact "no such table: cutover_write_barriers" message,
  never for some other D1 failure, so a transient outage keeps retrying
  instead of being mistaken for a schema that was never applied.
*/
const tableExists = new WeakMap<object, boolean>();

function isMissingBarrierTable(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*cutover_write_barriers\b/i.test(error.message);
}

function readRow(row: BarrierRow): CutoverWriteBarrierRecord | null {
  if (!isDomain(row.domain) || !isFromAuthority(row.from_authority) || row.to_authority !== "cloudflare" || row.status !== "armed") {
    return null;
  }
  return {
    domain: row.domain,
    fromAuthority: row.from_authority,
    toAuthority: "cloudflare",
    barrierAt: row.barrier_at,
    recordedBy: row.recorded_by,
    status: "armed",
  };
}

/**
 * The armed barrier for `domain`, or null if none is armed.
 *
 * `bindings` is optional and, when omitted, resolved fresh with
 * `bandUpCloudflareBindings()` — the same request-scoped, never-cached lookup
 * every other Cloudflare reader in this codebase uses. That is what lets a
 * write helper call this with no binding threaded through it at all.
 *
 * Fails OPEN: a D1 that cannot be reached, or that has no Cloudflare bindings
 * at all (local `next dev` without wrangler, a test harness, a Worker
 * deployed without the D1 binding wired up), reads as "not armed" rather than
 * throwing. The alternative — failing closed — would mean a transient D1
 * outage silently disables every remaining Supabase writer in the app, which
 * is a far larger blast radius than the one this mechanism exists to guard
 * against. The barrier is a deliberate, owner-armed fact; an outage reading
 * it is not evidence that fact is true.
 */
export async function cutoverWriteBarrierRecord(
  domain: CutoverWriteBarrierDomain,
  bindings?: BandUpCloudflareBindings | null,
): Promise<CutoverWriteBarrierRecord | null> {
  assertServerOnly(MODULE);
  const resolved = bindings === undefined ? await bandUpCloudflareBindings() : bindings;
  if (!resolved) return null;
  if (tableExists.get(resolved.db) === false) return null;
  try {
    const row = await resolved.db.prepare(`
      SELECT domain, from_authority, to_authority, barrier_at, recorded_by, status
        FROM cutover_write_barriers WHERE domain = ?
    `).bind(domain).first<BarrierRow>();
    tableExists.set(resolved.db, true);
    return row ? readRow(row) : null;
  } catch (error) {
    if (isMissingBarrierTable(error)) tableExists.set(resolved.db, false);
    return null;
  }
}

/** Convenience boolean over {@link cutoverWriteBarrierRecord}. */
export async function cutoverWriteBarrierArmed(
  domain: CutoverWriteBarrierDomain,
  bindings?: BandUpCloudflareBindings | null,
): Promise<boolean> {
  return (await cutoverWriteBarrierRecord(domain, bindings)) !== null;
}

export interface CutoverWriteBarrierReadiness {
  domain: CutoverWriteBarrierDomain;
  status: "armed" | "not_armed";
  barrierAt: string | null;
  fromAuthority: CloudflareDataMode | null;
  recordedBy: string | null;
}

/** The readiness-report shape: armed / not armed / set at T, never a bare string. */
export async function cutoverWriteBarrierReadiness(
  bindings: BandUpCloudflareBindings,
  domain: CutoverWriteBarrierDomain = "learner",
): Promise<CutoverWriteBarrierReadiness> {
  const record = await cutoverWriteBarrierRecord(domain, bindings);
  return record
    ? {
        domain,
        status: "armed",
        barrierAt: record.barrierAt,
        fromAuthority: record.fromAuthority,
        recordedBy: record.recordedBy,
      }
    : { domain, status: "not_armed", barrierAt: null, fromAuthority: null, recordedBy: null };
}

export type ArmCutoverWriteBarrierResult =
  | { ok: true; record: CutoverWriteBarrierRecord }
  | { ok: false; reason: "already_armed"; record: CutoverWriteBarrierRecord }
  | { ok: false; reason: "outbox_not_drained"; detail: string }
  | { ok: false; reason: "bindings_unavailable" };

/**
 * Arms a barrier. Never called automatically by any drain, readiness check or
 * scheduled job in this codebase — the only caller is
 * `app/api/admin/cloudflare/write-barrier/route.ts`, an owner-only route, and
 * the rehearsal script that proves this file works. That is deliberate: the
 * owner has accepted a no-return point instead of a reverse mirror, but only
 * ever as an explicit act, never as a side effect of a deploy or a passing
 * readiness check.
 *
 * The drain-rule pre-check here exists for a readable error with real counts
 * in it. It is not what actually enforces the rule —
 * scripts/hand-run-cutover-write-barrier.sql's
 * `cutover_write_barriers_require_drained` trigger is, atomically, inside the
 * same statement that inserts the row, which closes the gap between this
 * check and the insert that a purely application-level guard would leave
 * open under concurrent arm attempts.
 */
export async function armCutoverWriteBarrier(
  domain: CutoverWriteBarrierDomain,
  fromAuthority: CloudflareDataMode,
  recordedBy: string,
  bindings?: BandUpCloudflareBindings,
  nowMs: number = Date.now(),
): Promise<ArmCutoverWriteBarrierResult> {
  assertServerOnly(MODULE);
  const resolved = bindings ?? await bandUpCloudflareBindings();
  if (!resolved) return { ok: false, reason: "bindings_unavailable" };

  const existing = await cutoverWriteBarrierRecord(domain, resolved);
  if (existing) return { ok: false, reason: "already_armed", record: existing };

  /*
    The same four counts lib/cloudflare/replica-outbox.ts's
    cloudflareReplicaOutboxStatus reports, read directly here rather than by
    calling that function — see the import note above. `blockedByAccountDeletion`
    rows never leave `pending` (the deletion guard aborts their lease update),
    so they are already inside the `pending` count; this still reports them
    separately, exactly as that function's own report does, because "why" is
    what an owner staring at a refusal needs.
  */
  const [outboxCounts, cleanupCounts, blocked] = await Promise.all([
    resolved.db.prepare(`
      SELECT
        sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
      FROM cloudflare_replica_outbox
    `).first<{ pending: number | null; dead: number | null }>(),
    resolved.db.prepare(`
      SELECT
        sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
      FROM cloudflare_replica_object_cleanup
    `).first<{ pending: number | null; dead: number | null }>(),
    resolved.db.prepare(`
      SELECT count(*) AS blocked
        FROM cloudflare_replica_outbox AS o
        JOIN account_deletion_tombstones AS t ON t.user_id = o.subject_user_id
    `).first<{ blocked: number | null }>(),
  ]);
  const pending = Number(outboxCounts?.pending ?? 0);
  const dead = Number(outboxCounts?.dead ?? 0);
  const cleanupPending = Number(cleanupCounts?.pending ?? 0);
  const cleanupDead = Number(cleanupCounts?.dead ?? 0);
  const blockedByAccountDeletion = Number(blocked?.blocked ?? 0);
  const undrained: string[] = [];
  if (pending > 0) undrained.push(`${pending} pending`);
  if (dead > 0) undrained.push(`${dead} dead`);
  if (cleanupPending > 0) undrained.push(`${cleanupPending} cleanup pending`);
  if (cleanupDead > 0) undrained.push(`${cleanupDead} cleanup dead`);
  if (blockedByAccountDeletion > 0) {
    undrained.push(`${blockedByAccountDeletion} blocked by account deletion`);
  }
  if (undrained.length > 0) {
    return { ok: false, reason: "outbox_not_drained", detail: undrained.join(", ") };
  }

  const barrierAt = new Date(nowMs).toISOString();
  const runId = crypto.randomUUID();
  try {
    await resolved.db.batch([
      resolved.db.prepare(`
        INSERT INTO data_migration_runs (
          id, source_system, target_system, mode, status, started_at, completed_at, summary_json
        ) VALUES (?, 'supabase', 'cloudflare-d1-r2', 'cutover', 'complete', ?, ?, ?)
      `).bind(
        runId,
        barrierAt,
        barrierAt,
        JSON.stringify({ domain, fromAuthority, toAuthority: "cloudflare", recordedBy }),
      ),
      resolved.db.prepare(`
        INSERT INTO cutover_write_barriers (
          domain, from_authority, to_authority, barrier_at, recorded_by, status
        ) VALUES (?, ?, 'cloudflare', ?, ?, 'armed')
      `).bind(domain, fromAuthority, barrierAt, recordedBy),
    ]);
  } catch (error) {
    // Either the drain-rule trigger fired (a race won by a task enqueued
    // after the pre-check above), or a concurrent arm attempt won the primary
    // key. Re-read to tell the two apart rather than guessing.
    const record = await cutoverWriteBarrierRecord(domain, resolved);
    if (record) return { ok: false, reason: "already_armed", record };
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "outbox_not_drained",
      detail: /drained/i.test(message) ? "a task arrived after the check above; try again" : message,
    };
  }

  const record = await cutoverWriteBarrierRecord(domain, resolved);
  if (!record) throw new Error("cutover write barrier did not read back after being armed");
  return { ok: true, record };
}
