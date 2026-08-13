PRAGMA foreign_keys = ON;

-- Forward-only runtime fields required by the organization command service.
-- 0001/0002 have already been applied to the preview database, so this file
-- deliberately evolves them instead of rewriting migration history.
ALTER TABLE organizations ADD COLUMN join_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_join_code_unique
  ON organizations(join_code) WHERE join_code IS NOT NULL;

ALTER TABLE organization_memberships ADD COLUMN status_changed_at TEXT;

-- 0002 used a table-level UNIQUE constraint, which cannot express "one active
-- assignment" once reversible revocation exists. Rebuild the table once so a
-- partial unique index can enforce the real invariant.
ALTER TABLE teacher_student_assignments RENAME TO teacher_student_assignments_v2_source;
CREATE TABLE teacher_student_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  teacher_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  CHECK (teacher_user_id <> student_user_id)
) STRICT;
INSERT INTO teacher_student_assignments (
  id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at
)
SELECT id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at
FROM teacher_student_assignments_v2_source;
DROP TABLE teacher_student_assignments_v2_source;
CREATE UNIQUE INDEX IF NOT EXISTS teacher_student_assignments_one_active
  ON teacher_student_assignments(organization_id, teacher_user_id, student_user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS teacher_assignments_active_teacher_idx
  ON teacher_student_assignments(organization_id, teacher_user_id, student_user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS teacher_assignments_active_student_idx
  ON teacher_student_assignments(organization_id, student_user_id, teacher_user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS organization_seat_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seat_pool_id TEXT NOT NULL REFERENCES organization_seat_pools(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'active', 'released', 'expired')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  allocated_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS organization_seat_allocations_one_live_user
  ON organization_seat_allocations(organization_id, user_id)
  WHERE status IN ('reserved', 'active');
CREATE INDEX IF NOT EXISTS organization_seat_allocations_pool_idx
  ON organization_seat_allocations(seat_pool_id, status);

ALTER TABLE practice_attempts ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS practice_attempts_user_source_unique
  ON practice_attempts(user_id, source_key) WHERE source_key IS NOT NULL;

ALTER TABLE organization_command_receipts ADD COLUMN request_hash TEXT;
ALTER TABLE organization_sync_receipts ADD COLUMN request_hash TEXT;
ALTER TABLE organization_sync_receipts ADD COLUMN response_json TEXT
  CHECK (response_json IS NULL OR json_valid(response_json));

-- A short-lived lock serializes organization commands while their permission
-- checks and transactional D1 batch are assembled. A crashed Worker can leave
-- only a bounded lock; the next request can reclaim it after expiry.
CREATE TABLE IF NOT EXISTS organization_command_locks (
  scope_key TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS organization_command_locks_expiry_idx
  ON organization_command_locks(expires_at);

-- Migration/import maps preserve source primary keys and provide an explicit
-- place to prove that a Supabase row has one, and only one, Cloudflare row.
CREATE TABLE IF NOT EXISTS data_migration_row_map (
  run_id TEXT NOT NULL REFERENCES data_migration_runs(id) ON DELETE RESTRICT,
  table_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  row_sha256 TEXT NOT NULL CHECK (length(row_sha256) = 64),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, table_name, source_id),
  UNIQUE (run_id, table_name, target_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS data_migration_row_map_no_update
BEFORE UPDATE ON data_migration_row_map
BEGIN SELECT RAISE(ABORT, 'migration row maps are immutable'); END;

CREATE TRIGGER IF NOT EXISTS data_migration_row_map_no_delete
BEFORE DELETE ON data_migration_row_map
BEGIN SELECT RAISE(ABORT, 'migration row maps are immutable'); END;
