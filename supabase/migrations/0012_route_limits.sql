-- ---------------------------------------------------------------------------
-- One allowance per route, over two windows — and the tiers that go with it.
--
-- What changes and why
-- --------------------
-- The meter used to count every AI request into one pool: twenty a day on Free,
-- five hundred on the paid tier, spend them how you like. That is easy to
-- explain and impossible to cost, because the five metered routes differ in
-- price by a factor of thirty. Twenty word lookups cost about six cents; twenty
-- generated practice tests cost nearly two dollars. One number cannot bound both
-- and therefore bounds neither, which means a subscription could — and on the
-- arithmetic, would — cost more to serve than it charged.
--
-- So `check_and_record_usage` now reads an allowance *per route*, checked over
-- two windows:
--
--   monthly   a rolling 30 days. This is the cap that bounds the money.
--   daily     a rolling 24 hours, at roughly a fifth of the month. It cannot
--             make the bill smaller; it stops one account draining a month of
--             allowance in an afternoon and colliding with the upstream API's
--             own rate limits, which would take the app down for everybody else.
--
-- The numbers still come from the application in p_limits, so changing an
-- allowance stays a deploy rather than a migration. Only the *shape* is new:
--
--   {
--     "schema": 2,
--     "anonymous": 0,
--     "ip": 60,
--     "month_seconds": 2592000,
--     "monthly": { "plus": {"define": 200, "chat": 100, ...}, "admin": {...} },
--     "daily":   { "plus": {"define": 40,  "chat": 25,  ...}, "admin": {...} },
--     "free": 0, "standard": 0, "plus": 0, "pro": 0, "admin": null
--   }
--
-- A null allowance, or a missing key, is unlimited — which only the owner's
-- account ever is.
--
-- Why the old flat keys are still sent, all zero
-- ----------------------------------------------
-- Because this file has to be applied by hand, and the failure mode of it *not*
-- being applied has to be safe. The pre-0012 function reads `p_limits ->> tier`
-- and knows nothing about "monthly" or "daily"; handed a zero it refuses every
-- AI request for every paying tier. That is a visible, harmless failure — the
-- owner notices immediately and it cannot cost a penny. Omitting the keys
-- instead would read as unlimited on the old function, which is the one outcome
-- worth designing against.
--
-- The reverse direction is handled too: the branch below on `schema` means a
-- *new* database still meters correctly for an *old* application, which is what
-- a rollback looks like.
--
-- Nothing here is destructive. Both statements replace or widen; no row is
-- touched and no data is dropped, and the file is safe to run twice.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The tiers a subscription may name.
--
-- 0001 allowed 'free' and 'pro' because there were two. There are now four that
-- can appear on a row, and a CHECK that does not know about them would reject
-- the webhook that grants somebody the plan they just paid for — which is the
-- worst moment for a constraint to fail. Widening is a superset, so Postgres
-- validates it in one pass with no rewrite and no existing row can violate it.
--
-- 'pro' keeps its name and moves up the ladder: it was the only paid tier and
-- is now the top of three. No production subscription rows exist yet, so there
-- is nothing to migrate; if any did, they would land on the most generous tier
-- rather than the least, which is the right direction to be wrong in when
-- somebody has already paid.
-- ---------------------------------------------------------------------------

alter table public.subscriptions
  drop constraint if exists subscriptions_tier_check;

alter table public.subscriptions
  add constraint subscriptions_tier_check check (
    tier in ('free', 'standard', 'plus', 'pro')
  );

-- ---------------------------------------------------------------------------
-- The meter.
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
  v_ent          public.entitlement;
  v_window       interval;
  v_month        interval;
  v_month_secs   integer;
  v_quota        integer;
  v_used         integer;
  v_day_quota    integer;
  v_day_used     integer;
  v_ip_cap       integer;
  v_ip_used      integer;
  v_per_route    boolean;
