/*
  Exact source identities for the Cloudflare dual-write ledger.

  The existing usage RPC must remain the atomic authority: its advisory lock,
  allowance checks and insert are one transaction. It historically returned
  only the decision, however, while D1 needs the inserted Supabase identity so
  request retries and the final bulk copy converge on the same row. The wrapper
  below calls the established function and reads the sequence value inside the
  same database transaction. The original RPC and return type are untouched.

  Cost rows have the same requirement. Provider request id is already the
  semantic dedupe key, but the final migration also copies the Supabase bigint
  identity into D1. Returning the stored row (including on a duplicate retry)
  repairs a failed mirror without inventing a second D1 id.
*/

create or replace function public.check_and_record_usage_with_event(
  p_user_id        uuid,
  p_ip_hash        text,
  p_route          text,
  p_window_seconds integer,
  p_limits         jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_decision public.usage_decision;
  v_event public.usage_events%rowtype;
  v_event_id bigint;
begin
  v_decision := public.check_and_record_usage(
    p_user_id,
    p_ip_hash,
    p_route,
    p_window_seconds,
    p_limits
  );

  v_event_id := currval(pg_get_serial_sequence('public.usage_events', 'id'));
  select * into strict v_event
    from public.usage_events
   where id = v_event_id;

  return to_jsonb(v_decision) || jsonb_build_object(
    'eventId', v_event.id::text,
    'eventCreatedAt', v_event.created_at,
    'eventOutcome', v_event.outcome
  );
end;
$$;

create or replace function public.record_ai_cost_event_with_identity(
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
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted boolean;
  v_event public.ai_cost_events%rowtype;
  v_coverage public.ai_cost_coverage%rowtype;
  v_has_coverage boolean := false;
begin
  v_inserted := public.record_ai_cost_event(
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
  );

  select * into strict v_event
    from public.ai_cost_events
   where provider_request_id = p_provider_request_id;

  select * into v_coverage
    from public.ai_cost_coverage
   where singleton;
  v_has_coverage := found;

  return jsonb_build_object(
    'inserted', v_inserted,
    'event', jsonb_build_object(
      'id', v_event.id::text,
      'source', v_event.source,
      'providerRequestId', v_event.provider_request_id,
      'route', v_event.route,
      'model', v_event.model,
      'inputTokens', v_event.input_tokens,
      'outputTokens', v_event.output_tokens,
      'cacheCreationInputTokens', v_event.cache_creation_input_tokens,
      'cacheCreation5mInputTokens', v_event.cache_creation_5m_input_tokens,
      'cacheCreation1hInputTokens', v_event.cache_creation_1h_input_tokens,
      'cacheReadInputTokens', v_event.cache_read_input_tokens,
      'costUsd', v_event.cost_usd::text,
      'occurredAt', v_event.occurred_at,
      'recordedAt', v_event.recorded_at
    ),
    'coverage', case when v_has_coverage then jsonb_build_object(
      'source', v_coverage.source,
      'startsAt', v_coverage.starts_at,
      'historicalComplete', v_coverage.historical_complete,
      'recordedAt', v_coverage.recorded_at
    ) else null end
  );
end;
$$;

create or replace function public.set_ai_cost_coverage_with_identity(
  p_source text,
  p_starts_at timestamptz,
  p_historical_complete boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_coverage public.ai_cost_coverage%rowtype;
begin
  perform public.set_ai_cost_coverage(
    p_source,
    p_starts_at,
    p_historical_complete
  );
  select * into strict v_coverage
    from public.ai_cost_coverage
   where singleton;
  return jsonb_build_object(
    'source', v_coverage.source,
    'startsAt', v_coverage.starts_at,
    'historicalComplete', v_coverage.historical_complete,
    'recordedAt', v_coverage.recorded_at
  );
end;
$$;

revoke all on function public.check_and_record_usage_with_event(
  uuid, text, text, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.record_ai_cost_event_with_identity(
  text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, numeric, timestamptz
) from public, anon, authenticated;
revoke all on function public.set_ai_cost_coverage_with_identity(
  text, timestamptz, boolean
) from public, anon, authenticated;

grant execute on function public.check_and_record_usage_with_event(
  uuid, text, text, integer, jsonb
) to service_role;
grant execute on function public.record_ai_cost_event_with_identity(
  text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, numeric, timestamptz
) to service_role;
grant execute on function public.set_ai_cost_coverage_with_identity(
  text, timestamptz, boolean
) to service_role;

notify pgrst, 'reload schema';
