PRAGMA foreign_keys = ON;

-- Runtime application settings move with the rest of the product data. During
-- dual mode Supabase remains authoritative and this table is an ordered
-- replica; after the learner/product cutover the same row shape becomes the
-- D1 authority without another schema change.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 120),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  source_updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  mirrored_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS app_settings_source_updated_idx
  ON app_settings(source_updated_at DESC);
