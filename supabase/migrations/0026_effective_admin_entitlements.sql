-- One effective entitlement answer for billing gates and the owner directory.
--
-- A user can temporarily hold more than one valid row: a wallet pass can
-- overlap a card subscription, and web and App Store purchases can coexist.
-- Choosing the most recently verified or the latest-expiring row does not
-- answer which access is strongest. Rank the known tiers first, then use the
-- dates and id only as deterministic tie-breakers.
create or replace function public.resolve_entitlement(p_user_id uuid)
returns public.entitlement
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_sub  public.subscriptions%rowtype;
  v_out  public.entitlement;
begin
  if p_user_id is null then
    return row('user', 'free', 'anonymous', null)::public.entitlement;
  end if;

  select role into v_role from public.profiles where id = p_user_id;
  v_role := coalesce(v_role, 'user');

  if v_role = 'admin' then
    return row('admin', 'admin', 'role', null)::public.entitlement;
  end if;

  select * into v_sub
  from public.subscriptions
  where user_id = p_user_id
    and status in ('active', 'trialing')
    and (current_period_end is null or current_period_end > now())
  order by case tier
      when 'pro' then 3
      when 'plus' then 2
      when 'standard' then 1
      when 'free' then 0
      else -1
    end desc,
    current_period_end desc nulls first,
    verified_at desc,
    id desc
  limit 1;

  if found then
    return row(v_role, v_sub.tier, v_sub.provider, v_sub.current_period_end)::public.entitlement;
  end if;

  return row(v_role, 'free', 'default', null)::public.entitlement;
end;
$$;

-- The owner directory reports the effective access used by the database
-- gates, not a second approximation assembled from subscription rows. An
-- organisation seat is deliberately separate: it permits organisation
-- membership, but does not buy personal AI allowances.
-- PostgreSQL cannot change a table-returning function's row type in-place.
drop function public.admin_users_page(text, integer, integer);

create or replace function public.admin_users_page(
  p_query text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  email text,
  username text,
  display_name text,
  account_kind text,
  registered_at timestamptz,
  plan text,
  access_source text,
  organization_seat_count bigint,
  usage_30d bigint,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with matched as (
    select u.id,
           u.email::text,
           n.username::text,
           p.display_name,
           p.account_kind,
           u.created_at as registered_at,
           entitlement.tier::text as plan,
           entitlement.source::text as access_source,
           (select count(*)::bigint
              from public.organization_seat_allocations allocation
              join public.organization_seat_pools pool
                on pool.id = allocation.seat_pool_id
               and pool.organization_id = allocation.organization_id
             where allocation.user_id = u.id
               and allocation.status in ('reserved', 'active')
               and allocation.starts_at <= now()
               and (allocation.ends_at is null or allocation.ends_at > now())
               and pool.status = 'active'
               and pool.starts_at <= now()
               and (pool.ends_at is null or pool.ends_at > now())
           ) as organization_seat_count,
           (select count(*)::bigint
              from public.usage_events e
             where e.user_id = u.id
               and e.created_at >= now() - interval '30 days') as usage_30d
      from auth.users u
      left join public.profiles p on p.id = u.id
      left join public.usernames n on n.user_id = u.id
      cross join lateral public.resolve_entitlement(u.id) entitlement
     where btrim(coalesce(p_query, '')) = ''
        or coalesce(u.email, '') ilike '%' || btrim(p_query) || '%'
        or coalesce(n.username::text, '') ilike '%' || btrim(p_query) || '%'
        or coalesce(p.display_name, '') ilike '%' || btrim(p_query) || '%'
  )
  select m.id, m.email, m.username, m.display_name, m.account_kind,
         m.registered_at, m.plan, m.access_source, m.organization_seat_count,
         m.usage_30d, count(*) over()::bigint as total_count
    from matched m
   order by m.registered_at desc, m.id
   limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when u.id is null then null else jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'username', n.username,
    'displayName', p.display_name,
    'accountKind', p.account_kind,
    'registeredAt', u.created_at,
    'plan', entitlement.tier,
    'accessSource', entitlement.source,
    'organizationSeats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organizationId', allocation.organization_id,
        'organizationName', organization.name,
        'status', allocation.status,
        'endsAt', least(allocation.ends_at, pool.ends_at)
      ) order by organization.name, allocation.organization_id)
      from public.organization_seat_allocations allocation
      join public.organization_seat_pools pool
        on pool.id = allocation.seat_pool_id
       and pool.organization_id = allocation.organization_id
      join public.organizations organization on organization.id = allocation.organization_id
      where allocation.user_id = u.id
        and allocation.status in ('reserved', 'active')
        and allocation.starts_at <= now()
        and (allocation.ends_at is null or allocation.ends_at > now())
        and pool.status = 'active'
        and pool.starts_at <= now()
        and (pool.ends_at is null or pool.ends_at > now())
    ), '[]'::jsonb),
    'placement', (
      select ps.payload -> 'placement'
        from public.progress_snapshots ps
       where ps.user_id = u.id and ps.store_key = 'ielts-prep-v1'
       limit 1
    ),
    'profileSyncedAt', (
      select ps.client_updated_at
        from public.progress_snapshots ps
       where ps.user_id = u.id and ps.store_key = 'ielts-prep-v1'
       limit 1
    ),
    'mockReports', coalesce((
      select coalesce(ps.payload -> 'mockReports', '[]'::jsonb)
        from public.progress_snapshots ps
       where ps.user_id = u.id and ps.store_key = 'ielts-prep-v1'
       limit 1
    ), '[]'::jsonb),
    'drillScores', coalesce((
      select case
        when jsonb_typeof(ps.payload) = 'object' then ps.payload
        else '{}'::jsonb
      end
        from public.progress_snapshots ps
       where ps.user_id = u.id and ps.store_key = 'bandup.drills.v1'
       limit 1
    ), '{}'::jsonb),
    'drillsSyncedAt', (
      select ps.client_updated_at
        from public.progress_snapshots ps
       where ps.user_id = u.id and ps.store_key = 'bandup.drills.v1'
       limit 1
    ),
    'usage', coalesce((
      select jsonb_agg(jsonb_build_object(
        'route', x.route,
        'admitted', x.admitted,
        'refused', x.refused
      ) order by x.route)
      from (
        select e.route,
               count(*) filter (where e.outcome = 'admitted')::bigint admitted,
               count(*) filter (where e.outcome <> 'admitted')::bigint refused
          from public.usage_events e
         where e.user_id = u.id
           and e.created_at >= now() - interval '30 days'
         group by e.route
      ) x
    ), '[]'::jsonb),
    'results', coalesce((
      select coalesce(ps.payload -> 'results', '[]'::jsonb)
        from public.progress_snapshots ps
       where ps.user_id = u.id and ps.store_key = 'ielts-prep-v1'
       limit 1
    ), '[]'::jsonb)
  ) end
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.usernames n on n.user_id = u.id
  cross join lateral public.resolve_entitlement(u.id) entitlement
  where u.id = p_user_id;
$$;

revoke all on function public.resolve_entitlement(uuid) from public, anon, authenticated;
revoke all on function public.admin_users_page(text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_user_detail(uuid) from public, anon, authenticated;
grant execute on function public.resolve_entitlement(uuid) to service_role;
grant execute on function public.admin_users_page(text, integer, integer) to service_role;
grant execute on function public.admin_user_detail(uuid) to service_role;

notify pgrst, 'reload schema';