begin
  v_window := make_interval(secs => greatest(p_window_seconds, 1));
  v_ent := public.resolve_entitlement(p_user_id);

  -- Serialise the check-and-insert per caller. Two requests from the same user
  -- queue behind each other for the microseconds this takes; requests from
  -- different users never contend. Without this the counts below are a
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

  v_per_route := coalesce((p_limits ->> 'schema')::integer, 1) >= 2
                 and p_user_id is not null;

  if v_per_route then
    -- --- per-route allowance, monthly then daily ---------------------------

    v_month_secs := coalesce(nullif(p_limits ->> 'month_seconds', '')::integer,
                             30 * 24 * 60 * 60);
    v_month := make_interval(secs => greatest(v_month_secs, 1));

    /*
      A tier the application did not send allowances for is refused, not
      uncapped.

      This is the difference between a missing key and a null value, and it is
      worth spelling out because the two look identical through `->>`: both
      produce SQL NULL, and NULL means unlimited three lines below. A null value
      under a key that is present is the owner's account saying "no limit"; a
      key that is absent entirely is the database naming a tier this build has
      never heard of — a row written by a newer deploy, a hand-edited
      subscription, a typo in a migration. Reading that as unlimited would make
      the one path that costs real money the one that is easiest to reach by
      accident.
    */
    if not (p_limits -> 'monthly' ? v_ent.tier) then
      insert into public.usage_events (user_id, route, ip_hash, outcome)
      values (p_user_id, p_route, p_ip_hash, 'denied_quota');
      return row(false, 'quota_exceeded', v_ent.role, v_ent.tier,
                 0, 0, v_month_secs)::public.usage_decision;
    end if;

    v_quota := nullif(p_limits -> 'monthly' -> (v_ent.tier) ->> p_route, '')::integer;

    if v_quota is not null then
      select count(*)::integer into v_used
      from public.usage_events
      where user_id = p_user_id
        and route = p_route
        and outcome = 'admitted'
        and created_at > now() - v_month;

      if v_used >= v_quota then
        insert into public.usage_events (user_id, route, ip_hash, outcome)
        values (p_user_id, p_route, p_ip_hash, 'denied_quota');
        return row(false, 'quota_exceeded', v_ent.role, v_ent.tier,
                   v_used, v_quota, v_month_secs)::public.usage_decision;
      end if;
    else
      v_used := 0;
    end if;

    -- The 24-hour ceiling on the same route. Reported as 'rate_limited' rather
    -- than 'quota_exceeded' because the two mean different things to whoever
    -- reads the message: one is "you have used your month", the other is "come
    -- back tomorrow", and telling a subscriber the first when the second is
    -- true would be a lie about what they bought.
    v_day_quota := nullif(p_limits -> 'daily' -> (v_ent.tier) ->> p_route, '')::integer;

    if v_day_quota is not null then
      select count(*)::integer into v_day_used
      from public.usage_events
      where user_id = p_user_id
        and route = p_route
        and outcome = 'admitted'
        and created_at > now() - v_window;

      if v_day_used >= v_day_quota then
        insert into public.usage_events (user_id, route, ip_hash, outcome)
        values (p_user_id, p_route, p_ip_hash, 'denied_rate');
        return row(false, 'rate_limited', v_ent.role, v_ent.tier,
                   v_used, v_quota, p_window_seconds)::public.usage_decision;
      end if;
    end if;

  else
    -- --- the pre-0012 shape: one pool, one window --------------------------
    --
    -- Kept so that a database on this migration still meters an application
    -- that has been rolled back to the old payload, and so that an anonymous
    -- caller — who has no tier and no per-route allowance — is handled by the
    -- one path that was written for them.

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

revoke execute on function public.check_and_record_usage(uuid, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.check_and_record_usage(uuid, text, text, integer, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- The index the per-route counts lean on.
--
-- Every query added above filters by user, by route, by outcome and by a time
-- floor. 0010 added (user_id, created_at desc) where admitted, which serves the
-- monthly total but makes each per-route count scan a month of that user's
-- events. Adding route to the key turns five scans per request into five index
-- lookups. Same partial predicate, so it stays small: denied rows are not in it.
-- ---------------------------------------------------------------------------

create index if not exists usage_events_user_route_at_idx
  on public.usage_events (user_id, route, created_at desc)
  where outcome = 'admitted';

-- ---------------------------------------------------------------------------
-- A probe, so that "this migration has not been applied" is a thing the app can
-- *see* rather than a thing somebody has to deduce.
--
-- The failure this exists for is quiet by construction. Without 0012 the meter
-- still answers, still records, still refuses — it just refuses everything for
-- every paying tier, because the application sends zeroes in the old keys on
-- purpose (see lib/usage/limits.ts). That is the safe direction and it is not an
-- obvious one from the outside: a subscriber reports "the tutor says I have used
-- my allowance" and nothing in the logs says why.
--
-- So the owner's diagnostics panel asks this function what shape of limits the
-- database understands. Missing function, missing migration, and the panel says
-- which file to run.
-- ---------------------------------------------------------------------------

create or replace function public.usage_limits_schema()
returns integer
language sql
immutable
security definer
set search_path = ''
as $$ select 2 $$;

revoke execute on function public.usage_limits_schema() from public, anon, authenticated;
grant execute on function public.usage_limits_schema() to service_role;
