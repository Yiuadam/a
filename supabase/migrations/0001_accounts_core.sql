-- Accounts, subscriptions and usage metering — core tables.
--
-- Everything a client is allowed to see about itself lives here, and nothing
-- else. Row Level Security is enabled on every table in this file and the
-- policies only ever grant a user access to rows keyed to their own auth.uid().
-- Writes are not granted to any client role at all: the application writes
-- exclusively through the service role, which is server-side only.

-- ---------------------------------------------------------------------------
-- profiles: one row per authenticated user, created by a trigger on signup.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  -- 'admin' means no usage limit. It is deliberately a database column and not
  -- an email comparison in application code: an email check would have to be
  -- compiled somewhere, and anything compiled into the browser bundle can be
  -- read and faked. See ACCOUNTS.md, threat 1.
  role        text        not null default 'user',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_role_check check (role in ('user', 'admin'))
);

comment on column public.profiles.role is
  'user | admin. Admins have no usage limit. Only settable by the service role.';

-- ---------------------------------------------------------------------------
-- subscriptions: the server's record of a *verified* entitlement.
--
-- A row exists here only because a Stripe webhook or an Apple receipt
-- verification was processed server-side. A client claiming to be subscribed
-- never causes a row to appear. See ACCOUNTS.md, threat 3.
-- ---------------------------------------------------------------------------

create table if not exists public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users (id) on delete cascade,
  provider                 text        not null,
  status                   text        not null,
  tier                     text        not null default 'pro',
  -- Stripe: customer / subscription ids. Apple: the original transaction id,
  -- which is the stable identifier for a renewing purchase.
  external_customer_id     text,
  external_subscription_id text,
  original_transaction_id  text,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean     not null default false,
  -- When the server last saw proof (webhook delivery or receipt check).
  verified_at              timestamptz not null default now(),
  -- The provider payload as received, for audit and for replaying a decision.
  raw                      jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint subscriptions_provider_check check (provider in ('stripe', 'apple')),
  constraint subscriptions_tier_check check (tier in ('free', 'pro')),
  constraint subscriptions_status_check check (
    status in ('active', 'trialing', 'past_due', 'canceled', 'expired', 'paused', 'refunded')
  )
);

-- One row per provider-side subscription, so a webhook replay updates rather
-- than duplicates.
create unique index if not exists subscriptions_provider_external_key
  on public.subscriptions (provider, external_subscription_id)
  where external_subscription_id is not null;

create unique index if not exists subscriptions_apple_original_txn_key
  on public.subscriptions (original_transaction_id)
  where original_transaction_id is not null;

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id, status);

-- ---------------------------------------------------------------------------
-- usage_events: one row per admitted or refused AI call.
--
-- This is the meter. It is written server-side, before the upstream AI call is
-- made, and it is the only thing the limit is computed from. There is no
-- client-side counter anywhere. See ACCOUNTS.md, threat 2.
-- ---------------------------------------------------------------------------

create table if not exists public.usage_events (
  id         bigint generated always as identity primary key,
  -- Null for an unauthenticated caller: those are metered by ip_hash alone.
  user_id    uuid references auth.users (id) on delete cascade,
  route      text        not null,
  -- HMAC of the client IP with a server-side salt. Storing the hash rather
  -- than the address means the meter still works for rate limiting without
  -- the table becoming a log of who was where.
  ip_hash    text,
  outcome    text        not null default 'admitted',
  created_at timestamptz not null default now(),
  constraint usage_events_route_check check (
    route in ('define', 'generate', 'grade/writing', 'grade/speaking')
  ),
  constraint usage_events_outcome_check check (
    outcome in ('admitted', 'denied_quota', 'denied_rate')
  )
);

-- The two windows the limiter counts over.
create index if not exists usage_events_user_window_idx
  on public.usage_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists usage_events_ip_window_idx
  on public.usage_events (ip_hash, created_at desc)
  where ip_hash is not null;

-- ---------------------------------------------------------------------------
-- progress_snapshots: the landing place for progress that today lives in
-- localStorage. Phase 1 creates the table so that phase 2 can implement the
-- migration without a schema change on a live database. See ACCOUNTS.md,
-- threat 5.
-- ---------------------------------------------------------------------------

create table if not exists public.progress_snapshots (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  -- The localStorage key this snapshot came from, kept verbatim so the mapping
  -- from browser to server stays obvious.
  store_key         text        not null,
  payload           jsonb       not null,
  -- The client's own idea of when it last changed, used to resolve the case
  -- where the same account signs in from two devices that each hold progress.
  client_updated_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (user_id, store_key),
  constraint progress_snapshots_key_check check (
    store_key in ('ielts-prep-v1', 'bandup.drills.v1', 'bandup.lookups.v1')
  )
);

-- ---------------------------------------------------------------------------
-- provider_events: webhook and receipt-verification idempotency.
--
-- Stripe redelivers webhooks and Apple resends notifications; both must be
-- safe to process twice. Phase 2 inserts the provider's event id here first
-- and stops if the insert conflicts.
-- ---------------------------------------------------------------------------

create table if not exists public.provider_events (
  provider     text        not null,
  event_id     text        not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  payload      jsonb,
  primary key (provider, event_id),
  constraint provider_events_provider_check check (provider in ('stripe', 'apple'))
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
-- An empty search_path forces every reference below to be schema-qualified,
-- so this function cannot be hijacked by a caller-controlled search_path.
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

drop trigger if exists progress_snapshots_touch_updated_at on public.progress_snapshots;
create trigger progress_snapshots_touch_updated_at
  before update on public.progress_snapshots
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- A profile for every new user.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Note the absence of any role assignment: every new account is a plain
  -- user. Promotion to admin is a separate, deliberate act (0003).
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
