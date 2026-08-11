-- One-time Alipay and WeChat Pay purchases.
--
-- Card checkout remains a renewable Stripe Subscription. Wallet checkout is a
-- prepaid pass: one verified payment grants exactly one month or one year,
-- never renews, and can be revoked by a verified full-refund event. Both
-- functions are service-role-only and claim the Stripe event in the same
-- transaction as the entitlement write.

create or replace function public.apply_stripe_prepaid_purchase_event(
  p_event_id          text,
  p_event_at          timestamptz,
  p_payload           jsonb,
  p_user_id           uuid,
  p_tier              text,
  p_plan_id           text,
  p_customer_id       text,
  p_payment_intent_id text,
  p_interval          text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claimed integer := 0;
  v_base timestamptz;
  v_end timestamptz;
begin
  if p_event_id is null or p_event_at is null or p_user_id is null or
     p_payment_intent_id is null then
    raise exception 'missing prepaid purchase identity';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    return 'unknown_user';
  end if;

  if not (
    (p_plan_id = 'standard-monthly' and p_tier = 'standard' and p_interval = 'month') or
    (p_plan_id = 'standard-yearly'  and p_tier = 'standard' and p_interval = 'year') or
    (p_plan_id = 'plus-monthly'     and p_tier = 'plus'     and p_interval = 'month') or
    (p_plan_id = 'plus-yearly'      and p_tier = 'plus'     and p_interval = 'year') or
    (p_plan_id = 'pro-monthly'      and p_tier = 'pro'      and p_interval = 'month') or
    (p_plan_id = 'pro-yearly'       and p_tier = 'pro'      and p_interval = 'year')
  ) then
    raise exception 'invalid prepaid plan';
  end if;

  perform pg_advisory_xact_lock(
    ('x' || substr(md5('prepaid:stripe:' || p_payment_intent_id), 1, 16))::bit(64)::bigint
  );
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('prepaid:user:' || p_user_id::text || ':' || p_tier), 1, 16))::bit(64)::bigint
  );

  insert into public.provider_events (provider, event_id, payload, processed_at)
  values ('stripe', p_event_id, p_payload, now())
  on conflict (provider, event_id) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'duplicate';
  end if;

  -- Buying early extends the same tier instead of discarding paid time.
  select greatest(p_event_at, coalesce(max(current_period_end), p_event_at))
    into v_base
  from public.subscriptions
  where user_id = p_user_id
    and provider = 'stripe'
    and tier = p_tier
    and status in ('active', 'trialing')
    and current_period_end > p_event_at;

  v_end := v_base + case p_interval
    when 'month' then interval '1 month'
    when 'year' then interval '1 year'
  end;

  insert into public.subscriptions (
    user_id,
    provider,
    status,
    tier,
    external_customer_id,
    external_subscription_id,
    external_price_id,
    current_period_end,
    cancel_at_period_end,
    verified_at,
    provider_event_at,
    raw
  ) values (
    p_user_id,
    'stripe',
    'active',
    p_tier,
    p_customer_id,
    p_payment_intent_id,
    'wallet:' || p_plan_id,
    v_end,
    true,
    now(),
    p_event_at,
    p_payload
  );

  return 'applied';
end;
$$;

create or replace function public.apply_stripe_prepaid_refund_event(
  p_event_id          text,
  p_event_at          timestamptz,
  p_payload           jsonb,
  p_payment_intent_id text,
  p_refund_amount     bigint,
  p_full_refund_confirmed boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claimed integer := 0;
  v_existing public.subscriptions%rowtype;
begin
  if p_event_id is null or p_event_at is null or p_payment_intent_id is null then
    raise exception 'missing prepaid refund identity';
  end if;

  perform pg_advisory_xact_lock(
    ('x' || substr(md5('prepaid:stripe:' || p_payment_intent_id), 1, 16))::bit(64)::bigint
  );

  select * into v_existing
  from public.subscriptions
  where provider = 'stripe'
    and external_subscription_id = p_payment_intent_id
    and external_price_id like 'wallet:%'
  limit 1;

  if not found then
    return 'unknown_purchase';
  end if;

  insert into public.provider_events (provider, event_id, payload, processed_at)
  values ('stripe', p_event_id, p_payload, now())
  on conflict (provider, event_id) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'duplicate';
  end if;

  -- WeChat Pay refunds finish asynchronously. A succeeded Refund event may be
  -- partial, so it revokes access only when that single refund equals the
  -- original Checkout total. A fully-refunded Charge is already conclusive.
  if not coalesce(p_full_refund_confirmed, false) and (
    p_refund_amount is null or
    p_refund_amount <> coalesce(
      (v_existing.raw #>> '{data,object,amount_total}')::bigint,
      -1
    )
  ) then
    return 'partial_refund';
  end if;

  if v_existing.provider_event_at is not null and p_event_at < v_existing.provider_event_at then
    return 'stale';
  end if;

  update public.subscriptions
  set status = 'refunded',
      cancel_at_period_end = true,
      verified_at = now(),
      provider_event_at = p_event_at,
      raw = p_payload,
      updated_at = now()
  where id = v_existing.id;

  return 'applied';
end;
$$;

revoke all on function public.apply_stripe_prepaid_purchase_event(
  text, timestamptz, jsonb, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_stripe_prepaid_purchase_event(
  text, timestamptz, jsonb, uuid, text, text, text, text, text
) to service_role;

revoke all on function public.apply_stripe_prepaid_refund_event(
  text, timestamptz, jsonb, text, bigint, boolean
) from public, anon, authenticated;
grant execute on function public.apply_stripe_prepaid_refund_event(
  text, timestamptz, jsonb, text, bigint, boolean
) to service_role;
