PRAGMA foreign_keys = ON;

-- Cloudflare keeps application data. Supabase Auth remains the temporary
-- identity authority, so no password, refresh token or OAuth credential is
-- copied into this database.
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  identity_provider TEXT NOT NULL DEFAULT 'supabase'
    CHECK (identity_provider IN ('supabase')),
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique
  ON app_users(lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS learner_profiles (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  display_name TEXT CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 60),
  birth_date TEXT,
  avatar_object_key TEXT,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS progress_snapshots (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  store_key TEXT NOT NULL CHECK (
    store_key IN ('ielts-prep-v1', 'bandup.drills.v1', 'bandup.lookups.v1')
  ),
  payload_inline TEXT,
  payload_object_key TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  client_updated_at TEXT,
  source_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, store_key),
  CHECK (
    (payload_inline IS NOT NULL AND payload_object_key IS NULL AND json_valid(payload_inline))
    OR (payload_inline IS NULL AND payload_object_key IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS progress_snapshots_updated_idx
  ON progress_snapshots(updated_at);

CREATE TABLE IF NOT EXISTS usernames (
  username TEXT PRIMARY KEY COLLATE NOCASE
    CHECK (length(username) BETWEEN 3 AND 30),
  user_id TEXT NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS reserved_usernames (
  username TEXT PRIMARY KEY COLLATE NOCASE
) STRICT;

INSERT OR IGNORE INTO reserved_usernames(username) VALUES
  ('account'), ('accounts'), ('admin'), ('administrator'), ('api'), ('auth'),
  ('bandup'), ('billing'), ('contact'), ('help'), ('info'), ('mod'),
  ('moderator'), ('official'), ('owner'), ('practice'), ('privacy'), ('root'),
  ('security'), ('settings'), ('staff'), ('support'), ('system'), ('team'),
  ('terms'), ('test'), ('webmaster'), ('www');

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'apple')),
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

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_external_unique
  ON subscriptions(provider, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_apple_original_unique
  ON subscriptions(original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx
  ON subscriptions(user_id, status, current_period_end);

CREATE TABLE IF NOT EXISTS provider_events (
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'apple')),
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  payload_object_key TEXT,
  payload_sha256 TEXT,
  PRIMARY KEY (provider, event_id)
) STRICT;

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  ip_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('admitted', 'denied_quota', 'denied_rate')),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS usage_events_user_window_idx
  ON usage_events(user_id, route, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_events_ip_window_idx
  ON usage_events(ip_hash, route, created_at DESC) WHERE ip_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_cost_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('calculated_tokens', 'provider_backfill')),
  provider_request_id TEXT UNIQUE,
  external_reference TEXT UNIQUE,
  route TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_creation_5m_input_tokens INTEGER,
  cache_creation_1h_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cost_usd TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ai_cost_events_occurred_idx
  ON ai_cost_events(occurred_at);

CREATE TABLE IF NOT EXISTS ai_cost_coverage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source TEXT NOT NULL CHECK (source IN ('provider_console', 'local_tracking')),
  starts_at TEXT NOT NULL,
  historical_complete INTEGER NOT NULL DEFAULT 0 CHECK (historical_complete IN (0, 1)),
  recorded_at TEXT NOT NULL
) STRICT;

-- A migration run is a lifecycle record whose status is finalized once.
-- Immutable checkpoints and source rows record exactly what D1 accepted.
CREATE TABLE IF NOT EXISTS data_migration_runs (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system = 'supabase'),
  target_system TEXT NOT NULL CHECK (target_system = 'cloudflare-d1-r2'),
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'copy', 'verify', 'cutover')),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_project_hash TEXT,
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  error_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS data_migration_checkpoints (
  run_id TEXT NOT NULL REFERENCES data_migration_runs(id) ON DELETE RESTRICT,
  table_name TEXT NOT NULL,
  source_cursor TEXT NOT NULL DEFAULT '',
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  copied_count INTEGER NOT NULL CHECK (copied_count >= 0),
  verified_count INTEGER NOT NULL CHECK (verified_count >= 0),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, table_name, source_cursor)
) STRICT;

CREATE TRIGGER IF NOT EXISTS data_migration_checkpoint_no_update
BEFORE UPDATE ON data_migration_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'migration checkpoints are immutable');
END;

CREATE TRIGGER IF NOT EXISTS data_migration_checkpoint_no_delete
BEFORE DELETE ON data_migration_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'migration checkpoints are immutable');
END;
