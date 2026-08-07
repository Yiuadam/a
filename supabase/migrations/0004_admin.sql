-- Promoting an account to admin.
--
-- The owner's own account is the only admin, and this is how it gets flagged.
-- Note what is *not* here: the owner's email address. This file is committed to
-- a repository that may one day be public, and an email in a migration is one
-- copy too many. The address is supplied at the moment the function is called,
-- by a human with database access — see supabase/README.md.

create or replace function public.set_account_role(p_email text, p_role text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_role not in ('user', 'admin') then
    raise exception 'role must be user or admin';
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'no account exists for that address — sign up first, then promote';
  end if;

  insert into public.profiles (id, email, role)
  values (v_user_id, lower(trim(p_email)), p_role)
  on conflict (id) do update set role = excluded.role;

  return v_user_id;
end;
$$;

-- Same reasoning as 0003: PUBLIC gets EXECUTE by default and PostgREST would
-- publish this as an HTTP endpoint. A self-service "make me an admin" button
-- is precisely what this must not be.
revoke execute on function public.set_account_role(text, text) from public, anon, authenticated;
grant execute on function public.set_account_role(text, text) to service_role;
