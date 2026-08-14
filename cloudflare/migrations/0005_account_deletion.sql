PRAGMA foreign_keys = ON;

-- Account deletion is a cross-system workflow while Supabase Auth remains the
-- identity authority. The mutable state below is deliberately minimal: it
-- contains no profile/progress payload and clears the temporary email as soon
-- as D1 has been scrubbed. A completed row is the durable, non-PII tombstone
-- that prevents a delayed replica write from recreating the account.
CREATE TABLE account_deletion_tombstones (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 16 AND 80),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 16 AND 80),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'auth_delete_started', 'auth_deleted', 'data_deleted', 'complete')
  ),
  email_for_cleanup TEXT,
  prepared_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  auth_delete_started_at TEXT,
  auth_deleted_at TEXT,
  data_deleted_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  purged_source_rows INTEGER NOT NULL DEFAULT 0 CHECK (purged_source_rows >= 0),
  objects_discovered INTEGER NOT NULL DEFAULT 0 CHECK (objects_discovered >= 0),
  objects_deleted INTEGER NOT NULL DEFAULT 0 CHECK (objects_deleted >= 0),
  updated_at TEXT NOT NULL,
  CHECK (state <> 'auth_delete_started' OR auth_delete_started_at IS NOT NULL),
  CHECK (state IN ('prepared', 'auth_delete_started') OR auth_deleted_at IS NOT NULL),
  CHECK (state NOT IN ('data_deleted', 'complete') OR data_deleted_at IS NOT NULL),
  CHECK (state <> 'complete' OR completed_at IS NOT NULL),
  CHECK (state <> 'complete' OR email_for_cleanup IS NULL)
) STRICT;

CREATE INDEX account_deletion_state_idx
  ON account_deletion_tombstones(state, updated_at);

-- An object manifest makes R2 deletion resumable without putting an unbounded
-- JSON array in one D1 cell. Rows are removed only after the strongly
-- consistent R2 delete succeeds; retrying an already-deleted key is safe.
CREATE TABLE account_deletion_objects (
  user_id TEXT NOT NULL REFERENCES account_deletion_tombstones(user_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND (
      instr(object_key, 'private/avatars/' || user_id || '/') = 1
      -- Early migration payloads used module/attempt-id rather than user-id;
      -- those exact immutable D1 pointers still have to remain deletable.
      OR instr(object_key, 'private/attempts/') = 1
      OR instr(object_key, 'private/subscriptions/' || user_id || '/') = 1
      OR instr(object_key, 'private/progress/ielts-prep-v1/' || user_id || '/') = 1
      OR instr(object_key, 'private/progress/bandup.drills.v1/' || user_id || '/') = 1
      OR instr(object_key, 'private/progress/bandup.lookups.v1/' || user_id || '/') = 1
      OR instr(object_key, 'private/migration/source/') = 1
    )
  ),
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (user_id, object_key)
) STRICT;

CREATE TRIGGER account_deletion_complete_no_update
BEFORE UPDATE ON account_deletion_tombstones
WHEN OLD.state = 'complete'
BEGIN SELECT RAISE(ABORT, 'completed account deletion tombstones are immutable'); END;

CREATE TRIGGER account_deletion_active_no_delete
BEFORE DELETE ON account_deletion_tombstones
WHEN OLD.state <> 'prepared'
BEGIN SELECT RAISE(ABORT, 'active account deletion tombstones cannot be deleted'); END;

-- Tag migration evidence with every account it contains. Migration evidence
-- stays immutable during normal operation, but privacy deletion must be able
-- to remove a learner's duplicated source profile/progress after Supabase Auth
-- has been deleted. Organization audit and removal tombstones intentionally
-- receive no subject tag and therefore remain immutable.
DROP TRIGGER IF EXISTS data_migration_source_rows_no_update;
DROP TRIGGER IF EXISTS data_migration_source_rows_no_delete;
ALTER TABLE data_migration_source_rows ADD COLUMN subject_user_ids_json TEXT
  NOT NULL DEFAULT '[]'
  CHECK (json_valid(subject_user_ids_json) AND json_type(subject_user_ids_json) = 'array');

