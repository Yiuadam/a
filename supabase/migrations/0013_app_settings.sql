/*
  Settings the running site reads, and the owner can change without a deploy.

  ---------------------------------------------------------------------------
  Why this exists

  Closing the site for maintenance was a build-time flag: the only way to throw
  the switch was to run a deploy and wait for it. That is fine for planned work
  and useless in the case you most want a switch for — something is wrong now,
  and the deploy that would close the site is the thing that is broken.

  So the flag moves into the one place the running site can read and the owner
  can write: a row in a table. One request closes the site.

  ---------------------------------------------------------------------------
  A table of keys rather than a column per setting

  Because the alternative is a migration every time the owner wants a switch,
  and a migration on this project changes production the moment it runs. A
  key-value shelf is the shape that stops the next setting needing one at all.

  jsonb rather than text so a setting can grow a field — a maintenance notice
  might one day want a message or an expected-back time — without another
  migration for that either.
*/

create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  /*
    Who changed it. Nullable because a setting can be seeded by a migration,
    which has no actor, and `on delete set null` because losing the audit line
    is a smaller loss than refusing to delete an account over it.
  */
  updated_by  uuid references auth.users (id) on delete set null
);

/*
  Nobody reaches this table except through the two functions below.

  RLS with no policy denies every request that is not the service role, which
  is exactly the intent: the anon key must never read or write settings, and
  the service role — which only the server holds — goes through functions that
  can be reasoned about one at a time.
*/
alter table public.app_settings enable row level security;

/*
  Read one setting.

  Returns SQL NULL for a key that has never been set, and every caller is
  written to treat that as "off". That direction matters: an unknown key, a
  fresh database, or a migration that has not been applied yet must all leave
  the site open. A settings shelf that could close a site by being empty would
  be a worse failure than the one it was built to fix.
*/
create or replace function public.get_app_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select value from public.app_settings where key = p_key;
$$;

/*
  Write one setting, and record who did it.

  Upsert rather than update, so the first write of a key does not need the row
  to have been seeded. Returns the stored value so the caller can report what
  is now true rather than what it asked for — those differ whenever two admins
  press the same button at once, and the second one deserves to see the answer
  rather than their own request echoed back.
*/
create or replace function public.set_app_setting(
  p_key   text,
  p_value jsonb,
  p_actor uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  insert into public.app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), p_actor)
  on conflict (key) do update
    set value = excluded.value,
        updated_at = now(),
        updated_by = excluded.updated_by
  returning value into v_value;

  return v_value;
end;
$$;

revoke all on function public.get_app_setting(text) from public, anon, authenticated;
revoke all on function public.set_app_setting(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.get_app_setting(text) to service_role;
grant execute on function public.set_app_setting(text, jsonb, uuid) to service_role;

/*
  PostgREST caches the schema and will answer 404 for a function it has not
  seen. Every migration in this project ends this way, and the one that did not
  cost an afternoon of debugging a webhook that was answering 503 for a function
  that existed.
*/
notify pgrst, 'reload schema';
