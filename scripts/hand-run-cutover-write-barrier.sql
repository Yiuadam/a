-- HAND-RUN SQL — NOT a numbered migration in cloudflare/migrations/.
--
-- Applying a D1 schema change is not previewable: it lands on the same
-- database production reads from the moment it runs, so per the working
-- agreement in CLAUDE.md it is not something this change applies for the
-- owner. This file exists so tests/cutover-write-barrier.test.mjs and
-- scripts/rehearse-cloudflare-migration.mjs have one canonical copy to run
-- against a throwaway/local D1 rather than three drifting copies — it is not
-- picked up by `wrangler d1 migrations apply` because it does not live in
-- cloudflare/migrations/, and nothing in the application ever executes it.
--
-- The PR body carries this exact text as the SQL the owner runs by hand,
-- with the `wrangler d1 execute` command to run it. Whether a barrier's
-- schema belongs in the numbered ledger instead is a real, open question —
-- see the PR body for why this change did not make that call unilaterally.
PRAGMA foreign_keys = ON;

-- A durable, one-way, per-domain epoch: the instant write authority for
-- `domain` stopped being Supabase's to share. Every isolate of every deployed
-- Worker version reads this same D1 database, which is the whole point — an
-- environment variable is per-isolate and a Workers deploy does not replace
-- every isolate at once, so for a few seconds an old isolate and a new one can
-- both believe they are allowed to write. This table is what an old isolate
-- can still see and obey, closing that window rather than merely surviving it.
--
-- A dedicated table rather than a new `data_migration_runs` row, because a
-- migration run is a lifecycle record for a bulk copy job — it has a status
-- that moves (running/complete/failed/cancelled), checkpoints with per-table
-- cursors and counts, and a summary meant to describe *how much* moved. A
-- write barrier describes something with none of that shape: one immutable
-- fact, armed once, never edited, and read on the hot path of every remaining
-- Supabase writer. Folding it into `data_migration_runs` would mean either a
-- second, unrelated meaning for that table's `status`, or a lookup that has to
-- filter `summary_json` by hand on every write. Both are worse than a second
-- table whose primary key already answers the one question that matters:
-- "is this domain barred?"
--
-- `data_migration_runs.mode` has allowed 'cutover' since 0001 and nothing ever
-- wrote it. Arming a barrier now also inserts one 'cutover'-mode run in the
-- same transaction, so the column's anticipated value finally appears in the
-- audit trail those runs already give the owner — see
-- lib/cloudflare/write-barrier.ts. That run row is history; this table is the
-- one thing every writer actually reads.
CREATE TABLE IF NOT EXISTS cutover_write_barriers (
  domain TEXT PRIMARY KEY CHECK (domain IN ('learner', 'organization')),
  from_authority TEXT NOT NULL CHECK (from_authority IN ('supabase', 'dual', 'read_cloudflare')),
  to_authority TEXT NOT NULL CHECK (to_authority = 'cloudflare'),
  barrier_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 320),
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status = 'armed')
) STRICT;

-- One-way. A barrier row is armed exactly once and is never edited or lifted
-- by this application — matching the owner's standing decision to accept a
-- no-return point rather than build a reverse mirror. Reopening a domain is a
-- deliberate, separate, hand-run operation, not a code path.
CREATE TRIGGER IF NOT EXISTS cutover_write_barriers_no_update
BEFORE UPDATE ON cutover_write_barriers
BEGIN
  SELECT RAISE(ABORT, 'a cutover write barrier cannot be edited once armed');
END;

CREATE TRIGGER IF NOT EXISTS cutover_write_barriers_no_delete
BEFORE DELETE ON cutover_write_barriers
BEGIN
  SELECT RAISE(ABORT, 'a cutover write barrier cannot be removed once armed');
END;

-- The drain rule, enforced at the one layer that cannot be bypassed by a bug
-- in the calling code: arming must fail while the outbox this barrier is
-- about to permanently stop draining still holds anything a drain could have
-- applied. lib/cloudflare/write-barrier.ts checks the same condition first,
-- for a readable error message with real counts in it, but this trigger is
-- what actually guarantees it — the same relationship migration 0013's
-- deletion guards have to the rows they protect. `blockedByAccountDeletion`
-- rows are already counted in `pending` (their status never leaves 'pending'
-- because the deletion guard aborts the lease update), so this single check
-- covers pending, dead, cleanupPending, cleanupDead and
-- blockedByAccountDeletion all at once.
CREATE TRIGGER IF NOT EXISTS cutover_write_barriers_require_drained
BEFORE INSERT ON cutover_write_barriers
WHEN (
  (SELECT count(*) FROM cloudflare_replica_outbox WHERE status IN ('pending', 'dead')) > 0
  OR (SELECT count(*) FROM cloudflare_replica_object_cleanup WHERE status IN ('pending', 'dead')) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'cutover write barrier requires the replica outbox to be fully drained first');
END;
