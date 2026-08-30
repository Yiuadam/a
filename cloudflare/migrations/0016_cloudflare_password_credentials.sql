PRAGMA foreign_keys = ON;

/*
  Password credentials owned by Cloudflare.

  A Supabase Auth password is already a bcrypt verifier.  This table keeps
  that verifier as-is so a person can continue to use the password they
  already know; it never contains a plaintext password, a Supabase access
  token, a recovery token or an OAuth credential.

  The importer validates the immutable app user id and the current email
  against app_users before a row can be inserted.  That prevents an export
  from one account being attached to another account merely because two email
  values happen to resemble each other.
*/
CREATE TABLE IF NOT EXISTS app_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL CHECK (scheme = 'bcrypt'),
  verifier TEXT NOT NULL CHECK (
    length(verifier) = 60
    AND substr(verifier, 1, 4) IN ('$2a$', '$2b$', '$2y$')
  ),
  source_updated_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS app_password_credentials_verified_idx
  ON app_password_credentials(last_verified_at)
  WHERE last_verified_at IS NOT NULL;
