PRAGMA foreign_keys = ON;

/*
  Cloudflare-native email account actions.

  A new password account is pending until the holder follows its confirmation
  link. Existing imported Supabase credentials stay active: their original
  provider already performed that address confirmation and forcing everyone
  through a new verification mail would be an unnecessary lockout.
*/
ALTER TABLE app_password_credentials ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('pending', 'active'));

/*
  Raw action tokens are never persisted. The mail link carries a random
  `id.secret` value; D1 keeps only the SHA-256 digest of that complete value.
  Confirmation and recovery share a small, auditable one-time-token table.
*/
CREATE TABLE IF NOT EXISTS app_email_action_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('confirm_registration', 'recover_access')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS app_email_action_tokens_live_idx
  ON app_email_action_tokens(user_id, action, expires_at)
  WHERE consumed_at IS NULL;
