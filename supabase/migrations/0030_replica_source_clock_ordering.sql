-- Every successful mutable identity write needs a strictly increasing source
-- version for the temporary D1 outbox. PostgreSQL keeps microseconds; the
-- application preserves and canonicalises them before mirroring.

create or replace function public.claim_username(p_user_id uuid, p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name public.citext := lower(btrim(p_username));
  v_previous_updated_at timestamptz;
begin
  if v_name::text !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    return 'invalid';
  end if;

  if exists (
    select 1 from public.reserved_usernames r where r.username = v_name
  ) then
    return 'reserved';
  end if;

  -- Lock the source-version row before changing the username so two requests
  -- for the same account cannot observe or emit the same replica clock.
  select updated_at into v_previous_updated_at
    from public.profiles where id = p_user_id for update;
  if not found then
    return 'invalid';
  end if;

  update public.usernames
     set username = v_name
   where user_id = p_user_id;
  if not found then
    insert into public.usernames (username, user_id) values (v_name, p_user_id);
  end if;

  update public.profiles
     set updated_at = greatest(
       clock_timestamp(),
       coalesce(v_previous_updated_at, '-infinity'::timestamptz) + interval '1 microsecond'
     )
   where id = p_user_id;
  return 'ok';
exception
  when unique_violation then return 'taken';
end;
$$;

create or replace function public.set_account_identity(
  p_user_id uuid,
  p_display_name text,
  p_username text,
  p_account_kind text,
  p_birth_date date default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_username public.citext := lower(btrim(coalesce(p_username, '')));
  v_previous_updated_at timestamptz;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 60 then return 'invalid_display_name'; end if;
  if p_account_kind not in ('individual', 'student', 'teacher') then return 'invalid_account_kind'; end if;
  if v_username::text !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then return 'invalid_username'; end if;
  select updated_at into v_previous_updated_at
    from public.profiles where id = p_user_id for update;
  if not found then return 'missing_profile'; end if;
  if exists (
    select 1 from public.reserved_usernames r where r.username = v_username
  ) then
    return 'reserved_username';
  end if;

  update public.usernames set username = v_username where user_id = p_user_id;
  if not found then
    insert into public.usernames (username, user_id) values (v_username, p_user_id);
  end if;

  update public.profiles
     set display_name = v_name,
         account_kind = p_account_kind,
         birth_date = p_birth_date,
         updated_at = greatest(
           clock_timestamp(),
           coalesce(v_previous_updated_at, '-infinity'::timestamptz) + interval '1 microsecond'
         )
   where id = p_user_id;
  return 'ok';
exception
  when unique_violation then return 'taken_username';
end;
$$;

revoke all on function public.claim_username(uuid, text)
  from public, anon, authenticated;
revoke all on function public.set_account_identity(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function public.claim_username(uuid, text) to service_role;
grant execute on function public.set_account_identity(uuid, text, text, text, date)
  to service_role;

notify pgrst, 'reload schema';
