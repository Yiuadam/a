/*
  Owner-facing usage and tier figures whose names match what they measure.

  `usage_events` records BandUp's decision before an AI provider is called. A
  denied row is therefore not an Anthropic refusal; it is a quota or rate-limit
  block inside BandUp. The breakdown below keeps those reasons separate and
  exposes only aggregate counts — never a user id, address hash or prompt.

  The owner account is excluded from learner-demand figures. Besides making the
  headline match its purpose, that also keeps historical owner diagnostics from
  appearing as learner quota blocks. Those old rows cannot be identified safely
  after the fact because the original event schema did not record a diagnostic
  source, so filtering the verified owner is the non-destructive correction.

  The tier count previously grouped raw subscription rows. That double-counted
  one person with overlapping records and kept expired/refunded rows in the
  headline. The effective resolver is the source of truth for what each account
  can use now. The explicit owner id covers ADMIN_EMAILS, which is intentionally
  configured outside the database and otherwise cannot appear as an admin role
  in this query.
*/

create or replace function public.admin_signups_daily(p_days integer default 30)
returns table (day date, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (now() at time zone 'UTC')::date as today,
           least(greatest(coalesce(p_days, 30), 1), 366) as day_count
  ), days as (
    select (b.today - n)::date as day
      from bounds b
     cross join lateral generate_series(0, b.day_count - 1) n
  )
  select d.day, count(u.id)::bigint
    from days d
    left join auth.users u
      on (u.created_at at time zone 'UTC')::date = d.day
   group by d.day
   order by d.day;
$$;

create or replace function public.admin_usage_daily(p_days integer default 30)
returns table (day date, admitted bigint, denied bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (now() at time zone 'UTC')::date as today,
           least(greatest(coalesce(p_days, 30), 1), 366) as day_count
  ), days as (
    select (b.today - n)::date as day
      from bounds b
     cross join lateral generate_series(0, b.day_count - 1) n
  )
  select d.day,
         count(e.id) filter (where e.outcome = 'admitted')::bigint,
         count(e.id) filter (where e.outcome <> 'admitted')::bigint
    from days d
    left join public.usage_events e
      on (e.created_at at time zone 'UTC')::date = d.day
   group by d.day
   order by d.day;
$$;

create or replace function public.admin_usage_daily(
  p_days integer,
  p_admin_user_id uuid
)
returns table (day date, admitted bigint, denied bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (now() at time zone 'UTC')::date as today,
           least(greatest(coalesce(p_days, 30), 1), 366) as day_count
  ), days as (
    select (b.today - n)::date as day
      from bounds b
     cross join lateral generate_series(0, b.day_count - 1) n
  )
  select d.day,
         count(e.id) filter (where e.outcome = 'admitted')::bigint,
         count(e.id) filter (where e.outcome <> 'admitted')::bigint
    from days d
    left join public.usage_events e
      on (e.created_at at time zone 'UTC')::date = d.day
     and e.user_id is distinct from p_admin_user_id
   group by d.day
   order by d.day;
$$;

create or replace function public.admin_usage_breakdown(p_days integer default 30)
returns table (route text, decision text, caller text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select e.route::text,
         case e.outcome
           when 'admitted' then 'allowed'
           when 'denied_quota' then 'blocked_quota'
           when 'denied_rate' then 'blocked_rate'
         end::text as decision,
         case when e.user_id is null then 'anonymous' else 'signed_in' end::text as caller,
         count(*)::bigint
    from public.usage_events e
   where e.created_at >= (((now() at time zone 'UTC')::date
                            - (least(greatest(coalesce(p_days, 30), 1), 366) - 1))::timestamp
                          at time zone 'UTC')
     and e.created_at < ((((now() at time zone 'UTC')::date + 1)::timestamp)
                         at time zone 'UTC')
   group by e.route, e.outcome, (e.user_id is null)
   order by e.route, decision, caller;
$$;

create or replace function public.admin_usage_breakdown(
  p_days integer,
  p_admin_user_id uuid
)
returns table (route text, decision text, caller text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select e.route::text,
         case e.outcome
           when 'admitted' then 'allowed'
           when 'denied_quota' then 'blocked_quota'
           when 'denied_rate' then 'blocked_rate'
         end::text as decision,
         case when e.user_id is null then 'anonymous' else 'signed_in' end::text as caller,
         count(*)::bigint
    from public.usage_events e
   where e.created_at >= (((now() at time zone 'UTC')::date
                            - (least(greatest(coalesce(p_days, 30), 1), 366) - 1))::timestamp
                          at time zone 'UTC')
     and e.created_at < ((((now() at time zone 'UTC')::date + 1)::timestamp)
                         at time zone 'UTC')
     and e.user_id is distinct from p_admin_user_id
   group by e.route, e.outcome, (e.user_id is null)
   order by e.route, decision, caller;
$$;

create or replace function public.admin_tier_counts()
returns table (tier text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select entitlement.tier::text as tier,
         count(*)::bigint
    from auth.users u
   cross join lateral public.resolve_entitlement(u.id) entitlement
   group by entitlement.tier
   order by tier;
$$;

create or replace function public.admin_tier_counts(p_admin_user_id uuid)
returns table (tier text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with effective as (
    select case
             when u.id = p_admin_user_id then 'admin'::text
             else entitlement.tier::text
           end as tier
      from auth.users u
     cross join lateral public.resolve_entitlement(u.id) entitlement
  )
  select e.tier, count(*)::bigint
    from effective e
   group by e.tier
   order by e.tier;
$$;

revoke all on function public.admin_usage_breakdown(integer) from public, anon, authenticated;
revoke all on function public.admin_usage_breakdown(integer, uuid) from public, anon, authenticated;
revoke all on function public.admin_usage_daily(integer, uuid) from public, anon, authenticated;
revoke all on function public.admin_tier_counts() from public, anon, authenticated;
revoke all on function public.admin_tier_counts(uuid) from public, anon, authenticated;
grant execute on function public.admin_usage_breakdown(integer) to service_role;
grant execute on function public.admin_usage_breakdown(integer, uuid) to service_role;
grant execute on function public.admin_usage_daily(integer, uuid) to service_role;
grant execute on function public.admin_tier_counts() to service_role;
grant execute on function public.admin_tier_counts(uuid) to service_role;

notify pgrst, 'reload schema';