UPDATE data_migration_source_rows
SET subject_user_ids_json = CASE
  WHEN table_name = 'profiles' THEN json_array(source_id)
  WHEN table_name = 'progress_snapshots' AND instr(source_id, ':') > 1
    THEN json_array(substr(source_id, 1, instr(source_id, ':') - 1))
  WHEN table_name = 'subscriptions' THEN coalesce((
    SELECT json_array(user_id) FROM subscriptions WHERE id = source_id
  ), '[]')
  WHEN table_name = 'usernames' THEN coalesce((
    SELECT json_array(user_id) FROM usernames WHERE username = source_id
  ), '[]')
  WHEN table_name = 'usage_events' THEN coalesce((
    SELECT json_array(user_id) FROM usage_events WHERE id = source_id AND user_id IS NOT NULL
  ), '[]')
  WHEN table_name = 'organization_applications' THEN coalesce((
    SELECT json_array(applicant_user_id) FROM organization_applications WHERE id = source_id
  ), '[]')
  WHEN table_name = 'organization_memberships' THEN coalesce((
    SELECT json_array(user_id) FROM organization_memberships WHERE id = source_id
  ), '[]')
  WHEN table_name = 'teacher_student_assignments' THEN coalesce((
    SELECT json_array(teacher_user_id, student_user_id, assigned_by, revoked_by)
      FROM teacher_student_assignments WHERE id = source_id
  ), '[]')
  WHEN table_name = 'organization_seat_allocations' THEN coalesce((
    SELECT json_array(user_id, allocated_by)
      FROM organization_seat_allocations WHERE id = source_id
  ), '[]')
  WHEN table_name = 'organization_requests' THEN coalesce((
    SELECT json_array(requester_user_id, target_user_id, decided_by)
      FROM organization_requests WHERE id = source_id
  ), '[]')
  WHEN table_name = 'practice_attempts' THEN coalesce((
    SELECT json_array(user_id) FROM practice_attempts WHERE id = source_id
  ), '[]')
  WHEN table_name = 'organization_attempt_archives' THEN coalesce((
    SELECT json_array(p.user_id, a.archived_by, a.restored_by)
      FROM organization_attempt_archives AS a
      JOIN practice_attempts AS p ON p.id = a.attempt_id
     WHERE a.organization_id || ':' || a.attempt_id = source_id
  ), '[]')
  WHEN table_name IN ('organization_command_receipts', 'organization_sync_receipts')
       AND instr(source_id, ':') > 1
    THEN json_array(substr(source_id, 1, instr(source_id, ':') - 1))
  WHEN table_name = 'provider_events' AND source_inline IS NOT NULL THEN CASE
    WHEN json_extract(source_inline, '$.payload.data.object.metadata.bandup_user_id') IS NOT NULL
      THEN json_array(json_extract(source_inline, '$.payload.data.object.metadata.bandup_user_id'))
    WHEN json_extract(source_inline, '$.payload.data.object.client_reference_id') IS NOT NULL
      THEN json_array(json_extract(source_inline, '$.payload.data.object.client_reference_id'))
    ELSE '[]'
  END
  ELSE '[]'
END;

CREATE TRIGGER data_migration_source_rows_no_update
BEFORE UPDATE ON data_migration_source_rows
BEGIN SELECT RAISE(ABORT, 'migration source rows are immutable'); END;

CREATE TRIGGER data_migration_source_rows_no_delete
BEFORE DELETE ON data_migration_source_rows
WHEN NOT EXISTS (
  SELECT 1
    FROM json_each(OLD.subject_user_ids_json) AS subject
    JOIN account_deletion_tombstones AS deletion
      ON deletion.user_id = subject.value
   WHERE deletion.state IN ('auth_deleted', 'data_deleted', 'complete')
)
BEGIN SELECT RAISE(ABORT, 'migration source rows are immutable'); END;

DROP TRIGGER IF EXISTS data_migration_row_map_no_update;
DROP TRIGGER IF EXISTS data_migration_row_map_no_delete;
ALTER TABLE data_migration_row_map ADD COLUMN subject_user_ids_json TEXT
  NOT NULL DEFAULT '[]'
  CHECK (json_valid(subject_user_ids_json) AND json_type(subject_user_ids_json) = 'array');

UPDATE data_migration_row_map
SET subject_user_ids_json = coalesce((
  SELECT source.subject_user_ids_json
    FROM data_migration_source_rows AS source
   WHERE source.run_id = data_migration_row_map.run_id
     AND source.table_name = data_migration_row_map.table_name
     AND source.source_id = data_migration_row_map.source_id
), '[]');

