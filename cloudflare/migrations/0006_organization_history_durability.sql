PRAGMA foreign_keys = ON;

-- Whether the canonical result payload contains the detailed writing,
-- speaking, listening or reading review. Looking for `"review"` in the inline
-- column was not enough: large reviews live in R2 and therefore have NULL
-- inline JSON. Existing R2 payloads are conservatively treated as detailed so
-- a score-only resync can never discard one before it is read and classified.
ALTER TABLE practice_attempts ADD COLUMN result_has_review INTEGER NOT NULL DEFAULT 0
  CHECK (result_has_review IN (0, 1));
UPDATE practice_attempts
   SET result_has_review = CASE
     WHEN result_object_key IS NOT NULL THEN 1
     WHEN json_type(result_inline, '$.review') = 'object' THEN 1
     ELSE 0
   END;

-- A clear is a monotonic learner-owned tombstone, not an empty result list.
-- Keeping it beside the normalized attempt ledger means a delayed device or
-- outbox retry cannot recreate anything at or before the accepted watermark.
CREATE TABLE organization_history_clear_watermarks (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  cleared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- One coalescing row per learner is deliberately bounded. The most recent
-- complete 100-attempt snapshot replaces an older pending snapshot, while the
-- clear watermark only moves forwards. Large payloads use the private R2
-- `attempts/<user>` namespace so account-deletion prefix capture includes them.
CREATE TABLE organization_attempt_sync_outbox (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 12 AND 160),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 100),
  history_cleared_at TEXT,
  payload_inline TEXT CHECK (payload_inline IS NULL OR json_valid(payload_inline)),
  payload_object_key TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 0 AND 2097152),
  attempts_made INTEGER NOT NULL DEFAULT 0 CHECK (attempts_made BETWEEN 0 AND 20),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (payload_inline IS NOT NULL AND payload_object_key IS NULL)
    OR (payload_inline IS NULL AND payload_object_key IS NOT NULL)
  ),
  CHECK (
    payload_object_key IS NULL
    OR instr(payload_object_key, 'private/attempts/' || user_id || '/') = 1
  ),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
) STRICT;
CREATE INDEX organization_attempt_sync_outbox_due_idx
  ON organization_attempt_sync_outbox(available_at, lease_expires_at);

-- Pointer updates are committed before old R2 objects are retired. A rare R2
-- delete failure is kept here and retried in bounded batches; the key is
-- removed only after another D1 reference check proves it is still orphaned.
CREATE TABLE organization_attempt_object_cleanup (
  object_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  attempts_made INTEGER NOT NULL DEFAULT 0 CHECK (attempts_made BETWEEN 0 AND 20),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (instr(object_key, 'private/attempts/' || user_id || '/') = 1)
) STRICT;
CREATE INDEX organization_attempt_object_cleanup_due_idx
  ON organization_attempt_object_cleanup(available_at);

-- Pointer retirement is recorded in the same D1 transaction that changes or
-- removes the pointer. Runtime code must never rely on a SELECT-before-UPDATE:
-- two concurrent writers could otherwise both miss an object that becomes
-- orphaned between those operations. The cleanup worker rechecks all live
-- references before deleting from R2, so duplicate ledger entries are safe.
CREATE TRIGGER practice_attempt_result_object_cleanup_update
AFTER UPDATE OF result_object_key ON practice_attempts
WHEN OLD.result_object_key IS NOT NULL
 AND (NEW.result_object_key IS NULL OR NEW.result_object_key <> OLD.result_object_key)
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO organization_attempt_object_cleanup (
    object_key, user_id, attempts_made, available_at, created_at, updated_at
  ) VALUES (OLD.result_object_key, OLD.user_id, 0, NEW.updated_at, NEW.updated_at, NEW.updated_at)
  ON CONFLICT(object_key) DO UPDATE SET
    available_at = min(organization_attempt_object_cleanup.available_at, excluded.available_at),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER practice_attempt_result_object_cleanup_delete
AFTER DELETE ON practice_attempts
WHEN OLD.result_object_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO organization_attempt_object_cleanup (
    object_key, user_id, attempts_made, available_at, created_at, updated_at
  ) VALUES (OLD.result_object_key, OLD.user_id, 0, OLD.updated_at, OLD.updated_at, OLD.updated_at)
  ON CONFLICT(object_key) DO UPDATE SET
    available_at = min(organization_attempt_object_cleanup.available_at, excluded.available_at),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER organization_attempt_outbox_object_cleanup_update
AFTER UPDATE OF payload_object_key ON organization_attempt_sync_outbox
WHEN OLD.payload_object_key IS NOT NULL
 AND (NEW.payload_object_key IS NULL OR NEW.payload_object_key <> OLD.payload_object_key)
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO organization_attempt_object_cleanup (
    object_key, user_id, attempts_made, available_at, created_at, updated_at
  ) VALUES (OLD.payload_object_key, OLD.user_id, 0, NEW.updated_at, NEW.updated_at, NEW.updated_at)
  ON CONFLICT(object_key) DO UPDATE SET
    available_at = min(organization_attempt_object_cleanup.available_at, excluded.available_at),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER organization_attempt_outbox_object_cleanup_delete
AFTER DELETE ON organization_attempt_sync_outbox
WHEN OLD.payload_object_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO organization_attempt_object_cleanup (
    object_key, user_id, attempts_made, available_at, created_at, updated_at
  ) VALUES (OLD.payload_object_key, OLD.user_id, 0, OLD.updated_at, OLD.updated_at, OLD.updated_at)
  ON CONFLICT(object_key) DO UPDATE SET
    available_at = min(organization_attempt_object_cleanup.available_at, excluded.available_at),
    updated_at = excluded.updated_at;
END;

-- Every account-deletion state freezes new user-owned history work. Deletes
-- remain allowed so the privacy scrub and orphan cleanup can make progress.
CREATE TRIGGER organization_history_watermark_deletion_insert_guard
BEFORE INSERT ON organization_history_clear_watermarks
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_history_watermark_deletion_update_guard
BEFORE UPDATE ON organization_history_clear_watermarks
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_attempt_outbox_deletion_insert_guard
BEFORE INSERT ON organization_attempt_sync_outbox
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_attempt_outbox_deletion_update_guard
BEFORE UPDATE ON organization_attempt_sync_outbox
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER organization_attempt_cleanup_deletion_insert_guard
BEFORE INSERT ON organization_attempt_object_cleanup
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
CREATE TRIGGER organization_attempt_cleanup_deletion_update_guard
BEFORE UPDATE ON organization_attempt_object_cleanup
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;
