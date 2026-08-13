-- Required, non-privileged account identity.
--
-- account_kind describes how somebody intends to use BandUp. It grants no
-- organization role and must never be confused with profiles.role, which is
-- the protected user/admin authorization field.
alter table public.profiles
  add column if not exists account_kind text;

alter table public.profiles
  drop constraint if exists profiles_account_kind_check;
alter table public.profiles
  add constraint profiles_account_kind_check
  check (account_kind is null or account_kind in ('individual', 'student', 'teacher'));

comment on column public.profiles.account_kind is
  'Self-described individual | student | teacher. Never grants organization or admin access.';

-- Claiming a username and saving the required profile fields is one database
-- transaction. A timeout cannot leave the visible profile saved while the
-- username silently belongs to somebody else.
create or replace function public.set_account_identity(
  p_user_id uuid,
  p_display_name text,
  p_username text,
  p_account_kind text,
  p_birth_date date default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_username citext := lower(btrim(coalesce(p_username, '')));
begin
  if char_length(v_name) < 1 or char_length(v_name) > 60 then return 'invalid_display_name'; end if;
  if p_account_kind not in ('individual', 'student', 'teacher') then return 'invalid_account_kind'; end if;
  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then return 'invalid_username'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then return 'missing_profile'; end if;
  if exists (select 1 from public.reserved_usernames r where r.username = v_username) then
    return 'reserved_username';
  end if;

  update public.usernames set username = v_username where user_id = p_user_id;
  if not found then
    insert into public.usernames (username, user_id) values (v_username, p_user_id);
  end if;

  update public.profiles
     set display_name = v_name,
         account_kind = p_account_kind,
         birth_date = p_birth_date,
         updated_at = now()
   where id = p_user_id;
  return 'ok';
exception when unique_violation then
  return 'taken_username';
end;
$$;

-- The owner-only directory is paged and searched in the database. Returning
-- all learners and all practice JSON in one response would become an outage at
-- exactly the point the site grows.
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
           coalesce((
             select s.tier::text
               from public.subscriptions s
              where s.user_id = u.id
                and s.status in ('active', 'trialing')
                and (s.current_period_end is null or s.current_period_end > now())
              order by s.verified_at desc
              limit 1
           ), 'free') as plan,
           (select count(*)::bigint
              from public.usage_events e
             where e.user_id = u.id
               and e.created_at >= now() - interval '30 days') as usage_30d
      from auth.users u
      left join public.profiles p on p.id = u.id
      left join public.usernames n on n.user_id = u.id
     where btrim(coalesce(p_query, '')) = ''
        or coalesce(u.email, '') ilike '%' || btrim(p_query) || '%'
        or coalesce(n.username::text, '') ilike '%' || btrim(p_query) || '%'
        or coalesce(p.display_name, '') ilike '%' || btrim(p_query) || '%'
  )
  select m.id, m.email, m.username, m.display_name, m.account_kind,
         m.registered_at, m.plan, m.usage_30d,
         count(*) over()::bigint as total_count
    from matched m
   order by m.registered_at desc, m.id
   limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.admin_user_usage(p_user_id uuid)
returns table (route text, admitted bigint, refused bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select e.route::text,
         count(*) filter (where e.outcome = 'admitted')::bigint,
         count(*) filter (where e.outcome <> 'admitted')::bigint
    from public.usage_events e
   where e.user_id = p_user_id
     and e.created_at >= now() - interval '30 days'
   group by e.route
   order by e.route;
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
    'plan', coalesce((
      select s.tier
        from public.subscriptions s
       where s.user_id = u.id
         and s.status in ('active', 'trialing')
         and (s.current_period_end is null or s.current_period_end > now())
       order by s.verified_at desc
       limit 1
    ), 'free'),
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
  where u.id = p_user_id;
$$;

revoke all on function public.set_account_identity(uuid, text, text, text, date) from public, anon, authenticated;
revoke all on function public.admin_users_page(text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_user_usage(uuid) from public, anon, authenticated;
revoke all on function public.admin_user_detail(uuid) from public, anon, authenticated;
grant execute on function public.set_account_identity(uuid, text, text, text, date) to service_role;
grant execute on function public.admin_users_page(text, integer, integer) to service_role;
grant execute on function public.admin_user_usage(uuid) to service_role;
grant execute on function public.admin_user_detail(uuid) to service_role;

notify pgrst, 'reload schema';
