/*
  The bit of Supabase a migration needs before it will apply.

  These tests prove migrations against a real Postgres rather than a mock,
  which only works if the cluster looks enough like Supabase for the migration
  to land the same way. Three test files needed that and each grew its own
  byte-identical copy, so a correction to one silently left the other two
  wrong — which is exactly how the pgcrypto schema below was found. One copy,
  imported, is the only arrangement where fixing it once fixes it.

  The pgcrypto placement is the subtle part. Supabase installs it into its own
  `extensions` schema, and migrations call it qualified, as
  `extensions.digest(...)`. Installing it here without a schema puts it in
  `public` instead, and that fails in a way that reads as a migration bug: the
  migration's own `create extension if not exists pgcrypto with schema
  extensions` finds the extension already present, skips — announcing only a
  NOTICE — and then the qualified call has nothing to resolve to. So the stub
  has to put it where Supabase puts it, or it is not a stub of Supabase.

  `gen_random_uuid()` below does not depend on that: it has been core Postgres
  since version 13.
*/
export const SUPABASE_STUB = `
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
`;
