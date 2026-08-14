PRAGMA foreign_keys = ON;

-- Teacher-set practice is deliberately separate from learner results. A
-- teacher assigns one item to a student; completion is derived from a later
-- matching saved sitting, so changing a task cannot alter the learner record.
CREATE TABLE organization_practice_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assigned_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  student_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  module TEXT NOT NULL CHECK (module IN ('listening', 'reading', 'writing', 'speaking')),
  test_id TEXT NOT NULL CHECK (length(test_id) BETWEEN 1 AND 180),
  test_title TEXT NOT NULL CHECK (length(test_title) BETWEEN 1 AND 600),
  note TEXT CHECK (note IS NULL OR length(note) <= 1200),
  due_at TEXT,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX organization_practice_assignments_student_idx
  ON organization_practice_assignments(organization_id, student_user_id, assigned_at DESC);
CREATE INDEX organization_practice_assignments_teacher_idx
  ON organization_practice_assignments(organization_id, assigned_by_user_id, assigned_at DESC);

-- One editable note per teacher and sitting. The database keeps the original
-- result immutable and lets a learner see feedback from each assigned teacher.
CREATE TABLE organization_teacher_feedback (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES practice_attempts(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  teacher_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 3000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, attempt_id, teacher_user_id)
) STRICT;
CREATE INDEX organization_teacher_feedback_student_idx
  ON organization_teacher_feedback(organization_id, student_user_id, updated_at DESC);
CREATE INDEX organization_teacher_feedback_attempt_idx
  ON organization_teacher_feedback(organization_id, attempt_id, updated_at DESC);

-- Account deletion is a durable saga, not a best-effort UI action. Do not let
-- a concurrent organization write recreate personal data once that saga starts.
CREATE TRIGGER organization_practice_assignments_deletion_insert_guard
BEFORE INSERT ON organization_practice_assignments
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.student_user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_teacher_feedback_deletion_insert_guard
BEFORE INSERT ON organization_teacher_feedback
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.student_user_id)
   OR (NEW.teacher_user_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.teacher_user_id
   ))
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
