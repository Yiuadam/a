# Supabase

The database behind accounts, subscriptions and usage metering. Nothing in the
app reads it unless `ACCOUNTS_ENABLED=1`, so this can be set up, or not set up,
without the deployed app noticing either way.

## Applying the migrations

The files in `migrations/` are ordinary SQL and run in filename order.

With the Supabase CLI, against a linked project:

```sh
supabase db push
```

Or paste each file, in order, into the SQL editor in the Supabase dashboard.
They are written to be re-runnable: tables use `create table if not exists`,
functions use `create or replace`, and triggers and policies are dropped before
being recreated.

| File | What it does |
| --- | --- |
| `0001_accounts_core.sql` | Tables: profiles, subscriptions, usage events, progress snapshots, provider events. Triggers for `updated_at` and for creating a profile on signup. |
| `0002_rls.sql` | Row Level Security. Read your own rows; write nothing. |
| `0003_entitlements.sql` | The entitlement resolver and the usage meter, as functions callable only by the service role. |
| `0004_admin.sql` | `set_account_role`, for promoting an account to admin. |
| `0005_profile_fields.sql` | Display name, avatar path and date of birth on `profiles`, and a private `avatars` bucket. |
| `0006_drop_gender_add_age_check.sql` | Drops `gender`, and makes the under-13 claim on `/privacy` a constraint rather than a sentence. |
| `0015_ai_cost_tracking.sql` | Service-role-only AI cost ledger: per-response token-cost rows, private provider backfill and explicit history-coverage markers, and an owner-dashboard aggregate with no user data or content. |

`0005` is the one file that may not do everything it says, and it is written
so that this cannot hurt. Its two storage steps — creating the private
`avatars` bucket and putting a policy on it — need rights over
`storage.buckets` and `storage.objects`, which are owned by
`supabase_storage_admin` and not reachable from every project's SQL editor.

Each step is guarded separately, so a refusal becomes a notice carrying the
real error rather than a failed file. That matters more than it sounds: the SQL
editor runs a pasted file as a single transaction, so without the guards one
refused storage statement would roll back the profile columns as well — and
`0006` would then fail with `column "birth_date" does not exist`, pointing at
the wrong file entirely.

If you see the bucket notice, make it by hand: **Storage → New bucket**, name
`avatars`, Public **off**, file size limit 2 MB, allowed MIME types
`image/jpeg, image/png, image/webp`. Profile pictures will not upload until it
exists. If you see only the policy notice, nothing needs doing — the bucket is
private, no client role holds a storage grant, and every read is a short-lived
signed URL issued by the server.

## Making the owner an admin

An admin has no usage limit. There is exactly one, and this is how it is set.

The owner's email address is deliberately not in this repository — not in a
migration, not in a seed file, and above all not in anything that compiles into
the browser. It is supplied at the moment the function is called, by someone
with database access:

```sql
select public.set_account_role('the-owner@example.com', 'admin');
```

Run it in the Supabase SQL editor. The account has to exist first: sign in once
through the app, then promote. To undo, pass `'user'`.

`set_account_role` is `security definer` and `execute` is revoked from every
client role, so it is not reachable over the API — only from the SQL editor or
from server code holding the service role key.

## Checking the policies actually hold

Worth doing once against a real project, because a policy that is subtly wrong
looks exactly like a policy that is right.

Paste `probes.sql` into the SQL editor and run it. It becomes the
`authenticated` role carrying a real account's JWT claims — which is what a
signed-in learner's token does when it talks to PostgREST directly, bypassing
the application — and then tries the ten things a learner must not be able to
do. Each prints PASS or FAIL. It writes nothing and changes nothing.

```
PASS  1. Reading profiles returns 1 row of 2 that exist.
PASS  2. Someone else's profile is invisible.
PASS  3. Cannot promote self to admin (permission denied for table profiles).
...
All 10 checks passed. Nothing was written or changed.
```

Two of the ten compare your row against someone else's, so with a single
account they report SKIP rather than passing for the wrong reason: with nothing
to hide, an empty result and an absent policy look identical. Sign in with a
second account and run it again to test those two for real.

The same thing over HTTP, if you have a terminal and a user's access token:

```sh
curl "$SUPABASE_URL/rest/v1/profiles?select=*" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```

The correct result is an array containing exactly one object — the caller's own
profile — however many accounts exist.