CREATE TRIGGER data_migration_row_map_no_update
BEFORE UPDATE ON data_migration_row_map
BEGIN SELECT RAISE(ABORT, 'migration row maps are immutable'); END;

CREATE TRIGGER data_migration_row_map_no_delete
BEFORE DELETE ON data_migration_row_map
WHEN NOT EXISTS (
  SELECT 1
    FROM json_each(OLD.subject_user_ids_json) AS subject
    JOIN account_deletion_tombstones AS deletion
      ON deletion.user_id = subject.value
   WHERE deletion.state IN ('auth_deleted', 'data_deleted', 'complete')
)
BEGIN SELECT RAISE(ABORT, 'migration row maps are immutable'); END;

-- Last line of defence against an in-flight request recreating learner data
-- between preparation and cleanup. Normal writes all touch app_users first;
-- completed tombstones make delayed replicas fail closed forever.
CREATE TRIGGER app_users_account_deletion_insert_guard
BEFORE INSERT ON app_users
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER app_users_account_deletion_update_guard
BEFORE UPDATE ON app_users
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = OLD.id
)
AND NOT (NEW.email IS NULL AND NEW.role = 'user' AND NEW.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

-- A request can pass its application-level preflight immediately before a
-- deletion is prepared. These database guards close that final race for every
-- mutable user-owned table. DELETE remains allowed so the recovery workflow
-- can purge rows transactionally; immutable audit/tombstone tables are not
-- covered because they intentionally survive account deletion.
CREATE TRIGGER learner_profiles_deletion_insert_guard
BEFORE INSERT ON learner_profiles
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER learner_profiles_deletion_update_guard
BEFORE UPDATE ON learner_profiles
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER progress_snapshots_deletion_insert_guard
BEFORE INSERT ON progress_snapshots
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER progress_snapshots_deletion_update_guard
BEFORE UPDATE ON progress_snapshots
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER usernames_deletion_insert_guard
BEFORE INSERT ON usernames
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER usernames_deletion_update_guard
BEFORE UPDATE ON usernames
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER subscriptions_deletion_insert_guard
BEFORE INSERT ON subscriptions
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER subscriptions_deletion_update_guard
BEFORE UPDATE ON subscriptions
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER usage_events_deletion_insert_guard
BEFORE INSERT ON usage_events
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER usage_events_deletion_update_guard
BEFORE UPDATE ON usage_events
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_applications_deletion_insert_guard
BEFORE INSERT ON organization_applications
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.applicant_user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_applications_deletion_update_guard
BEFORE UPDATE ON organization_applications
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.applicant_user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_memberships_deletion_insert_guard
BEFORE INSERT ON organization_memberships
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_memberships_deletion_update_guard
BEFORE UPDATE ON organization_memberships
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER teacher_assignments_deletion_insert_guard
BEFORE INSERT ON teacher_student_assignments
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.teacher_user_id OR user_id = NEW.student_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER teacher_assignments_deletion_update_guard
BEFORE UPDATE ON teacher_student_assignments
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.teacher_user_id OR user_id = NEW.student_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER seat_allocations_deletion_insert_guard
BEFORE INSERT ON organization_seat_allocations
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER seat_allocations_deletion_update_guard
BEFORE UPDATE ON organization_seat_allocations
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_requests_deletion_insert_guard
BEFORE INSERT ON organization_requests
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.requester_user_id OR user_id = NEW.target_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_requests_deletion_update_guard
BEFORE UPDATE ON organization_requests
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.requester_user_id OR user_id = NEW.target_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER practice_attempts_deletion_insert_guard
BEFORE INSERT ON practice_attempts
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER practice_attempts_deletion_update_guard
BEFORE UPDATE ON practice_attempts
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_command_receipts_deletion_insert_guard
BEFORE INSERT ON organization_command_receipts
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.actor_user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_command_receipts_deletion_update_guard
BEFORE UPDATE ON organization_command_receipts
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.actor_user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_sync_receipts_deletion_insert_guard
BEFORE INSERT ON organization_sync_receipts
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_sync_receipts_deletion_update_guard
BEFORE UPDATE ON organization_sync_receipts
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
