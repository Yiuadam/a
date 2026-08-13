-- A progress sync is one logical save even though it contains three browser
-- stores. Compare the rows the API merged, then replace the submitted set in
-- one transaction. A per-user transaction advisory lock serializes devices;
-- a stale caller receives NULL, re-reads, merges, and retries.
create or replace function public.compare_and_swap_progress_snapshots(
  p_user_id uuid,
  p_expected jsonb,
  p_snapshots jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  committed_at timestamptz := clock_timestamp();
begin
  if p_user_id is null
     or jsonb_typeof(p_expected) <> 'array'
     or jsonb_typeof(p_snapshots) <> 'array'
     or jsonb_array_length(p_snapshots) not between 1 and 3
     or jsonb_array_length(p_expected) <> jsonb_array_length(p_snapshots)
     or exists (
       select 1
         from jsonb_array_elements(p_snapshots) item
        where jsonb_typeof(item) <> 'object'
           or not (item ? 'payload')
           or item ->> 'storeKey' not in (
             'ielts-prep-v1', 'bandup.drills.v1', 'bandup.lookups.v1'
           )
     )
     or exists (
       select 1
         from jsonb_array_elements(p_expected) item
        where jsonb_typeof(item) <> 'object'
           or jsonb_typeof(item -> 'exists') <> 'boolean'
           or not (item ? 'payload')
           or not (item ? 'clientUpdatedAt')
           or item ->> 'storeKey' not in (
             'ielts-prep-v1', 'bandup.drills.v1', 'bandup.lookups.v1'
           )
     )
     or (
       select count(distinct item ->> 'storeKey')
         from jsonb_array_elements(p_snapshots) item
     ) <> jsonb_array_length(p_snapshots)
     or (
       select count(distinct item ->> 'storeKey')
         from jsonb_array_elements(p_expected) item
     ) <> jsonb_array_length(p_expected)
     or exists (
       select 1
         from jsonb_array_elements(p_expected) expected
        where not exists (
          select 1
            from jsonb_array_elements(p_snapshots) snapshot
           where snapshot ->> 'storeKey' = expected ->> 'storeKey'
        )
     )
     or exists (
       select 1
         from jsonb_array_elements(p_expected) expected
        where ((expected ->> 'exists')::boolean
                 and expected ->> 'clientUpdatedAt' is null)
           or (not (expected ->> 'exists')::boolean
                 and expected -> 'clientUpdatedAt' <> 'null'::jsonb)
     ) then
    raise exception 'invalid progress batch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    ('x' || substr(replace(p_user_id::text, '-', ''), 1, 16))::bit(64)::bigint
  );

  if exists (
    select 1
      from jsonb_array_elements(p_expected) expected
      left join public.progress_snapshots current
        on current.user_id = p_user_id
       and current.store_key = expected ->> 'storeKey'
     where case when (expected ->> 'exists')::boolean
       then current.user_id is null
         or current.client_updated_at is distinct from
              ((expected ->> 'clientUpdatedAt')::timestamptz)
       else current.user_id is not null
     end
  ) then
    return null;
  end if;

  insert into public.progress_snapshots (
    user_id, store_key, payload, client_updated_at
  )
  select p_user_id, item ->> 'storeKey', item -> 'payload', committed_at
    from jsonb_array_elements(p_snapshots) item
  on conflict (user_id, store_key) do update set
    payload = excluded.payload,
    client_updated_at = excluded.client_updated_at;

  return committed_at;
end;
$$;

revoke all on function public.compare_and_swap_progress_snapshots(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.compare_and_swap_progress_snapshots(uuid, jsonb, jsonb)
  to service_role;
