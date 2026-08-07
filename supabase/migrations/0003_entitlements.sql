-- The entitlement resolver and the usage meter, as database functions.
--
-- Why in SQL rather than in TypeScript: the meter has to count existing events
-- and record a new one as one indivisible act. Doing it as "count, then decide,
-- then insert" over the network leaves a window in which fifty concurrent
-- requests all read the same count and all get admitted. Here the count, the
-- decision and the insert happen inside one transaction, under a lock keyed to
-- the caller, so the limit holds under concurrency.
--
-- Every function in this file is `security definer` with an empty search_path,
-- and EXECUTE is revoked from every client role. They are callable only by the
-- service role, from server-side code.

-- ---------------------------------------------------------------------------
-- Return types
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'entitlement') then
    create type public.entitlement as (
      role       text,        -- 'user' | 'admin'
      tier       text,        -- 'free' | 'pro' | 'admin'
      source     text,        -- 'anonymous' | 'default' | 'role' | 'stripe' | 'apple'
      expires_at timestamptz  -- null when it does not expire
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'usage_decision') then
    create type public.usage_decision as (
      allowed        boolean,
      -- 'ok' | 'quota_exceeded' | 'rate_limited'
      reason         text,
      role           text,
      tier           text,
      used           integer,
      quota          integer,  -- null means unlimited
      window_seconds integer
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- resolve_entitlement — the single answer to "what is this user entitled to?"
--
-- It reads the database and nothing else. There is no argument by which a
-- caller can assert a tier; the only input is a user id.
-- ---------------------------------------------------------------------------

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
    -- Not signed in. Metered by IP only, at the anonymous allowance.
    v_out := row('user', 'free', 'anonymous', null)::public.entitlement;
    return v_out;
  end if;

  select role into v_role from public.profiles where id = p_user_id;

  -- An unknown user id is treated as a plain user, never as an admin. If the
  -- profile row is missing the answer is the most restrictive one, not a crash
  -- and not a free pass.
  v_role := coalesce(v_role, 'user');

  if v_role = 'admin' then
    v_out := row('admin', 'admin', 'role', null)::public.entitlement;
    return v_out;
  end if;

  -- The most generous still-valid subscription wins, so a user who holds both
  -- a web and an App Store subscription is never accidentally downgraded by
  -- whichever row happens to sort first.
  select * into v_sub
  from public.subscriptions
  where user_id = p_user_id
    and status in ('active', 'trialing')
    and (current_period_end is null or current_period_end > now())
  order by current_period_end desc nulls first
  limit 1;

  if found then
    v_out := row(v_role, v_sub.tier, v_sub.provider, v_sub.current_period_end)::public.entitlement;
    return v_out;
  end if;

  v_out := row(v_role, 'free', 'default', null)::public.entitlement;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- check_and_record_usage — the meter.
--
-- p_limits is a jsonb object supplied by the application so that changing an
-- allowance is a code change rather than a migration:
--
--   {"free": 20, "pro": 500, "admin": null, "anonymous": 5, "ip": 60}
--
-- A null value, or a missing key, means unlimited for that bucket.
-- ---------------------------------------------------------------------------

create or replace function public.check_and_record_usage(
  p_user_id        uuid,
  p_ip_hash        text,
  p_route          text,
  p_window_seconds integer,
  p_limits         jsonb
)
returns public.usage_decision
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ent    public.entitlement;
  v_window interval;
  v_quota  integer;
  v_used   integer;
  v_ip_cap integer;
  v_ip_used integer;
begin
  v_window := make_interval(secs => greatest(p_window_seconds, 1));
  v_ent := public.resolve_entitlement(p_user_id);

  -- Serialise the check-and-insert per caller. Two requests from the same user
  -- queue behind each other for the microseconds this takes; requests from
  -- different users never contend. Without this the count below is a
  -- time-of-check/time-of-use hole worth exactly one burst of free calls.
  if p_user_id is not null then
    perform pg_advisory_xact_lock(
      ('x' || substr(md5('usage:user:' || p_user_id::text), 1, 16))::bit(64)::bigint
    );
  elsif p_ip_hash is not null then
    perform pg_advisory_xact_lock(
      ('x' || substr(md5('usage:ip:' || p_ip_hash), 1, 16))::bit(64)::bigint
    );
  end if;

  -- --- per-account allowance -----------------------------------------------

  if p_user_id is null then
    v_quota := nullif(p_limits ->> 'anonymous', '')::integer;
  else
    v_quota := nullif(p_limits ->> (v_ent.tier), '')::integer;
  end if;

  if v_quota is not null then
    if p_user_id is null then
      select count(*)::integer into v_used
      from public.usage_events
      where user_id is null
        and ip_hash is not distinct from p_ip_hash
        and outcome = 'admitted'
        and created_at > now() - v_window;
    else
      select count(*)::integer into v_used
      from public.usage_events
      where user_id = p_user_id
        and outcome = 'admitted'
        and created_at > now() - v_window;
    end if;

    if v_used >= v_quota then
      insert into public.usage_events (user_id, route, ip_hash, outcome)
      values (p_user_id, p_route, p_ip_hash, 'denied_quota');
      return row(false, 'quota_exceeded', v_ent.role, v_ent.tier,
                 v_used, v_quota, p_window_seconds)::public.usage_decision;
    end if;
  else
    v_used := 0;
  end if;

  -- --- per-IP ceiling ------------------------------------------------------
  --
  -- This is the limit that applies whether or not anybody is signed in, and it
  -- is what stops an unauthenticated caller from running up the API bill. It
  -- deliberately also applies to signed-in users: one address is one address,
  -- however many accounts are driven from it. Admins are exempt, because the
  -- owner working from a single address would otherwise trip it.

  if v_ent.tier <> 'admin' then
    v_ip_cap := nullif(p_limits ->> 'ip', '')::integer;
    if v_ip_cap is not null and p_ip_hash is not null then
      select count(*)::integer into v_ip_used
      from public.usage_events
      where ip_hash = p_ip_hash
        and outcome = 'admitted'
        and created_at > now() - v_window;

      if v_ip_used >= v_ip_cap then
        insert into public.usage_events (user_id, route, ip_hash, outcome)
        values (p_user_id, p_route, p_ip_hash, 'denied_rate');
        return row(false, 'rate_limited', v_ent.role, v_ent.tier,
                   v_used, v_quota, p_window_seconds)::public.usage_decision;
      end if;
    end if;
  end if;

  -- --- admit ---------------------------------------------------------------
  --
  -- Recorded before the upstream AI call is made, not after. A call that is
  -- admitted and then fails still cost a request slot; a call that is made and
  -- never recorded costs real money. The meter errs towards the former.

  insert into public.usage_events (user_id, route, ip_hash, outcome)
  values (p_user_id, p_route, p_ip_hash, 'admitted');

  return row(true, 'ok', v_ent.role, v_ent.tier,
             v_used + 1, v_quota, p_window_seconds)::public.usage_decision;
end;
$$;

-- ---------------------------------------------------------------------------
-- usage_summary — what the account screen will show. Read-only.
-- ---------------------------------------------------------------------------

create or replace function public.usage_summary(
  p_user_id        uuid,
  p_window_seconds integer
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.usage_events
  where user_id = p_user_id
    and outcome = 'admitted'
    and created_at > now() - make_interval(secs => greatest(p_window_seconds, 1));
$$;

-- ---------------------------------------------------------------------------
-- Nobody but the service role may call any of this.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and PostgREST
-- turns every executable function in `public` into an HTTP endpoint. Without
-- these revokes, `check_and_record_usage` would be callable from a browser
-- with any user id the caller felt like typing.
-- ---------------------------------------------------------------------------

revoke execute on function public.resolve_entitlement(uuid) from public, anon, authenticated;
revoke execute on function public.check_and_record_usage(uuid, text, text, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.usage_summary(uuid, integer) from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.resolve_entitlement(uuid) to service_role;
grant execute on function public.check_and_record_usage(uuid, text, text, integer, jsonb) to service_role;
grant execute on function public.usage_summary(uuid, integer) to service_role;
