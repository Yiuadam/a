PRAGMA foreign_keys = ON;

-- Source rows are retained verbatim before they are normalized into the D1
-- runtime schema. This is the rollback/reconciliation source of truth: a
-- transformed field can never erase the original Supabase value.
CREATE TABLE IF NOT EXISTS data_migration_source_rows (
  run_id TEXT NOT NULL REFERENCES data_migration_runs(id) ON DELETE RESTRICT,
  table_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_inline TEXT CHECK (source_inline IS NULL OR json_valid(source_inline)),
  source_object_key TEXT,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, table_name, source_id),
  CHECK (
    (source_inline IS NOT NULL AND source_object_key IS NULL)
    OR (source_inline IS NULL AND source_object_key IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER IF NOT EXISTS data_migration_source_rows_no_update
BEFORE UPDATE ON data_migration_source_rows
BEGIN SELECT RAISE(ABORT, 'migration source rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS data_migration_source_rows_no_delete
BEFORE DELETE ON data_migration_source_rows
BEGIN SELECT RAISE(ABORT, 'migration source rows are immutable'); END;

-- Keep the exact Supabase billing vocabulary alongside the runtime fields.
-- Runtime access checks still use the compact canonical columns from 0002.
ALTER TABLE organization_seat_pools ADD COLUMN source_provider TEXT;
ALTER TABLE organization_seat_pools ADD COLUMN source_external_subscription_id TEXT;
ALTER TABLE organization_seat_pools ADD COLUMN source_purchased_seats INTEGER;
ALTER TABLE organization_seat_pools ADD COLUMN source_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS organization_seat_pools_source_provider_key
  ON organization_seat_pools(source_provider, source_external_subscription_id)
  WHERE source_external_subscription_id IS NOT NULL;

-- Supabase tombstones deliberately survive deletion of the learner/source
-- attempt and therefore may not have a recoverable learner id. Preserve that
-- honest nullable state instead of inventing an account id during import.
DROP TRIGGER IF EXISTS organization_tombstone_no_update;
DROP TRIGGER IF EXISTS organization_tombstone_no_delete;
ALTER TABLE organization_attempt_tombstones RENAME TO organization_attempt_tombstones_v3_source;
CREATE TABLE organization_attempt_tombstones (
  organization_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  student_user_id TEXT,
  removed_by TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 2000),
  removed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, attempt_id)
) STRICT;
INSERT INTO organization_attempt_tombstones (
  organization_id, attempt_id, student_user_id, removed_by, reason, removed_at
)
SELECT organization_id, attempt_id, student_user_id, removed_by, reason, removed_at
FROM organization_attempt_tombstones_v3_source;
DROP TABLE organization_attempt_tombstones_v3_source;

CREATE TRIGGER organization_tombstone_no_update
BEFORE UPDATE ON organization_attempt_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are immutable'); END;
CREATE TRIGGER organization_tombstone_no_delete
BEFORE DELETE ON organization_attempt_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are immutable'); END;

-- Preserve the richer source audit dimensions without overloading the
-- runtime target_type/target_id pair.
ALTER TABLE organization_audit_log ADD COLUMN target_user_id TEXT;
ALTER TABLE organization_audit_log ADD COLUMN entity_type TEXT;
ALTER TABLE organization_audit_log ADD COLUMN entity_id TEXT;
ALTER TABLE organization_audit_log ADD COLUMN source_details_json TEXT
  CHECK (source_details_json IS NULL OR json_valid(source_details_json));
