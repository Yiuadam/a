/*
  A deletion tombstone must say which authority owns the irreversible identity
  step. Before native sign-in, every existing job was necessarily Supabase,
  so the additive default preserves and explicitly labels that history. New
  native-account jobs can then be recovered without querying a retired source
  system or treating a missing Supabase account as proof that a D1 identity is
  gone.
*/
ALTER TABLE account_deletion_tombstones ADD COLUMN auth_authority TEXT
  NOT NULL DEFAULT 'supabase'
  CHECK (auth_authority IN ('supabase', 'cloudflare'));

CREATE INDEX IF NOT EXISTS account_deletion_auth_authority_state_idx
  ON account_deletion_tombstones(auth_authority, state, updated_at);
