PRAGMA foreign_keys = ON;

-- A delayed username replay must obey the same source clock as profile and
-- progress replication. Without this column an old failed identity task could
-- replace a newer username after the Cloudflare service recovered.
ALTER TABLE usernames ADD COLUMN source_updated_at TEXT;
UPDATE usernames SET source_updated_at = created_at WHERE source_updated_at IS NULL;
UPDATE usernames
   SET source_updated_at = substr(
         strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at), 1, 23
       ) || '000000Z'
 WHERE source_updated_at IS NOT NULL;

-- Earlier runtime and migration writes used JavaScript's three-digit ISO
-- timestamps. Canonicalise them once so subsequent nine-digit source clocks
-- can use exact lexical ordering, including PostgreSQL microseconds.
UPDATE learner_profiles
   SET source_updated_at = substr(
         strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at), 1, 23
       ) || '000000Z'
 WHERE source_updated_at IS NOT NULL;
UPDATE progress_snapshots
   SET source_updated_at = substr(
         strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at), 1, 23
       ) || '000000Z'
 WHERE source_updated_at IS NOT NULL;
UPDATE subscriptions
   SET provider_event_at = substr(
         strftime('%Y-%m-%dT%H:%M:%fZ', provider_event_at), 1, 23
       ) || '000000Z'
 WHERE provider_event_at IS NOT NULL;
UPDATE ai_cost_coverage
   SET recorded_at = substr(
         strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at), 1, 23
       ) || '000000Z'
 WHERE recorded_at IS NOT NULL;

-- Avatar replacement is an independently replayed operation. It therefore
-- needs its own source clock: using the general profile clock would either
-- let an old leased avatar task replace a newer picture, or make a later
-- display-name save permanently block repair of a missing avatar.
ALTER TABLE learner_profiles ADD COLUMN avatar_source_updated_at TEXT;
UPDATE learner_profiles
   SET avatar_source_updated_at = source_updated_at
 WHERE avatar_object_key IS NOT NULL AND avatar_source_updated_at IS NULL;

-- Extend the resumable deletion manifest before any user-owned outbox object
-- can be created. Rebuilding is required because SQLite cannot alter CHECK
-- constraints in place.
CREATE TABLE account_deletion_objects_with_replica (
  user_id TEXT NOT NULL REFERENCES account_deletion_tombstones(user_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND (
      instr(object_key, 'private/avatars/' || user_id || '/') = 1
      OR instr(object_key, 'private/attempts/') = 1
      OR instr(object_key, 'private/subscriptions/' || user_id || '/') = 1
      OR instr(object_key, 'private/progress/ielts-prep-v1/' || user_id || '/') = 1
      OR instr(object_key, 'private/progress/bandup.drills.v1/' || user_id || '/') = 1
      OR instr(object_key, 'private/progress/bandup.lookups.v1/' || user_id || '/') = 1
      OR instr(object_key, 'private/replica-outbox/' || user_id || '/') = 1
      OR instr(object_key, 'private/migration/source/') = 1
    )
  ),
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (user_id, object_key)
) STRICT;
INSERT INTO account_deletion_objects_with_replica
SELECT user_id, object_key, discovered_at FROM account_deletion_objects;
DROP TABLE account_deletion_objects;
ALTER TABLE account_deletion_objects_with_replica RENAME TO account_deletion_objects;

-- Durable, coalescing target-side work for the period in which Supabase is the
-- learner/billing authority. Event ledgers use a task id containing their
-- immutable source id; mutable snapshots (profile, progress, avatar, coverage)
-- reuse a stable task id and only accept a strictly newer source clock.
CREATE TABLE cloudflare_replica_outbox (
  task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 3 AND 512),
  operation TEXT NOT NULL CHECK (operation IN (
    'learner_profile', 'account_identity', 'username', 'progress_snapshot',
    'avatar_put', 'avatar_delete', 'stripe_billing', 'usage_event',
    'ai_cost_event', 'ai_cost_coverage'
  )),
  subject_user_id TEXT,
  source_updated_at TEXT NOT NULL,
  payload_inline TEXT CHECK (payload_inline IS NULL OR json_valid(payload_inline)),
  payload_object_key TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 2 AND 1900000),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 2147483647),
  attempts_made INTEGER NOT NULL DEFAULT 0 CHECK (attempts_made BETWEEN 0 AND 12),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
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
    OR instr(payload_object_key, 'private/replica-outbox/') = 1
  ),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status = 'pending' OR (status = 'dead' AND attempts_made = 12))
) STRICT;

CREATE INDEX cloudflare_replica_outbox_due_idx
  ON cloudflare_replica_outbox(status, available_at, lease_expires_at);
CREATE INDEX cloudflare_replica_outbox_subject_idx
  ON cloudflare_replica_outbox(subject_user_id, status, available_at)
  WHERE subject_user_id IS NOT NULL;

-- Retired payload objects and failed avatar deletes are kept until a bounded
-- cleanup pass proves that no live D1 pointer still references the key.
CREATE TABLE cloudflare_replica_object_cleanup (
  object_key TEXT PRIMARY KEY CHECK (
    instr(object_key, 'private/') = 1 AND length(object_key) <= 1024
  ),
  subject_user_id TEXT,
  attempts_made INTEGER NOT NULL DEFAULT 0 CHECK (attempts_made BETWEEN 0 AND 12),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
  available_at TEXT NOT NULL,
  last_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status = 'pending' OR (status = 'dead' AND attempts_made = 12))
) STRICT;

CREATE INDEX cloudflare_replica_object_cleanup_due_idx
  ON cloudflare_replica_object_cleanup(status, available_at);
