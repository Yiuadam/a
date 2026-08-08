-- Row Level Security.
--
-- The rule for this whole file: a signed-in user may read the rows that belong
-- to them and nothing else, and no client role may write anything at all.
--
-- Writes are the application's job, and the application performs them with the
-- service role from server-side code only. The service role bypasses RLS, which
-- is exactly why it must never leave the server — see ACCOUNTS.md, threat 4.
--
-- Two layers are used deliberately:
--   1. GRANTs, which decide whether a role may touch the table at all.
--   2. POLICIES, which decide which rows.
-- Supabase grants broad table privileges to `anon` and `authenticated` on the
-- public schema by default, so the grants below are revoked first and then
-- re-issued narrowly. A policy alone would be enough; both together mean a
-- future policy mistake still cannot turn into a write.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- There is no insert, update or delete policy, and no write grant. In
-- particular this means `role` cannot be changed by its owner: a user cannot
-- make themselves an admin by writing to their own row, because they cannot
-- write to their own row at all.

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------

alter table public.subscriptions enable row level security;

revoke all on table public.subscriptions from anon, authenticated;
grant select on table public.subscriptions to authenticated;

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own
  on public.subscriptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No write path for clients. A subscription row appears only when a Stripe
-- webhook or an Apple receipt check has been verified server-side.

-- ---------------------------------------------------------------------------
-- usage_events
-- ---------------------------------------------------------------------------

alter table public.usage_events enable row level security;

revoke all on table public.usage_events from anon, authenticated;
grant select on table public.usage_events to authenticated;

drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own
  on public.usage_events
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Read-only, and only your own. A user can see how much of their allowance
-- they have spent; they cannot delete the evidence to get it back.

-- ---------------------------------------------------------------------------
-- progress_snapshots
-- ---------------------------------------------------------------------------

alter table public.progress_snapshots enable row level security;

revoke all on table public.progress_snapshots from anon, authenticated;
grant select on table public.progress_snapshots to authenticated;

drop policy if exists progress_snapshots_select_own on public.progress_snapshots;
create policy progress_snapshots_select_own
  on public.progress_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Phase 2 writes these through a server route that validates the payload
-- shape. Letting the browser write arbitrary JSON straight into the table
-- would make the progress record itself untrusted input.

-- ---------------------------------------------------------------------------
-- provider_events
-- ---------------------------------------------------------------------------

alter table public.provider_events enable row level security;

revoke all on table public.provider_events from anon, authenticated;

-- No grants and no policies: billing provider payloads are not user-facing
-- data. Only the service role can see this table.

-- ---------------------------------------------------------------------------
-- Default privileges for anything added later.
--
-- Without this, a future migration that creates a table in `public` inherits
-- Supabase's default grants to anon/authenticated and is exposed unless the
-- author remembers to lock it down. Flip the default the safe way round.
-- ---------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
