PRAGMA foreign_keys = OFF;

-- Rebuild only the membership table so an approved request may pause future
-- sharing while a student remains active. Every other column and identity is
-- preserved; all dependent tables reference users/organizations, not this id.
ALTER TABLE organization_memberships RENAME TO organization_memberships_consent_source;
CREATE TABLE organization_memberships (
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
  status_changed_at TEXT,
  UNIQUE (organization_id, user_id)
) STRICT;
INSERT INTO organization_memberships (
  id, organization_id, user_id, role, status, share_future_history,
  share_pre_join_history, joined_at, removed_at, created_at, updated_at,
  status_changed_at
)
SELECT id, organization_id, user_id, role, status, share_future_history,
       share_pre_join_history, joined_at, removed_at, created_at, updated_at,
       status_changed_at
  FROM organization_memberships_consent_source;
DROP TABLE organization_memberships_consent_source;
CREATE INDEX organization_memberships_user_idx
  ON organization_memberships(user_id, status, organization_id);
CREATE INDEX organization_memberships_org_role_idx
  ON organization_memberships(organization_id, role, status, user_id);

-- SQLite keeps triggers with the renamed source table during a rebuild and
-- drops them with that source. Recreate the account-deletion freeze on the
-- replacement table so a consent change cannot resurrect a deleting account.
CREATE TRIGGER organization_memberships_deletion_insert_guard
BEFORE INSERT ON organization_memberships
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_memberships_deletion_update_guard
BEFORE UPDATE ON organization_memberships
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

PRAGMA foreign_keys = ON;
