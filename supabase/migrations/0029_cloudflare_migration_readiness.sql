/*
  Exact, privacy-minimised source evidence for the Cloudflare cutover report.

  Counts alone can agree while different rows are present. Each domain is
  therefore reduced to deterministic row identities plus source clocks or
  source-version evidence, ordered before aggregation, and then hashed in
  Postgres. No email, name, profile value or learner payload leaves this RPC.

  Supabase Auth is intentionally excluded. It remains the identity provider
  after application-data cutover and is not a domain being migrated.
*/

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.cloudflare_migration_fingerprint_field(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then '-:'
    else pg_catalog.octet_length(p_value)::text || ':' || p_value
  end;
$$;

revoke all on function public.cloudflare_migration_fingerprint_field(text)
  from public, anon, authenticated;

create or replace function public.cloudflare_migration_source_fingerprints()
returns table (domain text, row_count bigint, fingerprint text)
language sql
stable
security definer
set search_path = ''
as $$
  with evidence(domain, identity) as (
    select 'profiles',
           public.cloudflare_migration_fingerprint_field(p.id::text) || '|'
             || public.cloudflare_migration_fingerprint_field(p.email) || '|'
             || public.cloudflare_migration_fingerprint_field(p.role) || '|'
             || public.cloudflare_migration_fingerprint_field(p.display_name) || '|'
             || public.cloudflare_migration_fingerprint_field(p.birth_date::text) || '|'
             || public.cloudflare_migration_fingerprint_field(p.account_kind)
      from public.profiles p
    union all
    select 'usernames',
           public.cloudflare_migration_fingerprint_field(n.user_id::text) || '|'
             || public.cloudflare_migration_fingerprint_field(n.username::text)
      from public.usernames n
    union all
    select 'progress_snapshots',
           public.cloudflare_migration_fingerprint_field(s.user_id::text) || '|'
             || public.cloudflare_migration_fingerprint_field(s.store_key::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      from public.progress_snapshots s
    union all
    select 'subscriptions',
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
                  to_char(s.current_period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(s.cancel_at_period_end::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.provider_event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      from public.subscriptions s
    union all
    select 'provider_events',
           public.cloudflare_migration_fingerprint_field(e.provider::text) || '|'
             || public.cloudflare_migration_fingerprint_field(e.event_id::text)
      from public.provider_events e
    union all
    select 'usage_events',
           public.cloudflare_migration_fingerprint_field(e.id::text) || '|'
             || public.cloudflare_migration_fingerprint_field(e.user_id::text) || '|'
             || public.cloudflare_migration_fingerprint_field(e.route::text) || '|'
             || public.cloudflare_migration_fingerprint_field(e.ip_hash) || '|'
             || public.cloudflare_migration_fingerprint_field(e.outcome::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      from public.usage_events e
    union all
    select 'ai_cost_events',
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
             || public.cloudflare_migration_fingerprint_field(e.cost_usd::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      from public.ai_cost_events e
    union all
    select 'ai_cost_coverage',
           public.cloudflare_migration_fingerprint_field(e.singleton::text) || '|'
             || public.cloudflare_migration_fingerprint_field(e.source::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(e.historical_complete::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      from public.ai_cost_coverage e
  ), domains(domain) as (
    values ('profiles'), ('usernames'), ('progress_snapshots'), ('subscriptions'),
           ('provider_events'), ('usage_events'), ('ai_cost_events'), ('ai_cost_coverage')
  )
  select d.domain,
         count(e.identity)::bigint,
         encode(extensions.digest(coalesce(string_agg(e.identity, E'\n' order by e.identity), ''), 'sha256'), 'hex')
    from domains d
    left join evidence e on e.domain = d.domain
   group by d.domain
   order by d.domain;
$$;

revoke all on function public.cloudflare_migration_source_fingerprints()
  from public, anon, authenticated;
grant execute on function public.cloudflare_migration_source_fingerprints()
  to service_role;

notify pgrst, 'reload schema';
