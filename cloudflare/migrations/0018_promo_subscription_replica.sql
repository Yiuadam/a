PRAGMA foreign_keys = OFF;

/*
  The promotional Pro grant is an entitlement, not a payment provider. It must
  nevertheless be replicated just like Stripe and Apple so a cutover cannot
  quietly remove an existing learner's access. SQLite requires rebuilding a
  table to widen a CHECK constraint; preserve every column, index and trigger
  while doing so.
*/
CREATE TABLE subscriptions_widen_provider (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'apple', 'promo')),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'trialing', 'past_due', 'canceled', 'expired', 'paused', 'refunded')
  ),
  tier TEXT NOT NULL,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  original_transaction_id TEXT,
  external_price_id TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  provider_event_at TEXT,
  verified_at TEXT NOT NULL,
  raw_inline TEXT CHECK (raw_inline IS NULL OR json_valid(raw_inline)),
  raw_object_key TEXT,
  raw_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (raw_inline IS NULL OR raw_object_key IS NULL)
) STRICT;

INSERT INTO subscriptions_widen_provider (
  id, user_id, provider, status, tier, external_customer_id, external_subscription_id,
  original_transaction_id, external_price_id, current_period_end, cancel_at_period_end,
  provider_event_at, verified_at, raw_inline, raw_object_key, raw_sha256, created_at, updated_at
)
SELECT
  id, user_id, provider, status, tier, external_customer_id, external_subscription_id,
  original_transaction_id, external_price_id, current_period_end, cancel_at_period_end,
  provider_event_at, verified_at, raw_inline, raw_object_key, raw_sha256, created_at, updated_at
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_widen_provider RENAME TO subscriptions;

CREATE UNIQUE INDEX subscriptions_provider_external_unique
  ON subscriptions(provider, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_apple_original_unique
  ON subscriptions(original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;
CREATE INDEX subscriptions_user_status_idx
  ON subscriptions(user_id, status, current_period_end);

CREATE TRIGGER subscriptions_deletion_insert_guard
BEFORE INSERT ON subscriptions
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

CREATE TRIGGER subscriptions_deletion_update_guard
BEFORE UPDATE ON subscriptions
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion is in progress'); END;

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

PRAGMA foreign_keys = ON;
PRAGMA foreign_keys = OFF;

/*
  The durable replica queue has the same issue: it must understand a promo
  entitlement event before the Cloudflare billing writer may enqueue one.
*/
CREATE TABLE cloudflare_replica_outbox_widen_operation (
  task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 3 AND 512),
  operation TEXT NOT NULL CHECK (operation IN (
    'learner_profile', 'account_identity', 'username', 'progress_snapshot',
    'avatar_put', 'avatar_delete', 'stripe_billing', 'promo_subscription',
    'usage_event', 'ai_cost_event', 'ai_cost_coverage'
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

INSERT INTO cloudflare_replica_outbox_widen_operation (
  task_id, operation, subject_user_id, source_updated_at, payload_inline,
  payload_object_key, payload_sha256, payload_bytes, generation, attempts_made,
  status, available_at, lease_token, lease_expires_at, last_attempt_at,
  last_error_code, created_at, updated_at
)
SELECT
  task_id, operation, subject_user_id, source_updated_at, payload_inline,
  payload_object_key, payload_sha256, payload_bytes, generation, attempts_made,
  status, available_at, lease_token, lease_expires_at, last_attempt_at,
  last_error_code, created_at, updated_at
FROM cloudflare_replica_outbox;

DROP TABLE cloudflare_replica_outbox;
ALTER TABLE cloudflare_replica_outbox_widen_operation RENAME TO cloudflare_replica_outbox;

CREATE INDEX cloudflare_replica_outbox_due_idx
  ON cloudflare_replica_outbox(status, available_at, lease_expires_at);
CREATE INDEX cloudflare_replica_outbox_subject_idx
  ON cloudflare_replica_outbox(subject_user_id, status, available_at)
  WHERE subject_user_id IS NOT NULL;

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

PRAGMA foreign_keys = ON;