CREATE INDEX cloudflare_replica_object_cleanup_subject_idx
  ON cloudflare_replica_object_cleanup(subject_user_id, status, available_at)
  WHERE subject_user_id IS NOT NULL;

-- The pointer change and retirement ledger are one D1 transaction. Cleanup
-- still rechecks references, so replacing a row with the same content hash is
-- safe even if this produces duplicate cleanup work.
CREATE TRIGGER cloudflare_replica_outbox_object_cleanup_update
AFTER UPDATE OF payload_object_key ON cloudflare_replica_outbox
WHEN OLD.payload_object_key IS NOT NULL
 AND (NEW.payload_object_key IS NULL OR NEW.payload_object_key <> OLD.payload_object_key)
 AND (
   OLD.subject_user_id IS NULL OR NOT EXISTS (
     SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.subject_user_id
   )
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, OLD.subject_user_id, 0, 'pending', NEW.updated_at,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET
    subject_user_id = coalesce(
      cloudflare_replica_object_cleanup.subject_user_id,
      excluded.subject_user_id
    ),
    attempts_made = 0,
    status = 'pending',
    available_at = min(
      cloudflare_replica_object_cleanup.available_at,
      excluded.available_at
    ),
    last_error_code = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER cloudflare_replica_outbox_object_cleanup_delete
AFTER DELETE ON cloudflare_replica_outbox
WHEN OLD.payload_object_key IS NOT NULL
 AND (
   OLD.subject_user_id IS NULL OR NOT EXISTS (
     SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.subject_user_id
   )
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, OLD.subject_user_id, 0, 'pending', OLD.updated_at,
    OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET
    subject_user_id = coalesce(
      cloudflare_replica_object_cleanup.subject_user_id,
      excluded.subject_user_id
    ),
    attempts_made = 0,
    status = 'pending',
    available_at = min(
      cloudflare_replica_object_cleanup.available_at,
      excluded.available_at
    ),
    last_error_code = NULL,
    updated_at = excluded.updated_at;
END;

-- Account deletion freezes new user-owned replica work. The deletion runtime
-- captures both tables' R2 keys before removing these rows.
CREATE TRIGGER cloudflare_replica_outbox_deletion_insert_guard
BEFORE INSERT ON cloudflare_replica_outbox
WHEN NEW.subject_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.subject_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER cloudflare_replica_outbox_deletion_update_guard
BEFORE UPDATE ON cloudflare_replica_outbox
WHEN NEW.subject_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.subject_user_id
)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

-- Close every pointer/delete crash window, not only the outbox's own R2
-- payload. Cleanup rechecks all live pointers immediately before deletion.
CREATE TRIGGER learner_profile_avatar_replica_cleanup_update
AFTER UPDATE OF avatar_object_key ON learner_profiles
WHEN OLD.avatar_object_key IS NOT NULL
 AND (NEW.avatar_object_key IS NULL OR NEW.avatar_object_key <> OLD.avatar_object_key)
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.avatar_object_key, OLD.user_id, 0, 'pending', NEW.updated_at,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER learner_profile_avatar_replica_cleanup_delete
AFTER DELETE ON learner_profiles
WHEN OLD.avatar_object_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.avatar_object_key, OLD.user_id, 0, 'pending', OLD.updated_at,
    OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER progress_replica_cleanup_update
AFTER UPDATE OF payload_object_key ON progress_snapshots
WHEN OLD.payload_object_key IS NOT NULL
 AND (NEW.payload_object_key IS NULL OR NEW.payload_object_key <> OLD.payload_object_key)
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, OLD.user_id, 0, 'pending', NEW.updated_at,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER progress_replica_cleanup_delete
AFTER DELETE ON progress_snapshots
WHEN OLD.payload_object_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, OLD.user_id, 0, 'pending', OLD.updated_at,
    OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER subscription_replica_cleanup_update
AFTER UPDATE OF raw_object_key ON subscriptions
WHEN OLD.raw_object_key IS NOT NULL
 AND (NEW.raw_object_key IS NULL OR NEW.raw_object_key <> OLD.raw_object_key)
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.raw_object_key, OLD.user_id, 0, 'pending', NEW.updated_at,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER subscription_replica_cleanup_delete
AFTER DELETE ON subscriptions
WHEN OLD.raw_object_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM account_deletion_tombstones WHERE user_id = OLD.user_id
 )
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.raw_object_key, OLD.user_id, 0, 'pending', OLD.updated_at,
    OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER provider_event_replica_cleanup_update
AFTER UPDATE OF payload_object_key ON provider_events
WHEN OLD.payload_object_key IS NOT NULL
 AND (NEW.payload_object_key IS NULL OR NEW.payload_object_key <> OLD.payload_object_key)
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, NULL, 0, 'pending', coalesce(NEW.processed_at, NEW.received_at),
    coalesce(NEW.processed_at, NEW.received_at), coalesce(NEW.processed_at, NEW.received_at)
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER provider_event_replica_cleanup_delete
AFTER DELETE ON provider_events
WHEN OLD.payload_object_key IS NOT NULL
BEGIN
  INSERT INTO cloudflare_replica_object_cleanup (
    object_key, subject_user_id, attempts_made, status, available_at,
    created_at, updated_at
  ) VALUES (
    OLD.payload_object_key, NULL, 0, 'pending', coalesce(OLD.processed_at, OLD.received_at),
    coalesce(OLD.processed_at, OLD.received_at), coalesce(OLD.processed_at, OLD.received_at)
  )
  ON CONFLICT(object_key) DO UPDATE SET attempts_made = 0, status = 'pending',
    available_at = min(cloudflare_replica_object_cleanup.available_at, excluded.available_at),
    last_error_code = NULL, updated_at = excluded.updated_at;
END;
