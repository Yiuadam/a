/*
  Read-only counts for the owner's dashboard.

  ---------------------------------------------------------------------------
  Functions rather than table reads

  Because that is how the rest of this application talks to the database — see
  lib/auth/supabase.ts, which has no `from(table).select()` in it at all. Every
  operation is a named function with a fixed shape, which is what makes the
  surface reviewable: there is a list of things the server can ask for, and it
  is this file plus the four before it.

  ---------------------------------------------------------------------------
  Nothing here can change anything

  Every function is `stable` and every body is a select. That is deliberate and
  worth stating: this is the first code in the project written to be *looked
  at* rather than to do a job, and a dashboard is exactly the kind of thing
  somebody later extends with "while we are here, let it also fix that". It
  cannot, because none of these can write.

  They also return no personal data — counts and dates, never an email, a name
  or a user id. The owner does not need to know which learner did something in
  order to see how much is being done, and a screen that showed them anyway
  would be a privacy promise quietly broken in the name of a chart.
*/

/** How many accounts exist. */
create or replace function public.admin_user_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::bigint from auth.users;
$$;

/**
 * Signups per day for the last p_days days, oldest first.
 *
 * Days with no signups are returned as zero rather than skipped. A chart drawn
 * from only the days something happened is a chart with a lying x-axis: three
 * scattered signups over a fortnight look like three consecutive days of
 * growth.
 */
create or replace function public.admin_signups_daily(p_days integer default 30)
returns table (day date, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select d::date as day,
         count(u.id)::bigint
  from generate_series(
         (current_date - (greatest(p_days, 1) - 1)),
         current_date,
         interval '1 day'
       ) as d
  left join auth.users u on u.created_at::date = d::date
  group by d
  order by d;
$$;

/**
 * AI requests per day, admitted and refused separately.
 *
 * Both, because the interesting number is not how much AI was served but how
 * often somebody hit a wall — a refusal is a learner who wanted something and
 * did not get it, and a run of them is either a cap set too low or somebody
 * having a bad time.
 */
create or replace function public.admin_usage_daily(p_days integer default 30)
returns table (day date, admitted bigint, denied bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select d::date as day,
         count(*) filter (where e.outcome = 'admitted')::bigint,
         count(*) filter (where e.outcome is not null and e.outcome <> 'admitted')::bigint
  from generate_series(
         (current_date - (greatest(p_days, 1) - 1)),
         current_date,
         interval '1 day'
       ) as d
  left join public.usage_events e on e.created_at::date = d::date
  group by d
  order by d;
$$;

/** How many accounts sit on each tier, per the database's own view of it. */
create or replace function public.admin_tier_counts()
returns table (tier text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.tier::text, count(*)::bigint
  from public.subscriptions s
  group by s.tier
  order by s.tier;
$$;

revoke all on function public.admin_user_count() from public, anon, authenticated;
revoke all on function public.admin_signups_daily(integer) from public, anon, authenticated;
revoke all on function public.admin_usage_daily(integer) from public, anon, authenticated;
revoke all on function public.admin_tier_counts() from public, anon, authenticated;

grant execute on function public.admin_user_count() to service_role;
grant execute on function public.admin_signups_daily(integer) to service_role;
grant execute on function public.admin_usage_daily(integer) to service_role;
grant execute on function public.admin_tier_counts() to service_role;

notify pgrst, 'reload schema';
