/*
  Native Stripe writes need a durable D1 claim before Supabase can be retired.

  `claim_token` is deliberately separate from `processed_at`: a D1 batch uses
  the fresh opaque token to ensure that only the request which inserted an
  event receipt can write its entitlement. Looking only at an event id would
  let a duplicate delivery run the second statement in a later batch.

  A prepaid purchase stores its verified original amount separately. Refund
  events replace a subscription's raw payload, so deriving the total from that
  mutable evidence would make a later partial refund impossible to classify.
*/
ALTER TABLE provider_events ADD COLUMN claim_token TEXT;

CREATE INDEX IF NOT EXISTS provider_events_claim_token_idx
  ON provider_events(provider, claim_token)
  WHERE claim_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_prepaid_purchases (
  payment_intent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL UNIQUE REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS stripe_prepaid_purchases_user_idx
  ON stripe_prepaid_purchases(user_id, created_at DESC);

/*
  Provider receipts live under `private/provider-events/<user>/`. They were
  already written there by the dual-write replica, but the deletion manifest's
  prefix constraint did not allow that namespace, so a native receipt could
  survive an account deletion. Rebuild the small manifest table to admit the
  exact private prefix and no broader path.
*/
PRAGMA foreign_keys = OFF;

CREATE TABLE account_deletion_objects_with_provider_events (
  user_id TEXT NOT NULL REFERENCES account_deletion_tombstones(user_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND (
      instr(object_key, 'private/avatars/' || user_id || '/') = 1
      OR instr(object_key, 'private/attempts/') = 1
      OR instr(object_key, 'private/subscriptions/' || user_id || '/') = 1
      OR instr(object_key, 'private/provider-events/' || user_id || '/') = 1
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

INSERT INTO account_deletion_objects_with_provider_events
SELECT user_id, object_key, discovered_at FROM account_deletion_objects;

DROP TABLE account_deletion_objects;
ALTER TABLE account_deletion_objects_with_provider_events RENAME TO account_deletion_objects;

PRAGMA foreign_keys = ON;
