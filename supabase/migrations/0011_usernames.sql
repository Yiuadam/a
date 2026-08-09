-- ---------------------------------------------------------------------------
-- Usernames, and the one place uniqueness can actually be enforced.
--
-- Today exactly one username exists — the owner's, from ADMIN_USERNAME — and a
-- learner has no way to choose one. This file is therefore not urgent, and it
-- is deliberately written before it is needed, because the guarantee it makes
-- cannot be added afterwards. Two people who have both been given the name
-- "sam" cannot be made unique later without taking it off one of them.
--
-- Nothing in the application reads these tables yet. Applying this file changes
-- no behaviour; it makes the guarantee available.
--
-- Safe to run twice — supabase/README.md tells a human to paste these into the
-- SQL editor by hand, and a human pasting a file twice is ordinary rather than
-- an error.
-- ---------------------------------------------------------------------------

-- citext so that "Sam" and "sam" are the same key rather than two rows that
-- both satisfy a primary key and collide the moment anybody logs in.
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- The names nobody may claim.
--
-- A table rather than a constant in application code, because the check that
-- matters happens inside the transaction that inserts the row. A list held in
-- TypeScript is consulted before the insert and is therefore advisory: two
-- requests can both read it, both pass, and both proceed.
--
-- Two kinds of name, one rule. Roles a learner could be mistaken for — a
-- message from "support" should not be from another learner — and words this
-- app routes on, so a username can never shadow a path.
-- ---------------------------------------------------------------------------
create table if not exists public.reserved_usernames (
  username citext primary key
);

insert into public.reserved_usernames (username) values
  ('account'), ('accounts'), ('admin'), ('administrator'), ('api'), ('auth'),
  ('bandup'), ('billing'), ('contact'), ('help'), ('info'), ('mod'),
  ('moderator'), ('official'), ('owner'), ('practice'), ('privacy'), ('root'),
  ('security'), ('settings'), ('staff'), ('support'), ('system'), ('team'),
  ('terms'), ('test'), ('webmaster'), ('www')
on conflict (username) do nothing;

-- ---------------------------------------------------------------------------
-- The names themselves.
--
-- `username` is the primary key, which is the whole point of the file: two
-- sign-ups a millisecond apart both ask "is this name taken?", both are told
-- no, and both insert. Only a unique index settles that, and it settles it by
-- refusing the second insert rather than by being asked politely first.
--
-- `user_id` is unique too, so an account has at most one name. Changing your
-- name is an update, which keeps the history of who held a name from becoming
-- a set of rows nobody can order.
--
-- The CHECK repeats lib/auth/usernames.ts on purpose. The application rule is
-- a rule until somebody writes a row another way — a migration, a dashboard, a
-- script — and this is the copy that cannot be bypassed. In particular it
-- forbids '@', which is load-bearing: the sign-in form has one field and
-- decides by looking for an @, so a username containing one could shadow
-- somebody's email address.
-- ---------------------------------------------------------------------------
create table if not exists public.usernames (
  username   citext primary key
             check (username ~ '^[a-z0-9][a-z0-9._-]{2,29}$'),
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.usernames enable row level security;
alter table public.reserved_usernames enable row level security;

-- No policies, deliberately. Every read and write goes through the functions
-- below, which run as their definer; a client holding the anon key can reach
-- neither table directly. Enabling RLS with no policy is how that is spelled.

-- ---------------------------------------------------------------------------
-- Claiming a name.
--
-- Returns a short status rather than raising, because every outcome here is a
-- thing a person did rather than a fault: the name is taken, the name is
-- reserved, the name is the wrong shape. A caller that has to parse a Postgres
-- error message to tell those apart will eventually parse it wrong.
--
-- The insert is the availability check. There is no select-then-insert, and
-- there is no `exists` test — those are the shapes that race.
-- ---------------------------------------------------------------------------
create or replace function public.claim_username(p_user_id uuid, p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name citext := lower(btrim(p_username));
begin
  if v_name !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    return 'invalid';
  end if;

  if exists (select 1 from public.reserved_usernames r where r.username = v_name) then
    return 'reserved';
  end if;

  -- Same account changing its own name: an update, not a second row.
  update public.usernames
     set username = v_name
   where user_id = p_user_id;
  if found then
    return 'ok';
  end if;

  insert into public.usernames (username, user_id) values (v_name, p_user_id);
  return 'ok';
exception
  -- Covers both unique indexes: somebody else holds the name, or this account
  -- raced with itself from two tabs.
  when unique_violation then
    return 'taken';
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolving a name at sign-in.
--
-- Returns the address, or null. Null covers "no such name" and is the only
-- thing the caller may learn, because a sign-in form that distinguishes an
-- unknown name from a wrong password is a way to ask whether a given person
-- uses this app, one name at a time.
-- ---------------------------------------------------------------------------
create or replace function public.email_for_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select u.email
    from public.usernames n
    join auth.users u on u.id = n.user_id
   where n.username = lower(btrim(p_username));
$$;

-- Only the server may call either. Both are security definer and read
-- auth.users, so a grant to `authenticated` would hand every signed-in client
-- a way to turn a name into an email address.
revoke execute on function public.claim_username(uuid, text) from public, anon, authenticated;
revoke execute on function public.email_for_username(text) from public, anon, authenticated;
grant execute on function public.claim_username(uuid, text) to service_role;
grant execute on function public.email_for_username(text) to service_role;
