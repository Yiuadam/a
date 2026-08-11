/*
  A privacy-minimal ledger for the money spent on Anthropic Messages.

  New calls are calculated from the token counts Anthropic returns with each
  successful response. Historical daily totals may be added separately from
  the provider console. Neither form stores a user id, prompt, response, email,
  or any other learner data.

  The two sources deliberately remain distinguishable. A provider-reported
  historical amount must never be presented as though it were a reconstruction
  from tokens, and a locally calculated amount must never be described as an
  invoice or provider-billed total.
*/

create table if not exists public.ai_cost_events (
  id bigint generated always as identity primary key,
  source text not null,
  provider_request_id text unique,
  external_reference text unique,
  route text,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  cache_creation_input_tokens bigint,
  cache_creation_5m_input_tokens bigint,
  cache_creation_1h_input_tokens bigint,
  cache_read_input_tokens bigint,
  cost_usd numeric(30, 9) not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),

  constraint ai_cost_events_source_check
    check (source in ('calculated_tokens', 'provider_backfill')),
  constraint ai_cost_events_cost_check check (cost_usd >= 0),
  constraint ai_cost_events_reference_length_check check (
    (provider_request_id is null or length(provider_request_id) between 1 and 255)
    and (external_reference is null or length(external_reference) between 1 and 255)
  ),
  constraint ai_cost_events_route_model_length_check check (
    (route is null or length(route) between 1 and 120)
    and (model is null or length(model) between 1 and 255)
  ),
  constraint ai_cost_events_nonnegative_tokens_check check (
    (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
    and (cache_creation_input_tokens is null or cache_creation_input_tokens >= 0)
    and (cache_creation_5m_input_tokens is null or cache_creation_5m_input_tokens >= 0)
    and (cache_creation_1h_input_tokens is null or cache_creation_1h_input_tokens >= 0)
    and (cache_read_input_tokens is null or cache_read_input_tokens >= 0)
  ),
  constraint ai_cost_events_shape_check check (
    (
      source = 'calculated_tokens'
      and provider_request_id is not null
      and external_reference is null
      and route is not null
      and model is not null
      and input_tokens is not null
      and output_tokens is not null
      and cache_creation_input_tokens is not null
      and cache_creation_5m_input_tokens is not null
      and cache_creation_1h_input_tokens is not null
      and cache_read_input_tokens is not null
      and cache_creation_input_tokens =
        cache_creation_5m_input_tokens + cache_creation_1h_input_tokens
    )
    or
    (
      source = 'provider_backfill'
      and provider_request_id is null
      and external_reference is not null
      and route is null
      and model is null
      and input_tokens is null
      and output_tokens is null
      and cache_creation_input_tokens is null
      and cache_creation_5m_input_tokens is null
      and cache_creation_1h_input_tokens is null
      and cache_read_input_tokens is null
    )
  )
);

create index if not exists ai_cost_events_occurred_at_idx
  on public.ai_cost_events (occurred_at);

alter table public.ai_cost_events enable row level security;

/*
  Coverage is explicit, not guessed from the first ledger row. The private
  backfill operator sets this only after reconciling the provider's complete
  history. No date is public source code, and an incomplete ledger therefore
  reports itself as incomplete by default.
*/
create table if not exists public.ai_cost_coverage (
  singleton boolean primary key default true check (singleton),
  source text not null check (source in ('provider_console', 'local_tracking')),
  starts_at timestamptz not null,
  historical_complete boolean not null default false,
  recorded_at timestamptz not null default now()
);

alter table public.ai_cost_coverage enable row level security;

