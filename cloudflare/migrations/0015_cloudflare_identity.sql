PRAGMA foreign_keys = ON;

/*
  Cloudflare-native identity, while preserving every existing BandUp user id.

  app_users.id is deliberately not changed: it is already the id referenced by
  progress, organisations, subscriptions and attempt history.  The provider
  subject belongs in a separate table because a Google `sub` identifies an
  identity, not an application record, and an email address can change.

  This file only creates empty tables. Applying it to a remote D1 database is
  a separate, owner-approved migration step; it never imports, deletes or
  changes an existing account by itself.
*/

ALTER TABLE app_users ADD COLUMN identity_authority TEXT NOT NULL DEFAULT 'supabase'
  CHECK (identity_authority IN ('supabase', 'cloudflare'));

CREATE TABLE IF NOT EXISTS app_user_identities (
  provider TEXT NOT NULL CHECK (provider = 'google'),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  email TEXT,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (user_id, provider)
) STRICT;

CREATE INDEX IF NOT EXISTS app_user_identities_user_idx
  ON app_user_identities(user_id);

/*
  Access tokens are signed and short-lived.  Only a SHA-256 digest of a
  rotating refresh token is stored, so a database export cannot be replayed as
  an authenticated session.
*/
CREATE TABLE IF NOT EXISTS app_auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  refresh_token_sha256 TEXT NOT NULL UNIQUE CHECK (length(refresh_token_sha256) = 64),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS app_auth_sessions_refresh_idx
  ON app_auth_sessions(refresh_token_sha256, expires_at)
  WHERE revoked_at IS NULL;

/*
  One-time server-flow state for the Google button fallback. The browser sees
  only a high-entropy opaque state value; D1 keeps its SHA-256 digest, the
  short-lived OpenID Connect nonce and the fixed callback origin. Consuming
  the row before the code exchange prevents a captured callback URL from
  starting a second login.
*/
CREATE TABLE IF NOT EXISTS app_google_oauth_transactions (
  state_sha256 TEXT PRIMARY KEY CHECK (length(state_sha256) = 64),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
  redirect_origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS app_google_oauth_transactions_expiry_idx
  ON app_google_oauth_transactions(expires_at)
  WHERE consumed_at IS NULL;
