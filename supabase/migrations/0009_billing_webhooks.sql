-- Writing a subscription down, once, from a webhook that proved who sent it.
--
-- 0001 created `subscriptions` and `provider_events`, and said what they were
-- for. This file is the mechanism that uses them: one function that takes a
-- verified provider event and either applies it or explains why it did not.
--
-- Everything here is `security definer` with an empty search_path and EXECUTE
-- revoked from every client role, exactly as 0003 and 0004 are. A client
-- claiming to be subscribed must never cause a row to appear (ACCOUNTS.md,
-- threat 3), and the way that is guaranteed is that the only role which can
-- call any of this is the service role, which only server code holds.
--
-- ---------------------------------------------------------------------------
-- Why the whole decision is one function call
--
-- The obvious implementation is three round trips: record the event id, check
-- whether it was already there, then upsert the subscription. That has two
-- holes, and both of them cost money.
--
-- The first is concurrency. Stripe redelivers, and a redelivery can arrive
-- while the original is still being handled — two Workers, two transactions,
-- both reading "not seen yet" and both applying. `insert … on conflict do
-- nothing` inside one transaction closes that: exactly one of them inserts the
-- row, and the other is told it did not.
--
-- The second is crashing in the middle. Claim the event, then fail before
-- writing the subscription, and the redelivery is refused as a duplicate — the
-- learner has paid and has nothing. Because the claim and the write are in the
-- same function they are in the same transaction, so either both happened or
-- neither did, and a redelivery finds no claim and applies cleanly.
--
-- ---------------------------------------------------------------------------
-- Why out-of-order delivery is refused rather than tolerated
--
-- Webhook delivery is not ordered. A cancellation can be received before the
-- renewal that preceded it, and a redelivery of an old event can arrive hours
-- after a newer one has already been applied. Idempotency alone does not help
-- here: each event is distinct, so each is applied, and the last one to arrive
-- wins regardless of which happened last. That is how a cancelled subscription
-- comes back to life.
--
-- So the row remembers the provider's own timestamp for the event it was last
-- written from, and an event older than that is refused. The provider's clock
-- is the right one to use: it is the only clock that saw both events.
--
-- ---------------------------------------------------------------------------
-- A note for whoever builds the Apple side
--
-- This function is provider-agnostic and was tested with an `apple` row, but
-- it identifies a subscription by `p_subscription_id` alone. Apple's stable
-- identifier is the *original transaction id*, so pass that as
-- `p_subscription_id` and the same "one row per provider-side subscription"
-- rule applies unchanged. Passing null there would make every notification
-- insert a new row, because the lookup below would match nothing — which is
-- the one way to use this function wrongly, so it is written down here rather
-- than left to be discovered.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.subscriptions
  -- Which Price the subscriber is actually on. The tier is what governs access
  -- and is stored separately; this is for the question that gets asked when
  -- prices change — "what is this person paying?" — which a tier name cannot
  -- answer once there have been two of them.
  add column if not exists external_price_id text,
  -- The provider's timestamp for the event this row was last written from.
  -- Null on rows written before this migration, which the guard below treats as
  -- "no opinion" so that the first event after deploying always applies.
  add column if not exists provider_event_at timestamptz;

comment on column public.subscriptions.provider_event_at is
  'Provider-side timestamp of the event this row was last written from. Older events are refused.';

-- Resolving a webhook to an account when the event carries no metadata means
-- looking the customer up, and that lookup happens on every delivery.
create index if not exists subscriptions_provider_customer_idx
  on public.subscriptions (provider, external_customer_id)
  where external_customer_id is not null;

-- ---------------------------------------------------------------------------
-- apply_provider_subscription_event — the only way a subscription is written.
--
-- Returns one of:
--   'applied'      the row was written or updated
--   'duplicate'    this event id has been processed before; nothing changed
--   'stale'        an older event than the one the row was last written from
--   'unknown_user' the event could not be tied to an account; nothing written
--
-- The caller answers the provider with 200 in all four cases. A webhook that
-- returns an error is a webhook the provider retries, and none of these four
-- outcomes improves on a second attempt: three of them are already the correct
-- final state, and the fourth is a subscription that belongs to nobody this
-- database knows, which retrying cannot fix.
-- ---------------------------------------------------------------------------