/*
  A successful Message response is inserted once. Provider request ids are
  unique, so a retry of the bookkeeping call is harmless and cannot double
  charge the dashboard.
*/
create or replace function public.record_ai_cost_event(
  p_provider_request_id text,
  p_route text,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cache_creation_input_tokens bigint,
  p_cache_creation_5m_input_tokens bigint,
  p_cache_creation_1h_input_tokens bigint,
  p_cache_read_input_tokens bigint,
  p_cost_usd numeric,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_cost_events (
    source,
    provider_request_id,
    route,
    model,
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens,
    cache_read_input_tokens,
    cost_usd,
    occurred_at
  ) values (
    'calculated_tokens',
    p_provider_request_id,
    p_route,
    p_model,
    p_input_tokens,
    p_output_tokens,
    p_cache_creation_input_tokens,
    p_cache_creation_5m_input_tokens,
    p_cache_creation_1h_input_tokens,
    p_cache_read_input_tokens,
    p_cost_usd,
    p_occurred_at
  )
  on conflict (provider_request_id) do nothing;

  return found;
end;
$$;

/*
  Historical provider-console totals use a separate entry point and a caller-
  supplied stable reference such as an export row id plus date. No amount is
  embedded in this migration; backfill is an explicit private operation.
*/
create or replace function public.record_ai_cost_backfill(
  p_external_reference text,
  p_cost_usd numeric,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_cost_events (
    source,
    external_reference,
    cost_usd,
    occurred_at
  ) values (
    'provider_backfill',
    p_external_reference,
    p_cost_usd,
    p_occurred_at
  )
  on conflict (external_reference) do nothing;

  return found;
end;
$$;

/* Marks the date and evidence basis from which the ledger is complete. */
create or replace function public.set_ai_cost_coverage(
  p_source text,
  p_starts_at timestamptz,
  p_historical_complete boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_cost_coverage (
    singleton,
    source,
    starts_at,
    historical_complete,
    recorded_at
  ) values (
    true,
    p_source,
    p_starts_at,
    p_historical_complete,
    now()
  )
  on conflict (singleton) do update set
    source = excluded.source,
    starts_at = excluded.starts_at,
    historical_complete = excluded.historical_complete,
    recorded_at = now();

  return true;
end;
$$;

/*
  Owner-dashboard aggregate. Money is returned as exact decimal USD cents in
  strings (`costMinorUnits`) so JSON/JavaScript cannot round sub-cent spend.
  Token totals are strings for the same reason: a lifetime counter may one day
  exceed JavaScript's safe integer range.

  `requestCount` counts actual Message responses only. `backfillRowCount`
  counts provider daily rows, not API requests.
*/
create or replace function public.admin_ai_cost_snapshot(p_days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select least(greatest(coalesce(p_days, 30), 1), 366)::integer as days
  ),
  bounds as (
    select
      requested.days,
      (now() at time zone 'UTC')::date - (requested.days - 1) as start_day,
      (now() at time zone 'UTC')::date as end_day
    from requested
  ),
  lifetime as (
    select
      coalesce(sum(e.cost_usd), 0)::numeric as cost_usd,
      coalesce(sum(e.cost_usd) filter (where e.source = 'calculated_tokens'), 0)::numeric
        as calculated_cost_usd,
      coalesce(sum(e.cost_usd) filter (where e.source = 'provider_backfill'), 0)::numeric
        as provider_backfill_cost_usd,
      coalesce(sum(e.input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(e.output_tokens), 0)::bigint as output_tokens,
      coalesce(sum(e.cache_creation_input_tokens), 0)::bigint as cache_creation_input_tokens,
      coalesce(sum(e.cache_read_input_tokens), 0)::bigint as cache_read_input_tokens,
      count(e.provider_request_id)::bigint as request_count,
      count(*) filter (where e.source = 'provider_backfill')::bigint as backfill_row_count,
      min(e.occurred_at) as starts_at
    from public.ai_cost_events e
  ),
  period as (
    select
      coalesce(sum(e.cost_usd), 0)::numeric as cost_usd,
      coalesce(sum(e.cost_usd) filter (where e.source = 'calculated_tokens'), 0)::numeric
        as calculated_cost_usd,
      coalesce(sum(e.cost_usd) filter (where e.source = 'provider_backfill'), 0)::numeric
        as provider_backfill_cost_usd,
      coalesce(sum(e.input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(e.output_tokens), 0)::bigint as output_tokens,
      coalesce(sum(e.cache_creation_input_tokens), 0)::bigint as cache_creation_input_tokens,
      coalesce(sum(e.cache_read_input_tokens), 0)::bigint as cache_read_input_tokens,
      count(e.provider_request_id)::bigint as request_count,
      count(*) filter (where e.source = 'provider_backfill')::bigint as backfill_row_count
    from public.ai_cost_events e
    cross join bounds b
    where e.occurred_at >= (b.start_day::timestamp at time zone 'UTC')
      and e.occurred_at < ((b.end_day + 1)::timestamp at time zone 'UTC')
  ),
  days as (
    select generate_series(b.start_day, b.end_day, interval '1 day')::date as day
    from bounds b
  ),
  daily as (
    select
      d.day,
      coalesce(sum(e.cost_usd), 0)::numeric as cost_usd,
      coalesce(sum(e.cost_usd) filter (where e.source = 'calculated_tokens'), 0)::numeric
        as calculated_cost_usd,
      coalesce(sum(e.cost_usd) filter (where e.source = 'provider_backfill'), 0)::numeric
        as provider_backfill_cost_usd,
      coalesce(sum(e.input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(e.output_tokens), 0)::bigint as output_tokens,
      coalesce(sum(e.cache_creation_input_tokens), 0)::bigint as cache_creation_input_tokens,
      coalesce(sum(e.cache_read_input_tokens), 0)::bigint as cache_read_input_tokens,
      count(e.provider_request_id)::bigint as request_count,
      count(*) filter (where e.source = 'provider_backfill')::bigint as backfill_row_count
    from days d
    left join public.ai_cost_events e
      on (e.occurred_at at time zone 'UTC')::date = d.day
    group by d.day
  )
  select jsonb_build_object(
    'source', 'local_cost_ledger',
    'currency', 'USD',
    'asOf', now(),
    'periodDays', b.days,
    'coverage', jsonb_build_object(
      'source', (select c.source from public.ai_cost_coverage c where c.singleton),
      'startsAt', (select c.starts_at from public.ai_cost_coverage c where c.singleton),
      'historicalComplete', coalesce(
        (select c.historical_complete from public.ai_cost_coverage c where c.singleton),
        false
      ),
      'includesProviderBackfill', (l.backfill_row_count > 0)
    ),
    'lifetime', jsonb_build_object(
      'costMinorUnits', (l.cost_usd * 100)::text,
      'calculatedCostMinorUnits', (l.calculated_cost_usd * 100)::text,
      'providerBackfillCostMinorUnits', (l.provider_backfill_cost_usd * 100)::text,
      'inputTokens', l.input_tokens::text,
      'outputTokens', l.output_tokens::text,
      'cacheCreationInputTokens', l.cache_creation_input_tokens::text,
      'cacheReadInputTokens', l.cache_read_input_tokens::text,
      'requestCount', l.request_count::text,
      'backfillRowCount', l.backfill_row_count::text,
      'startsAt', l.starts_at
    ),
    'period', jsonb_build_object(
      'costMinorUnits', (p.cost_usd * 100)::text,
      'calculatedCostMinorUnits', (p.calculated_cost_usd * 100)::text,
      'providerBackfillCostMinorUnits', (p.provider_backfill_cost_usd * 100)::text,
      'inputTokens', p.input_tokens::text,
      'outputTokens', p.output_tokens::text,
      'cacheCreationInputTokens', p.cache_creation_input_tokens::text,
      'cacheReadInputTokens', p.cache_read_input_tokens::text,
      'requestCount', p.request_count::text,
      'backfillRowCount', p.backfill_row_count::text,
      'startsAt', (b.start_day::timestamp at time zone 'UTC')
    ),
    'daily', (
      select jsonb_agg(
        jsonb_build_object(
          'date', to_char(d.day, 'YYYY-MM-DD'),
          'costMinorUnits', (d.cost_usd * 100)::text,
          'calculatedCostMinorUnits', (d.calculated_cost_usd * 100)::text,
          'providerBackfillCostMinorUnits', (d.provider_backfill_cost_usd * 100)::text,
          'inputTokens', d.input_tokens::text,
          'outputTokens', d.output_tokens::text,
          'cacheCreationInputTokens', d.cache_creation_input_tokens::text,
          'cacheReadInputTokens', d.cache_read_input_tokens::text,
          'requestCount', d.request_count::text,
          'backfillRowCount', d.backfill_row_count::text
        ) order by d.day
      )
      from daily d
    )
  )
  from bounds b
  cross join lifetime l
  cross join period p;
$$;

/* No browser role can read the ledger or call either write/read function. */
revoke all on table public.ai_cost_events from public, anon, authenticated, service_role;
revoke all on table public.ai_cost_coverage from public, anon, authenticated, service_role;
revoke all on sequence public.ai_cost_events_id_seq from public, anon, authenticated, service_role;

revoke all on function public.record_ai_cost_event(
  text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, numeric, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_ai_cost_backfill(text, numeric, timestamptz)
  from public, anon, authenticated;
revoke all on function public.set_ai_cost_coverage(text, timestamptz, boolean)
  from public, anon, authenticated;
revoke all on function public.admin_ai_cost_snapshot(integer)
  from public, anon, authenticated;

grant execute on function public.record_ai_cost_event(
  text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, numeric, timestamptz
) to service_role;
grant execute on function public.record_ai_cost_backfill(text, numeric, timestamptz)
  to service_role;
grant execute on function public.set_ai_cost_coverage(text, timestamptz, boolean)
  to service_role;
grant execute on function public.admin_ai_cost_snapshot(integer)
  to service_role;

notify pgrst, 'reload schema';
