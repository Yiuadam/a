-- ---------------------------------------------------------------------------
-- Per-row parity evidence for the Cloudflare cutover report.
--
-- This is NOT in `migrations/`, and `supabase db push` will not run it. Paste
-- it into the SQL editor when you want the readiness report to be able to name
-- the rows that are drifting. Creating a function changes the live project the
-- moment you run it, so run it deliberately; it is otherwise read-only, adds no
-- table, alters no row and can be dropped again with the statements at the
-- bottom.
--
-- What it adds: `cloudflare_migration_source_row_fingerprints(domain, after,
-- limit)`, a keyset-paged listing of (row key, sha256 of that row's evidence)
-- for one domain, ordered by key in C collation. The evidence string is exactly
-- the one the whole-domain fingerprint hashes, so a
-- per-row hash that differs from D1's is a real difference in a stored value.
--
-- Depends on supabase/parity-canonical-evidence.sql, which defines
-- cloudflare_migration_money_field. Run that first, or this function will
-- error the moment it is asked for the ai_cost_events domain.
--
-- No email, display name, payload, transcript or event body leaves this
-- function. The key is an account id, a username, a store key, a provider
-- event id or the constant 'singleton'; everything else is a one-way hash.
--
-- Service role only, like every other migration-evidence function.
-- ---------------------------------------------------------------------------

create or replace function public.cloudflare_migration_source_row_fingerprints(
  p_domain text,
  p_after text default '',
  p_limit integer default 500
)
returns table (row_key text, fingerprint text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_after text := coalesce(p_after, '');
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
begin
  if p_domain = 'profiles' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select p.id::text as row_key,
                 public.cloudflare_migration_fingerprint_field(p.id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(p.email) || '|'
                   || public.cloudflare_migration_fingerprint_field(p.role) || '|'
                   || public.cloudflare_migration_fingerprint_field(p.display_name) || '|'
                   || public.cloudflare_migration_fingerprint_field(p.birth_date::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(p.account_kind) as identity
            from public.profiles p
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'usernames' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select n.username::text as row_key,
                 public.cloudflare_migration_fingerprint_field(n.user_id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(n.username::text) as identity
            from public.usernames n
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'progress_snapshots' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select s.user_id::text || '/' || s.store_key::text as row_key,
                 public.cloudflare_migration_fingerprint_field(s.user_id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.store_key::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as identity
            from public.progress_snapshots s
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'subscriptions' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select s.id::text as row_key,
                 public.cloudflare_migration_fingerprint_field(s.id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.user_id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.provider::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.status::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.tier::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.external_customer_id) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.external_subscription_id) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.original_transaction_id) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.external_price_id) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(s.current_period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
                   || public.cloudflare_migration_fingerprint_field(s.cancel_at_period_end::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(s.provider_event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(s.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as identity
            from public.subscriptions s
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'provider_events' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select e.provider::text || '/' || e.event_id::text as row_key,
                 public.cloudflare_migration_fingerprint_field(e.provider::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.event_id::text) as identity
            from public.provider_events e
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'usage_events' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select e.id::text as row_key,
                 public.cloudflare_migration_fingerprint_field(e.id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.user_id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.route::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.ip_hash) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.outcome::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as identity
            from public.usage_events e
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'ai_cost_events' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          select e.id::text as row_key,
                 public.cloudflare_migration_fingerprint_field(e.id::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.source) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.provider_request_id) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.external_reference) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.route) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.model) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.input_tokens::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.output_tokens::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.cache_creation_input_tokens::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.cache_creation_5m_input_tokens::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.cache_creation_1h_input_tokens::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.cache_read_input_tokens::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(public.cloudflare_migration_money_field(e.cost_usd)) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as identity
            from public.ai_cost_events e
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'ai_cost_coverage' then
    return query
      select k.row_key,
             encode(extensions.digest(k.identity, 'sha256'), 'hex')
        from (
          -- One row, and its key is a constant: D1 stores the marker as the
          -- integer 1 and Postgres as the boolean true, so neither spelling
          -- can be the shared key.
          select 'singleton'::text as row_key,
                 public.cloudflare_migration_fingerprint_field(e.singleton::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.source::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
                   || public.cloudflare_migration_fingerprint_field(e.historical_complete::text) || '|'
                   || public.cloudflare_migration_fingerprint_field(
                        to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as identity
            from public.ai_cost_coverage e
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  else
    -- An unknown domain returns nothing rather than raising. The caller then
    -- reports the domain as missing on the source side, which is the truth.
    return;
  end if;
end;
$$;

revoke all on function public.cloudflare_migration_source_row_fingerprints(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.cloudflare_migration_source_row_fingerprints(text, text, integer)
  to service_role;

notify pgrst, 'reload schema';

-- To remove it again:
-- drop function if exists public.cloudflare_migration_source_row_fingerprints(text, text, integer);
-- notify pgrst, 'reload schema';
