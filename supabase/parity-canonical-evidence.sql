-- ---------------------------------------------------------------------------
-- Compare the mirror by value, not by spelling.
--
-- SUPERSEDES supabase/parity-millisecond-precision.sql, which this file was
-- renamed from. If you have already run that one, run this one too: it repeats
-- the timestamp fix unchanged and adds the money fix below. Running it twice is
-- harmless; every statement is `create or replace`.
--
-- This is NOT in `migrations/`, and `supabase db push` will not run it. Paste
-- it into the SQL editor. It replaces two existing functions in place and adds
-- one small pure helper used only by them: it adds no table, alters no row,
-- and reads nothing it did not already read. Running it changes how parity is
-- *measured*, and nothing about what is stored.
--
-- ---------------------------------------------------------------------------
-- What was wrong
--
-- PostgreSQL keeps timestamps to the microsecond. Everything that copies a row
-- into D1 goes through JavaScript, where a Date holds milliseconds, so the last
-- three digits are gone before the value reaches Cloudflare -- on every write,
-- by construction.
--
-- Both fingerprint functions hashed the source with `.US` (six digits) while
-- the target could only ever offer three. A row stored at .673830 was compared
-- as `.673830Z` against `.673000Z` and reported as different. Different every
-- time, for every row whose microseconds were not already zero.
--
-- On the production database that was 123 of 123 usage events, 15 of 15
-- progress snapshots, 3 of 3 AI cost events and the single cost-coverage row:
-- four domains reading as wholly corrupt while the mirror was in fact copying
-- them correctly. The domains that read as equal were simply the ones carrying
-- few timestamps, which is why this looked like a data fault rather than a
-- measurement one.
--
-- ---------------------------------------------------------------------------
-- What changes
--
-- `.US` becomes `.MS` in both functions -- eleven timestamps in each. Postgres
-- truncates rather than rounds for `MS`, which matches what the write path
-- already does (`Date.parse('...673830Z')` is 673, not 674), so this agrees
-- with the value D1 actually holds rather than with a tidier one.
--
-- The replication clock is NOT changed and still carries all nine digits.
-- Ordering wants every digit available; equality wants only the digits both
-- sides hold.
--
-- Second, `cost_usd` is no longer hashed as `::text`. Postgres renders a
-- numeric at its declared scale (`0.050000000`) while D1 holds what
-- usdFromNanodollars wrote (`0.05`), so all three ai_cost_events rows compared
-- as different for their punctuation. A new helper,
-- cloudflare_migration_money_field, reduces the source to the same minimal
-- spelling the application already writes.
--
-- The Worker half of this change ships in the same pull request, so run this
-- when that deploys. Running it early makes the source three digits while the
-- target is still padded to six, which reports the same domains as differing
-- for the opposite reason -- no data is harmed either way.
--
-- ---------------------------------------------------------------------------
-- To undo, re-run migration 0029 and supabase/row-drift-rpc.sql from the
-- revision before this change; both are `create or replace`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The money helper, added by this file.
--
-- Postgres renders a numeric at its declared scale, so five cents is
-- 0.050000000. D1 holds what usdFromNanodollars wrote, which strips trailing
-- zeros, so the same five cents is 0.05. Same money, different spelling,
-- different hash -- and all three ai_cost_events rows reported as different
-- because of it.
--
-- The application already decided what the canonical spelling is, and it is
-- the minimal one: usdFromNanodollars builds the string from bigint
-- nanodollars, exactly, with no float to round. So the source is brought to
-- the target's spelling rather than the reverse.
--
-- Written with regexp rather than trim_scale() so it does not depend on the
-- server version, and so what it does is legible here rather than in a manual.
-- ---------------------------------------------------------------------------

create or replace function public.cloudflare_migration_money_field(p_value numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    -- '0.050000000' -> '0.05'; '5.000000000' -> '5'; '-0.000' -> '0'.
    when regexp_replace(regexp_replace(p_value::text, '(\.[0-9]*?)0+$', '\1'), '\.$', '') = '-0'
      then '0'
    else regexp_replace(regexp_replace(p_value::text, '(\.[0-9]*?)0+$', '\1'), '\.$', '')
  end;
$$;

revoke all on function public.cloudflare_migration_money_field(numeric)
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
                  to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
                  to_char(s.current_period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(s.cancel_at_period_end::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.provider_event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
                  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
             || public.cloudflare_migration_fingerprint_field(public.cloudflare_migration_money_field(e.cost_usd)) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      from public.ai_cost_events e
    union all
    select 'ai_cost_coverage',
           public.cloudflare_migration_fingerprint_field(e.singleton::text) || '|'
             || public.cloudflare_migration_fingerprint_field(e.source::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || '|'
             || public.cloudflare_migration_fingerprint_field(e.historical_complete::text) || '|'
             || public.cloudflare_migration_fingerprint_field(
                  to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
