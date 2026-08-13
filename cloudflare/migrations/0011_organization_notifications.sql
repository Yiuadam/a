PRAGMA foreign_keys = ON;

-- Notifications are a private, user-owned inbox. They store only typed event
-- references: copy, destinations and practice details are derived at read time
-- from the authoritative organization tables. In particular, no email address
-- or teacher feedback body is duplicated here.
CREATE TABLE user_notifications (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  recipient_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'practice_assigned',
    'teacher_feedback',
    'assignment_completed',
    'organization_request',
    'organization_invitation'
  )),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 180),
  related_entity_id TEXT CHECK (
    related_entity_id IS NULL OR length(related_entity_id) BETWEEN 1 AND 180
  ),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 12 AND 600),
  read_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (actor_user_id IS NULL OR actor_user_id <> recipient_user_id)
) STRICT;

CREATE INDEX user_notifications_recipient_time_idx
  ON user_notifications(recipient_user_id, created_at DESC, id DESC);
CREATE INDEX user_notifications_recipient_unread_idx
  ON user_notifications(recipient_user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
CREATE INDEX user_notifications_entity_idx
  ON user_notifications(organization_id, kind, entity_id);

-- Attempt sync resolves matching assignments by learner and practice. Keep
-- that hot path indexed so one completed sitting never scans every
-- organization's assignment ledger.
CREATE INDEX organization_practice_assignments_completion_idx
  ON organization_practice_assignments(student_user_id, module, assigned_at);

-- Account deletion freezes both delivery and read-state mutation. DELETE stays
-- available to the deletion saga, which purges a recipient's inbox and events
-- in which the deleted account was the actor.
CREATE TRIGGER user_notifications_deletion_insert_guard
BEFORE INSERT ON user_notifications
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.recipient_user_id
)
OR (
  NEW.actor_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM account_deletion_tombstones
     WHERE user_id = NEW.actor_user_id
  )
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER user_notifications_deletion_update_guard
BEFORE UPDATE ON user_notifications
WHEN EXISTS (
  SELECT 1 FROM account_deletion_tombstones
   WHERE user_id = NEW.recipient_user_id
)
OR (
  NEW.actor_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM account_deletion_tombstones
     WHERE user_id = NEW.actor_user_id
  )
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
