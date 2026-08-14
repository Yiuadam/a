PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organization_applications (
  id TEXT PRIMARY KEY,
  applicant_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  organization_name TEXT NOT NULL CHECK (length(trim(organization_name)) BETWEEN 2 AND 120),
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 10 AND 2000),
  country TEXT NOT NULL CHECK (length(trim(country)) BETWEEN 2 AND 80),
  contact_email TEXT NOT NULL CHECK (length(trim(contact_email)) BETWEEN 3 AND 320),
  estimated_students INTEGER CHECK (estimated_students IS NULL OR estimated_students BETWEEN 1 AND 1000000),
  applicant_role TEXT NOT NULL CHECK (length(trim(applicant_role)) BETWEEN 2 AND 80),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected')),
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS organization_applications_applicant_idx
  ON organization_applications(applicant_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS organization_applications_status_idx
  ON organization_applications(status, submitted_at);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  application_id TEXT UNIQUE REFERENCES organization_applications(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  slug TEXT UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  created_by TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS organizations_status_idx ON organizations(status, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_seat_pools (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'manual'
    CHECK (provider IN ('manual', 'stripe', 'apple', 'wechat', 'alipay')),
  external_reference TEXT,
  seat_count INTEGER NOT NULL CHECK (seat_count >= 0),
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'expired', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS organization_seat_pools_org_idx
  ON organization_seat_pools(organization_id, status, ends_at);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'manager', 'owner')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('invited', 'pending', 'active', 'leave_requested', 'suspended', 'removed')),
  share_future_history INTEGER NOT NULL DEFAULT 1 CHECK (share_future_history IN (0, 1)),
  share_pre_join_history INTEGER NOT NULL DEFAULT 0 CHECK (share_pre_join_history IN (0, 1)),
  joined_at TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id),
  CHECK (role <> 'student' OR status NOT IN ('active', 'leave_requested') OR share_future_history = 1)
) STRICT;

CREATE INDEX IF NOT EXISTS organization_memberships_user_idx
  ON organization_memberships(user_id, status, organization_id);
CREATE INDEX IF NOT EXISTS organization_memberships_org_role_idx
  ON organization_memberships(organization_id, role, status, user_id);

CREATE TABLE IF NOT EXISTS teacher_student_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  teacher_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, teacher_user_id, student_user_id),
  CHECK (teacher_user_id <> student_user_id)
) STRICT;

CREATE INDEX IF NOT EXISTS teacher_assignments_teacher_idx
  ON teacher_student_assignments(organization_id, teacher_user_id, student_user_id);
CREATE INDEX IF NOT EXISTS teacher_assignments_student_idx
  ON teacher_student_assignments(organization_id, student_user_id, teacher_user_id);

CREATE TABLE IF NOT EXISTS organization_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('join', 'leave', 'history_access_change', 'invitation')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requester_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  target_user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  invitation_email TEXT,
  invitation_token_hash TEXT,
  requested_role TEXT CHECK (requested_role IS NULL OR requested_role IN ('student', 'teacher', 'manager')),
  requested_value INTEGER CHECK (requested_value IS NULL OR requested_value IN (0, 1)),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  expires_at TEXT,
  decided_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind <> 'invitation' OR invitation_token_hash IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS organization_requests_org_status_idx
  ON organization_requests(organization_id, status, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS organization_requests_actor_idx
  ON organization_requests(requester_user_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS organization_requests_pending_actor_unique
  ON organization_requests(organization_id, kind, requester_user_id)
  WHERE status = 'pending' AND kind IN ('join', 'leave', 'history_access_change');

CREATE TABLE IF NOT EXISTS practice_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  module TEXT NOT NULL CHECK (module IN ('listening', 'reading', 'writing', 'speaking', 'placement')),
  test_id TEXT NOT NULL CHECK (length(test_id) BETWEEN 1 AND 180),
  test_title TEXT NOT NULL CHECK (length(test_title) BETWEEN 1 AND 600),
  submitted_at TEXT NOT NULL,
  score REAL,
  score_out_of REAL,
  band REAL CHECK (band IS NULL OR band BETWEEN 0 AND 9),
  feedback_summary TEXT,
  result_inline TEXT CHECK (result_inline IS NULL OR json_valid(result_inline)),
  result_object_key TEXT,
  result_sha256 TEXT NOT NULL CHECK (length(result_sha256) = 64),
  result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, module, test_id, submitted_at),
  CHECK (
    (result_inline IS NOT NULL AND result_object_key IS NULL)
    OR (result_inline IS NULL AND result_object_key IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS practice_attempts_user_time_idx
  ON practice_attempts(user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS practice_attempts_user_module_idx
  ON practice_attempts(user_id, module, submitted_at DESC);

CREATE TABLE IF NOT EXISTS organization_attempt_archives (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES practice_attempts(id) ON DELETE CASCADE,
  archived_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  archived_at TEXT NOT NULL,
  restored_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  restored_at TEXT,
  PRIMARY KEY (organization_id, attempt_id)
) STRICT;

-- Deliberately no foreign keys: this immutable evidence must survive source
-- account/organization deletion and disaster recovery.
CREATE TABLE IF NOT EXISTS organization_attempt_tombstones (
  organization_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  student_user_id TEXT NOT NULL,
  removed_by TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 2000),
  removed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, attempt_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS organization_tombstone_no_update
BEFORE UPDATE ON organization_attempt_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are immutable'); END;
CREATE TRIGGER IF NOT EXISTS organization_tombstone_no_delete
BEFORE DELETE ON organization_attempt_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are immutable'); END;

CREATE TABLE IF NOT EXISTS organization_audit_log (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 2 AND 120),
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  CHECK (actor_user_id IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS organization_audit_org_time_idx
  ON organization_audit_log(organization_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS organization_audit_no_update
BEFORE UPDATE ON organization_audit_log
BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS organization_audit_no_delete
BEFORE DELETE ON organization_audit_log
BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END;

CREATE TABLE IF NOT EXISTS organization_command_receipts (
  actor_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_user_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS organization_sync_receipts (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
) STRICT;