create or replace function public.apply_provider_subscription_event(
  p_provider             text,
  p_event_id             text,
  p_event_at             timestamptz,
  p_payload              jsonb,
  p_user_id              uuid,
  p_status               text,
  p_tier                 text,
  p_customer_id          text,
  p_subscription_id      text,
  p_price_id             text,
  p_current_period_end   timestamptz,
  p_cancel_at_period_end boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id  uuid;
  v_existing public.subscriptions%rowtype;
  v_claimed  integer := 0;
begin
  if p_provider not in ('stripe', 'apple') then
    raise exception 'unknown provider';
  end if;

  -- Two different events about the same subscription can be in flight at once
  -- — a renewal and a cancellation seconds apart, delivered to two Workers.
  -- Both would find no existing row and both would insert, and the unique index
  -- on (provider, external_subscription_id) would make one of them a 500 that
  -- the provider then retries. Serialising per subscription costs microseconds
  -- and removes the retry. Same idiom as the usage meter in 0003, for the same
  -- reason: a check followed by a write is not safe until it is one thing.
  if p_subscription_id is not null then
    perform pg_advisory_xact_lock(
      ('x' || substr(md5('subscription:' || p_provider || ':' || p_subscription_id), 1, 16))::bit(64)::bigint
    );
  end if;

  -- ---------------------------------------------------------------- account --
  --
  -- Resolved before anything is claimed, so that an event this database cannot
  -- place leaves no trace and a later redelivery — after the account has been
  -- linked by some other event — is still free to apply.
  --
  -- The order is: what the event itself carried, then the subscription we
  -- already hold under that id, then the customer we have seen before. The
  -- first is a value this application wrote into the provider at checkout; the
  -- other two are values this database wrote about itself. None of them is
  -- anything a client asserted.

  v_user_id := p_user_id;

  if v_user_id is null and p_subscription_id is not null then
    select user_id into v_user_id
    from public.subscriptions
    where provider = p_provider
      and external_subscription_id = p_subscription_id
    limit 1;
  end if;

  if v_user_id is null and p_customer_id is not null then
    select user_id into v_user_id
    from public.subscriptions
    where provider = p_provider
      and external_customer_id = p_customer_id
    order by updated_at desc
    limit 1;
  end if;

  if v_user_id is null then
    return 'unknown_user';
  end if;

  -- An account that has since been deleted takes its subscriptions with it
  -- (every table cascades from auth.users). A late webhook for one would fail
  -- the foreign key, so it is refused here with an answer the caller can log
  -- rather than an exception it has to interpret.
  if not exists (select 1 from auth.users where id = v_user_id) then
    return 'unknown_user';
  end if;

  -- ------------------------------------------------------------- idempotency --
  --
  -- The claim. Exactly one caller inserts; every other one is told 'duplicate'
  -- and changes nothing. The payload is kept because it is the evidence: if a
  -- decision here is ever disputed, this is what it was made from.

  insert into public.provider_events (provider, event_id, payload, processed_at)
  values (p_provider, p_event_id, p_payload, now())
  on conflict (provider, event_id) do nothing;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'duplicate';
  end if;

  -- ------------------------------------------------------------------ order --

  select * into v_existing
  from public.subscriptions
  where provider = p_provider
    and external_subscription_id = p_subscription_id
  limit 1;

  if found
     and v_existing.provider_event_at is not null
     and p_event_at is not null
     and p_event_at < v_existing.provider_event_at then
    -- The event has still been recorded above, so it is never processed again.
    return 'stale';
  end if;

  -- ------------------------------------------------------------------ write --

  if found then
    update public.subscriptions
       set user_id                  = v_user_id,
           status                   = p_status,
           tier                     = p_tier,
           external_customer_id     = coalesce(p_customer_id, external_customer_id),
           external_price_id        = coalesce(p_price_id, external_price_id),
           current_period_end       = p_current_period_end,
           cancel_at_period_end     = coalesce(p_cancel_at_period_end, false),
           verified_at              = now(),
           provider_event_at        = p_event_at,
           raw                      = p_payload
     where id = v_existing.id;
  else
    insert into public.subscriptions (
      user_id, provider, status, tier,
      external_customer_id, external_subscription_id, external_price_id,
      current_period_end, cancel_at_period_end,
      verified_at, provider_event_at, raw
    )
    values (
      v_user_id, p_provider, p_status, p_tier,
      p_customer_id, p_subscription_id, p_price_id,
      p_current_period_end, coalesce(p_cancel_at_period_end, false),
      now(), p_event_at, p_payload
    );
  end if;

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- provider_customer_for_user — what the billing portal needs, and no more.
--
-- Stripe's portal is opened for a customer id, so the server has to know which
-- customer belongs to the caller. It is a single column from a row the user
-- already owns, returned to server code that has already established who the
-- caller is. It is a function rather than a select through PostgREST because
-- the application's Supabase client exposes named operations only, which is
-- what stops a general query builder sitting in the same module as the key
-- that bypasses every policy (see lib/auth/supabase.ts).
-- ---------------------------------------------------------------------------

create or replace function public.provider_customer_for_user(
  p_user_id  uuid,
  p_provider text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select external_customer_id
  from public.subscriptions
  where user_id = p_user_id
    and provider = p_provider
    and external_customer_id is not null
  order by updated_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Nobody but the service role, for the same reason as 0003.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and PostgREST publishes
-- every executable function in `public` as an HTTP endpoint. Without these
-- revokes, `apply_provider_subscription_event` would be a URL anyone could POST
-- to in order to give themselves a subscription — which is the exact attack
-- this whole file exists to make impossible.
-- ---------------------------------------------------------------------------

revoke execute on function public.apply_provider_subscription_event(
  text, text, timestamptz, jsonb, uuid, text, text, text, text, text, timestamptz, boolean
) from public, anon, authenticated;

revoke execute on function public.provider_customer_for_user(uuid, text)
  from public, anon, authenticated;

grant execute on function public.apply_provider_subscription_event(
  text, text, timestamptz, jsonb, uuid, text, text, text, text, text, timestamptz, boolean
) to service_role;

grant execute on function public.provider_customer_for_user(uuid, text) to service_role;
