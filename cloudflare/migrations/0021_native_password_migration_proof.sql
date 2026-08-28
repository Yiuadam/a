PRAGMA foreign_keys = ON;

/*
  A Cloudflare-only password cutover needs evidence stronger than equal row
  counts. Imported Supabase bcrypt verifiers are tagged separately from later
  native registrations, then a single SHA-256 commitment proves the complete
  source export matches the imported D1 set. The actual verifier, user id and
  source email never leave the confidential import path.
*/
ALTER TABLE app_password_credentials ADD COLUMN migration_source TEXT NOT NULL DEFAULT 'unverified'
  CHECK (migration_source IN ('unverified', 'supabase_import', 'native_registration'));

CREATE INDEX IF NOT EXISTS app_password_credentials_migration_source_idx
  ON app_password_credentials(migration_source, user_id);

CREATE TABLE IF NOT EXISTS native_password_migration_proofs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_rows INTEGER NOT NULL CHECK (source_rows >= 0),
  source_manifest_sha256 TEXT NOT NULL CHECK (length(source_manifest_sha256) = 64),
  target_rows INTEGER NOT NULL CHECK (target_rows >= 0),
  target_manifest_sha256 TEXT NOT NULL CHECK (length(target_manifest_sha256) = 64),
  verified_at TEXT NOT NULL
) STRICT;
