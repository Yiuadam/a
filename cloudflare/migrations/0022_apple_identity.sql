/*
  Room for an Apple identity beside a Google one.

  Read the warning before the SQL. This file rebuilds app_user_identities,
  because the constraint it has to change is a CHECK and SQLite cannot alter a
  CHECK in place — `provider TEXT NOT NULL CHECK (provider = 'google')` was
  written when Google was the only provider the native authority understood, and
  an Apple row cannot be inserted while it stands. The rebuild is the documented
  twelve-step procedure reduced to the four steps this table actually needs:
  nothing references app_user_identities, so there is no dependent foreign key
  to reconstruct, and its only index is recreated below.

  It is still a rebuild of a live identity table, which is the most consequential
  kind of migration this repository has. It copies every row and then drops the
  original, so it is not reversible by re-running it, and applying it is a
  production event: BandUp has no previewable database, and a migration applied
  anywhere is applied to the accounts real people sign in with. It should be
  applied when somebody is watching, with a D1 time-travel bookmark noted first,
  and not before the Apple credentials exist — until they do, nothing in the
  application can write an Apple row and this file changes only what is possible,
  never what is stored.

  What it deliberately does not do is widen anything else. The primary key is
  still (provider, provider_subject), so two providers cannot collide on a
  subject; UNIQUE (user_id, provider) still allows a person at most one identity
  per provider; and email is still an unverified convenience column rather than
  anything an account is found by.
*/

PRAGMA foreign_keys = OFF;

CREATE TABLE app_user_identities_next (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  email TEXT,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (user_id, provider)
) STRICT;

INSERT INTO app_user_identities_next (
  provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at
)
SELECT provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at
  FROM app_user_identities;

DROP TABLE app_user_identities;

ALTER TABLE app_user_identities_next RENAME TO app_user_identities;

CREATE INDEX IF NOT EXISTS app_user_identities_user_idx
  ON app_user_identities(user_id);

PRAGMA foreign_keys = ON;

/*
  One-time server-flow state for the Apple web button, in its own table rather
  than sharing the Google one.

  The columns are identical and the temptation to share is real, but the two
  flows expire, are consumed and would have to be cleaned up together, and a
  table named app_google_oauth_transactions holding Apple rows is the kind of
  thing that reads as a bug for years. The cost of a second table is one CREATE.

  Apple returns its authorization by POSTing a form rather than by redirecting,
  so unlike the Google row this state never appears in a URL on the way back.
  Consuming it before the code exchange is what stops a replayed form post
  starting a second session.
*/
CREATE TABLE IF NOT EXISTS app_apple_oauth_transactions (
  state_sha256 TEXT PRIMARY KEY CHECK (length(state_sha256) = 64),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
  redirect_origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS app_apple_oauth_transactions_expiry_idx
  ON app_apple_oauth_transactions(expires_at)
  WHERE consumed_at IS NULL;
