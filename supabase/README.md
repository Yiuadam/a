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

`0005` is the one file that may not do everything it says. Its storage policy
needs ownership of `storage.objects`, which the SQL editor has on most projects
and not on all; where it does not, the file raises a notice, applies everything
else and carries on. That is safe — the `avatars` bucket is private, no client
role is granted anything on it, and the application serves signed URLs — so the
policy is a second lock rather than the only one. Add it from **Storage →
Policies** in the dashboard if you want it.

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

Worth doing once by hand after the first deploy, because a policy that is
subtly wrong looks exactly like a policy that is right.

Sign in as a normal user, take that user's access token, and try to read
somebody else's row:

```sh
curl "$SUPABASE_URL/rest/v1/profiles?select=*" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"
```

The correct result is a JSON array containing exactly one object — the caller's
own profile — regardless of how many users exist. Then try to write:

```sh
curl -X PATCH "$SUPABASE_URL/rest/v1/profiles?id=eq.$USER_ID" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}'
```

The correct result is a permission error. If that request succeeds, the whole
admin model is void and `0002_rls.sql` did not apply.

Finally, confirm the meter is not callable from outside:

```sh
curl -X POST "$SUPABASE_URL/rest/v1/rpc/check_and_record_usage" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_user_id":null,"p_ip_hash":null,"p_route":"define","p_window_seconds":86400,"p_limits":{}}'
```

This must fail. A callable meter is a resettable meter.
