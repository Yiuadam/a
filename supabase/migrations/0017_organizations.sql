/*
  Organizations, teachers and durable practice history.

  Security model
  --------------
  The browser has no table or function privileges here. Every request enters
  through a service-role-only RPC and every RPC rechecks the actor, membership,
  assignment and entitlement inside the same transaction as its write.

  Practice attempts belong to the learner, not an organization. An organization
  can archive its view or create an irreversible organization-scoped tombstone,
  but it can never delete the learner's source row (the same attempt may be
  shared with another organization later).
*/

-- -------------------------------------------------------------------------
-- Core records
-- -------------------------------------------------------------------------

create table if not exists public.organization_applications (
  id                  uuid primary key default gen_random_uuid(),
  applicant_user_id   uuid references auth.users (id) on delete set null,
  organization_name   text not null,
  purpose             text not null,
  country             text not null,
  contact_email       text not null,
  estimated_students  integer,
  applicant_role      text not null,
  status              text not null default 'submitted',
  submitted_at        timestamptz,
  reviewed_at         timestamptz,
  reviewed_by         uuid references auth.users (id) on delete set null,
  review_note         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint organization_applications_name_check
    check (char_length(btrim(organization_name)) between 2 and 120),
  constraint organization_applications_purpose_check
    check (char_length(btrim(purpose)) between 10 and 1200),
  constraint organization_applications_country_check
    check (char_length(btrim(country)) between 2 and 80),
  constraint organization_applications_email_check
    check (char_length(btrim(contact_email)) between 3 and 254 and position('@' in contact_email) > 1),
  constraint organization_applications_estimate_check
    check (estimated_students is null or estimated_students between 1 and 1000000),
  constraint organization_applications_role_check
    check (char_length(btrim(applicant_role)) between 2 and 80),
  constraint organization_applications_status_check
    check (status in ('draft', 'submitted', 'under_review', 'approved', 'rejected'))
);

create index if not exists organization_applications_applicant_idx
  on public.organization_applications (applicant_user_id, created_at desc);
create index if not exists organization_applications_review_queue_idx
  on public.organization_applications (status, submitted_at)
  where status in ('submitted', 'under_review');

create table if not exists public.organizations (
  id              uuid primary key default gen_random_uuid(),
  -- Approval evidence is immutable organization provenance. Account cleanup
  -- may clear the applicant, but an approved application cannot be deleted
  -- while its organization exists.
  application_id  uuid unique references public.organization_applications (id) on delete restrict,
  name            text not null,
  slug            text unique,
  join_code       text not null unique,
  status          text not null default 'active',
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organizations_name_check check (char_length(btrim(name)) between 2 and 120),
  constraint organizations_slug_check
    check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  constraint organizations_join_code_check check (join_code ~ '^[a-f0-9]{12,40}$'),
  constraint organizations_status_check check (status in ('pending', 'active', 'suspended', 'closed'))
);

-- Future-ready organization billing. Nothing in this migration charges a card.
create table if not exists public.organization_seat_pools (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete restrict,
  provider                 text,
  external_subscription_id text,
  purchased_seats          integer not null,
  status                   text not null default 'pending',
  starts_at                timestamptz not null default now(),
  ends_at                  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint organization_seat_pools_provider_check
    check (provider is null or provider in ('stripe', 'apple', 'wechat_pay', 'alipay', 'manual')),
  constraint organization_seat_pools_count_check check (purchased_seats between 1 and 1000000),
  constraint organization_seat_pools_status_check check (status in ('pending', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  constraint organization_seat_pools_dates_check check (ends_at is null or ends_at > starts_at)
);

create unique index if not exists organization_seat_pools_provider_key
  on public.organization_seat_pools (provider, external_subscription_id)
  where external_subscription_id is not null;
create index if not exists organization_seat_pools_active_idx
  on public.organization_seat_pools (organization_id, ends_at)
  where status = 'active';

create table if not exists public.organization_seat_allocations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  seat_pool_id     uuid not null references public.organization_seat_pools (id) on delete restrict,
  user_id          uuid not null references auth.users (id) on delete cascade,
  status           text not null default 'reserved',
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz,
  allocated_by     uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint organization_seat_allocations_status_check
    check (status in ('reserved', 'active', 'released', 'expired')),
  constraint organization_seat_allocations_dates_check check (ends_at is null or ends_at > starts_at)
);

create unique index if not exists organization_seat_allocations_one_live_user
  on public.organization_seat_allocations (organization_id, user_id)
  where status in ('reserved', 'active');
create index if not exists organization_seat_allocations_pool_idx
  on public.organization_seat_allocations (seat_pool_id, status);

create table if not exists public.organization_memberships (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete restrict,
  user_id                 uuid not null references auth.users (id) on delete cascade,
  role                    text not null,
  status                  text not null default 'pending',
  share_future_history    boolean not null default true,
  share_pre_join_history  boolean not null default false,
  joined_at               timestamptz,
  status_changed_at       timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, user_id),
  constraint organization_memberships_role_check
    check (role in ('owner', 'manager', 'teacher', 'student')),
  constraint organization_memberships_status_check
    check (status in ('invited', 'pending', 'active', 'leave_requested', 'suspended', 'removed')),
  constraint organization_memberships_joined_check
    check (status not in ('active', 'leave_requested') or joined_at is not null),
  -- Future-history sharing is consented on join and may later be paused only
  -- by the approved access-change workflow below.
  constraint organization_students_share_future_check check (true)
);

create index if not exists organization_memberships_org_role_idx
  on public.organization_memberships (organization_id, role, status);
create index if not exists organization_memberships_user_idx
  on public.organization_memberships (user_id, status, created_at desc);

create table if not exists public.teacher_student_assignments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  teacher_user_id  uuid not null references auth.users (id) on delete cascade,
  student_user_id  uuid not null references auth.users (id) on delete cascade,
  assigned_by      uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users (id) on delete set null,
  constraint teacher_student_assignments_distinct_check check (teacher_user_id <> student_user_id)
);

create unique index if not exists teacher_student_assignments_one_active
  on public.teacher_student_assignments (organization_id, teacher_user_id, student_user_id)
  where revoked_at is null;
create index if not exists teacher_student_assignments_teacher_idx
  on public.teacher_student_assignments (organization_id, teacher_user_id, student_user_id)
  where revoked_at is null;
create index if not exists teacher_student_assignments_student_idx
  on public.teacher_student_assignments (organization_id, student_user_id, teacher_user_id)
  where revoked_at is null;

create table if not exists public.organization_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  kind              text not null,
  status            text not null default 'pending',
  requester_user_id uuid not null references auth.users (id) on delete cascade,
  target_user_id    uuid references auth.users (id) on delete cascade,
  requested_role    text,
  requested_value   boolean,
  invitation_email  text,
  invitation_token_hash text,
  note              text,
  decided_by        uuid references auth.users (id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint organization_requests_kind_check
    check (kind in ('join', 'leave', 'history_access_change', 'invitation')),
  constraint organization_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint organization_requests_role_check
    check (requested_role is null or requested_role in ('owner', 'manager', 'teacher', 'student')),
  constraint organization_requests_invitation_binding_check check (
    kind <> 'invitation'
    or target_user_id is not null
    or invitation_email is not null
  ),
  constraint organization_requests_note_check check (note is null or char_length(note) <= 1200),
  constraint organization_requests_decision_check
    check ((status = 'pending' and decided_at is null) or status <> 'pending')
);

create index if not exists organization_requests_queue_idx
  on public.organization_requests (organization_id, status, kind, created_at)
  where status = 'pending';
create index if not exists organization_requests_requester_idx
  on public.organization_requests (requester_user_id, created_at desc);
create unique index if not exists organization_requests_one_pending_member_kind
  on public.organization_requests (organization_id, requester_user_id, kind)
  where status = 'pending' and kind in ('join', 'leave', 'history_access_change');
create unique index if not exists organization_requests_invitation_token
  on public.organization_requests (invitation_token_hash)
  where invitation_token_hash is not null;

-- Exact ModuleResult JSON is retained, including writing essays and speaking
-- transcripts. Derived columns exist only for indexed dashboards.
create table if not exists public.practice_attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  source_key    text not null,
  module        text not null,
  test_id       text not null,
  test_title    text not null,
  band          numeric(4,2) not null,
  raw_score     numeric,
  score_out_of  numeric,
  submitted_at  timestamptz not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, source_key),
  constraint practice_attempts_module_check check (module in ('listening', 'reading', 'writing', 'speaking')),
  constraint practice_attempts_test_id_check check (char_length(test_id) between 1 and 180),
  constraint practice_attempts_title_check check (char_length(test_title) between 1 and 600),
  constraint practice_attempts_band_check check (band between 0 and 9),
  constraint practice_attempts_scores_check check (
    (raw_score is null or raw_score >= 0) and
    (score_out_of is null or score_out_of > 0) and
    (raw_score is null or score_out_of is null or raw_score <= score_out_of)
  ),
  constraint practice_attempts_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2097152
  )
);

create index if not exists practice_attempts_user_time_idx
  on public.practice_attempts (user_id, submitted_at desc);
create index if not exists practice_attempts_user_module_idx
  on public.practice_attempts (user_id, module, submitted_at desc);

create table if not exists public.organization_attempt_archives (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- An archive is only a reversible organization view. If an account erasure
  -- removes the learner-owned source, this secondary view disappears too.
  attempt_id       uuid not null references public.practice_attempts (id) on delete cascade,
  archived_by      uuid references auth.users (id) on delete set null,
  archived_at      timestamptz not null default now(),
  reason           text,
  restored_by      uuid references auth.users (id) on delete set null,
  restored_at      timestamptz,
  primary key (organization_id, attempt_id),
  constraint organization_attempt_archives_reason_check check (reason is null or char_length(reason) <= 600),
  constraint organization_attempt_archives_restore_check
    check (restored_at is not null or restored_by is null)
);

create index if not exists organization_attempt_archives_active_idx
  on public.organization_attempt_archives (organization_id, archived_at desc)
  where restored_at is null;

-- Insert-only: once an organization permanently removes its view, no future
-- sync or staff action can resurrect it.
create table if not exists public.organization_attempt_tombstones (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Deliberately not a foreign key. Account erasure may delete the learner's
  -- source attempt; immutable organization deletion evidence must neither
  -- block that erasure nor be cascaded away by it.
  attempt_id       uuid not null,
  -- Kept without a cascading foreign key: immutable evidence must survive
  -- later account deletion without either mutating this row or blocking it.
  removed_by       uuid not null,
  removed_at       timestamptz not null default now(),
  reason           text not null,
  primary key (organization_id, attempt_id),
  constraint organization_attempt_tombstones_reason_check
    check (char_length(btrim(reason)) between 3 and 600)
);

comment on table public.organization_attempt_tombstones is
  'Immutable organization-view deletion evidence. Must be included in encrypted off-site backups; never purge while its organization exists.';

create table if not exists public.organization_audit_log (
  id               bigint generated always as identity primary key,
  organization_id  uuid references public.organizations (id) on delete restrict,
  actor_user_id     uuid,
  action            text not null,
  target_user_id    uuid,
  entity_type       text,
  entity_id         uuid,
  details           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  constraint organization_audit_action_check check (char_length(action) between 2 and 100),
  constraint organization_audit_details_check check (jsonb_typeof(details) = 'object')
);

comment on table public.organization_audit_log is
  'Append-only privileged-action ledger. Must be included in encrypted off-site backups and point-in-time recovery.';

create index if not exists organization_audit_log_org_time_idx
  on public.organization_audit_log (organization_id, created_at desc);
create index if not exists organization_audit_log_target_idx
  on public.organization_audit_log (target_user_id, created_at desc)
  where target_user_id is not null;

create table if not exists public.organization_command_receipts (
  actor_user_id   uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null,
  action          text not null,
  request_hash    text not null,
  response        jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (actor_user_id, idempotency_key),
  constraint organization_command_receipts_key_check
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{12,120}$')
);

create table if not exists public.organization_sync_receipts (
  actor_user_id   uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null,
  request_hash    text not null,
  response        jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (actor_user_id, idempotency_key),
  constraint organization_sync_receipts_key_check
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{12,120}$')
);

-- -------------------------------------------------------------------------
-- Timestamp and immutability guards
-- -------------------------------------------------------------------------

drop trigger if exists organization_applications_touch_updated_at on public.organization_applications;
create trigger organization_applications_touch_updated_at
  before update on public.organization_applications
  for each row execute function public.touch_updated_at();
drop trigger if exists organizations_touch_updated_at on public.organizations;
create trigger organizations_touch_updated_at
  before update on public.organizations
  for each row execute function public.touch_updated_at();
drop trigger if exists organization_seat_pools_touch_updated_at on public.organization_seat_pools;
create trigger organization_seat_pools_touch_updated_at
  before update on public.organization_seat_pools
  for each row execute function public.touch_updated_at();
drop trigger if exists organization_seat_allocations_touch_updated_at on public.organization_seat_allocations;
create trigger organization_seat_allocations_touch_updated_at
  before update on public.organization_seat_allocations
  for each row execute function public.touch_updated_at();
drop trigger if exists organization_memberships_touch_updated_at on public.organization_memberships;
create trigger organization_memberships_touch_updated_at
  before update on public.organization_memberships
  for each row execute function public.touch_updated_at();
drop trigger if exists organization_requests_touch_updated_at on public.organization_requests;
create trigger organization_requests_touch_updated_at
  before update on public.organization_requests
  for each row execute function public.touch_updated_at();
drop trigger if exists practice_attempts_touch_updated_at on public.practice_attempts;
create trigger practice_attempts_touch_updated_at
  before update on public.practice_attempts
  for each row execute function public.touch_updated_at();

create or replace function public.organization_refuse_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end;
$$;

create or replace function public.organization_refuse_audit_insert_without_context()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.actor_user_id is null and new.action not like 'system.%' then
    raise exception 'Audit actor is required' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_audit_log_immutable on public.organization_audit_log;
create trigger organization_audit_log_immutable
  before update or delete on public.organization_audit_log
  for each row execute function public.organization_refuse_mutation();
drop trigger if exists organization_audit_log_insert_guard on public.organization_audit_log;
create trigger organization_audit_log_insert_guard
  before insert on public.organization_audit_log
  for each row execute function public.organization_refuse_audit_insert_without_context();
drop trigger if exists organization_attempt_tombstones_immutable on public.organization_attempt_tombstones;
create trigger organization_attempt_tombstones_immutable
  before update or delete on public.organization_attempt_tombstones
  for each row execute function public.organization_refuse_mutation();
-- -------------------------------------------------------------------------
-- Authorization helpers
-- -------------------------------------------------------------------------

create or replace function public.organization_student_is_eligible(p_user uuid, p_organization uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.profiles p
      where p.id = p_user and p.role = 'admin'
    )
    or exists (
      select 1
      from public.subscriptions s
      where s.user_id = p_user
        and s.tier in ('standard', 'plus', 'pro')
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    )
    or exists (
      select 1
      from public.organization_seat_allocations a
      join public.organization_seat_pools pool on pool.id = a.seat_pool_id
      where a.organization_id = p_organization
        and a.user_id = p_user
        and a.status in ('reserved', 'active')
        and a.starts_at <= now()
        and (a.ends_at is null or a.ends_at > now())
        and pool.organization_id = p_organization
        and pool.status = 'active'
        and pool.starts_at <= now()
        and (pool.ends_at is null or pool.ends_at > now())
    );
$$;

create or replace function public.organization_enforce_student_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'student'
     and new.status = 'active'
     and not public.organization_student_is_eligible(new.user_id, new.organization_id) then
    raise exception 'An active Standard, Plus or Pro plan, or an organization seat, is required.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.organization_validate_seat_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organization_seat_pools pool
    where pool.id = new.seat_pool_id
      and pool.organization_id = new.organization_id
  ) then
    raise exception 'Seat pool belongs to another organization.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_seat_allocations_match_pool on public.organization_seat_allocations;
create trigger organization_seat_allocations_match_pool
  before insert or update of organization_id, seat_pool_id
  on public.organization_seat_allocations
  for each row execute function public.organization_validate_seat_allocation();

create or replace function public.organization_validate_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organization_memberships teacher
    where teacher.organization_id = new.organization_id
      and teacher.user_id = new.teacher_user_id
      and teacher.role = 'teacher'
      and teacher.status = 'active'
  ) or not exists (
    select 1 from public.organization_memberships student
    where student.organization_id = new.organization_id
      and student.user_id = new.student_user_id
      and student.role = 'student'
      and student.status in ('active', 'leave_requested')
  ) then
    raise exception 'Teacher and student must be active in the same organization.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists teacher_student_assignments_membership_guard on public.teacher_student_assignments;
create trigger teacher_student_assignments_membership_guard
  before insert or update of organization_id, teacher_user_id, student_user_id, revoked_at
  on public.teacher_student_assignments
  for each row when (new.revoked_at is null)
  execute function public.organization_validate_assignment();

drop trigger if exists organization_memberships_entitlement on public.organization_memberships;
create trigger organization_memberships_entitlement
  before insert or update of role, status, organization_id, user_id
  on public.organization_memberships
  for each row execute function public.organization_enforce_student_entitlement();

create or replace function public.organization_member_role(
  p_actor uuid,
  p_organization uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = p_actor
    and m.organization_id = p_organization
    and m.status in ('active', 'leave_requested')
    and o.status = 'active'
  limit 1;
$$;

-- The server supplies a platform-admin hint, but PostgreSQL derives authority
-- from profiles.role and refuses any mismatch. This prevents an internal
-- caller bug (or a future route accidentally passing true) from widening
-- access.

create or replace function public.organization_actor_is_platform_admin(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_actor and p.role = 'admin'
  );
$$;

create or replace function public.organization_is_assigned(
  p_actor uuid,
  p_organization uuid,
  p_student uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.teacher_student_assignments a
    join public.organization_memberships t
      on t.organization_id = a.organization_id and t.user_id = a.teacher_user_id
    join public.organization_memberships s
      on s.organization_id = a.organization_id and s.user_id = a.student_user_id
    where a.organization_id = p_organization
      and a.teacher_user_id = p_actor
      and a.student_user_id = p_student
      and a.revoked_at is null
      and t.role = 'teacher' and t.status = 'active'
      and s.role = 'student' and s.status in ('active', 'leave_requested', 'suspended')
  );
$$;

create or replace function public.organization_attempt_is_shared(
  p_organization uuid,
  p_student uuid,
  p_attempt uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.practice_attempts a on a.user_id = m.user_id and a.id = p_attempt
    where m.organization_id = p_organization
      and m.user_id = p_student
      and m.role = 'student'
      and m.status in ('active', 'leave_requested', 'suspended')
      and (
        (a.submitted_at >= m.joined_at and m.share_future_history)
        or (a.submitted_at < m.joined_at and m.share_pre_join_history)
      )
  );
$$;

create or replace function public.organization_audit(
  p_organization uuid,
  p_actor uuid,
  p_action text,
  p_target uuid default null,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.organization_audit_log
    (organization_id, actor_user_id, action, target_user_id, entity_type, entity_id, details)
  values
    (p_organization, p_actor, p_action, p_target, p_entity_type, p_entity_id,
     case when jsonb_typeof(coalesce(p_details, '{}'::jsonb)) = 'object'
          then coalesce(p_details, '{}'::jsonb) else '{}'::jsonb end);
$$;

-- -------------------------------------------------------------------------
-- Read models
-- -------------------------------------------------------------------------

create or replace function public.organization_student_history(
  p_actor uuid,
  p_platform_admin boolean,
  p_student uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_role text;
  v_membership public.organization_memberships%rowtype;
  v_result jsonb;
begin
  if p_actor is null or p_student is null then
    raise exception 'Not found.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;

  select m.*
    into v_membership
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = p_student
    and m.role = 'student'
    and m.status in ('active', 'leave_requested', 'suspended')
    and o.status in ('active', 'suspended')
    and (
      coalesce(p_platform_admin, false)
      or (o.status = 'active' and exists (
        select 1 from public.organization_memberships actor
        where actor.organization_id = m.organization_id
          and actor.user_id = p_actor
          and actor.status = 'active'
          and actor.role in ('manager', 'owner')
      ))
      or (o.status = 'active' and public.organization_is_assigned(p_actor, m.organization_id, p_student))
    )
  order by m.joined_at desc nulls last
  limit 1;

  v_org := v_membership.organization_id;
  if v_org is null then
    raise exception 'Not found.' using errcode = '42501';
  end if;
  v_role := public.organization_member_role(p_actor, v_org);

  select jsonb_build_object(
    'organization', jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'slug', o.slug,
      'status', o.status,
      'memberCount', (select count(*) from public.organization_memberships m where m.organization_id = o.id and m.status <> 'removed'),
      'studentCount', (select count(*) from public.organization_memberships m where m.organization_id = o.id and m.role = 'student' and m.status <> 'removed'),
      'createdAt', o.created_at
    ),
    'student', jsonb_build_object(
      'userId', v_membership.user_id,
      'membershipId', v_membership.id,
      'displayName', profile.display_name,
      'email', profile.email,
      'avatarUrl', null,
      'lastActiveAt', (select max(a.submitted_at) from public.practice_attempts a where a.user_id = v_membership.user_id),
      'completedAttempts', (
        select count(*)
        from public.practice_attempts a
        where a.user_id = v_membership.user_id
          and public.organization_attempt_is_shared(v_org, v_membership.user_id, a.id)
          and not exists (
            select 1 from public.organization_attempt_tombstones t
            where t.organization_id = v_org and t.attempt_id = a.id
          )
      ),
      'latestBands', coalesce((
        select jsonb_object_agg(module, band)
        from (
          select distinct on (a.module) a.module, a.band
          from public.practice_attempts a
          where a.user_id = v_membership.user_id
            and public.organization_attempt_is_shared(v_org, v_membership.user_id, a.id)
            and not exists (
              select 1 from public.organization_attempt_tombstones t
              where t.organization_id = v_org and t.attempt_id = a.id
            )
          order by a.module, a.submitted_at desc
        ) latest
      ), '{}'::jsonb),
      'archivedAt', null
    ),
    'canArchive', coalesce(p_platform_admin, false) or v_role in ('teacher', 'manager', 'owner'),
    'canPermanentlyDelete', coalesce(p_platform_admin, false) or v_role in ('manager', 'owner'),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'skill', a.module,
        'title', a.test_title,
        'submittedAt', a.submitted_at,
        'score', a.raw_score,
        'scoreOutOf', a.score_out_of,
        'band', a.band,
        'feedbackSummary', coalesce(
          a.payload #>> '{review,grade,summary}',
          a.payload #>> '{review,grade,feedback}',
          a.payload #>> '{review,summary}'
        ),
        -- Exact payload is included so the existing History detail can reopen
        -- essays, transcripts, questions and feedback without reconstruction.
        'result', a.payload,
        'review', a.payload -> 'review',
        'archivedAt', ar.archived_at
      ) order by a.submitted_at desc)
      from public.practice_attempts a
      left join public.organization_attempt_archives ar
        on ar.organization_id = v_org and ar.attempt_id = a.id and ar.restored_at is null
      where a.user_id = v_membership.user_id
        and public.organization_attempt_is_shared(v_org, v_membership.user_id, a.id)
        and not exists (
          select 1 from public.organization_attempt_tombstones t
          where t.organization_id = v_org and t.attempt_id = a.id
        )
    ), '[]'::jsonb)
  ) into v_result
  from public.organizations o
  left join public.profiles profile on profile.id = v_membership.user_id
  where o.id = v_org;

  return v_result;
end;
$$;

create or replace function public.organization_portal(
  p_actor uuid,
  p_platform_admin boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_active_org uuid;
  v_tier text;
  v_result jsonb;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;

  select e.tier into v_tier from public.resolve_entitlement(p_actor) e;

  -- Phase one exposes one active workspace. Multiple memberships remain stored
  -- and returned, but a suspended workspace must never win over an active one.
  -- If none are active, no organization-scoped member/student data is loaded.
  select m.organization_id, m.role
    into v_active_org, v_role
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = p_actor
    and m.status in ('active', 'leave_requested')
    and o.status = 'active'
  order by m.joined_at desc nulls last, m.created_at desc
  limit 1;

  if v_active_org is null and coalesce(p_platform_admin, false) then
    select o.id into v_active_org
    from public.organizations o
    order by (o.status = 'active') desc, o.created_at desc
    limit 1;
    v_role := 'owner';
  end if;

  select jsonb_build_object(
    'actor', jsonb_build_object(
      'signedIn', true,
      'userId', p_actor,
      'displayName', p.display_name,
      'email', p.email,
      'tier', v_tier,
      'platformAdmin', coalesce(p_platform_admin, false)
    ),
    'eligibility', jsonb_build_object(
      'canJoin', coalesce(p_platform_admin, false) or v_tier in ('standard', 'plus', 'pro', 'admin'),
      'canApplyToCreate', true,
      'reason', case when coalesce(p_platform_admin, false) or v_tier in ('standard', 'plus', 'pro', 'admin') then null
                     else 'A Standard, Plus or Pro plan, or an organization seat, is required to join as a student.' end
    ),
    'canClearOwnHistory', not exists (
      select 1 from public.organization_memberships ownm
      where ownm.user_id = p_actor and ownm.role = 'student'
        and ownm.status in ('active', 'leave_requested', 'suspended')
    ),
    'activeOrganizationId', v_active_org,
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'organization', jsonb_build_object(
          'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
          'memberCount', (select count(*) from public.organization_memberships x where x.organization_id = o.id and x.status <> 'removed'),
          'studentCount', (select count(*) from public.organization_memberships x where x.organization_id = o.id and x.role = 'student' and x.status <> 'removed'),
          'createdAt', o.created_at
        ),
        'role', m.role,
        'status', m.status,
        'joinedAt', m.joined_at,
        'shareFutureHistory', m.share_future_history,
        'sharePreJoinHistory', m.share_pre_join_history,
        'preJoinHistoryRequestStatus', (
          select r.status from public.organization_requests r
          where r.organization_id = m.organization_id and r.requester_user_id = p_actor
            and r.kind = 'history_access_change' and coalesce(r.note, '') <> 'scope:future'
          order by r.created_at desc limit 1
        ),
        'futureHistoryRequestStatus', (
          select r.status from public.organization_requests r
          where r.organization_id = m.organization_id and r.requester_user_id = p_actor
            and r.kind = 'history_access_change' and r.note = 'scope:future'
          order by r.created_at desc limit 1
        ),
        'leaveRequestStatus', (
          select r.status from public.organization_requests r
          where r.organization_id = m.organization_id and r.requester_user_id = p_actor
            and r.kind = 'leave'
          order by r.created_at desc limit 1
        )
      ) order by m.created_at desc)
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id
      where m.user_id = p_actor and m.status <> 'removed'
    ), '[]'::jsonb),
    'applications', case when coalesce(p_platform_admin, false) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'organizationName', a.organization_name, 'purpose', a.purpose,
        'country', a.country, 'contactEmail', a.contact_email,
        'estimatedStudents', a.estimated_students, 'applicantRole', a.applicant_role,
        'status', a.status, 'submittedAt', a.submitted_at,
        'reviewedAt', a.reviewed_at, 'reviewNote', a.review_note
      ) order by a.created_at desc) from public.organization_applications a
    ), '[]'::jsonb) else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'organizationName', a.organization_name, 'purpose', a.purpose,
        'country', a.country, 'contactEmail', a.contact_email,
        'estimatedStudents', a.estimated_students, 'applicantRole', a.applicant_role,
        'status', a.status, 'submittedAt', a.submitted_at,
        'reviewedAt', a.reviewed_at, 'reviewNote', a.review_note
      ) order by a.created_at desc)
      from public.organization_applications a where a.applicant_user_id = p_actor
    ), '[]'::jsonb) end,
    'organizations', case when coalesce(p_platform_admin, false) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
        'memberCount', (select count(*) from public.organization_memberships x where x.organization_id = o.id and x.status <> 'removed'),
        'studentCount', (select count(*) from public.organization_memberships x where x.organization_id = o.id and x.role = 'student' and x.status <> 'removed'),
        'createdAt', o.created_at
      ) order by o.created_at desc) from public.organizations o
    ), '[]'::jsonb) else null end,
    'members', case when coalesce(p_platform_admin, false) or v_role in ('manager', 'owner') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', m.id, 'userId', m.user_id, 'displayName', member.display_name,
        'email', member.email, 'avatarUrl', null, 'role', m.role, 'status', m.status,
        'joinedAt', m.joined_at,
        'assignedTeacherIds', coalesce((select jsonb_agg(a.teacher_user_id) from public.teacher_student_assignments a where a.organization_id = m.organization_id and a.student_user_id = m.user_id and a.revoked_at is null), '[]'::jsonb)
      ) order by m.role, member.display_name nulls last, member.email)
      from public.organization_memberships m
      left join public.profiles member on member.id = m.user_id
      where m.organization_id = v_active_org and m.status <> 'removed'
    ), '[]'::jsonb) else null end,
    'requests', case when coalesce(p_platform_admin, false) or v_role in ('manager', 'owner', 'teacher') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'organizationId', r.organization_id, 'kind', r.kind,
        'status', r.status, 'requesterUserId', r.requester_user_id,
        'requesterName', requester.display_name, 'requesterEmail', requester.email,
        'targetUserId', r.target_user_id, 'invitationEmail', r.invitation_email,
        'requestedRole', r.requested_role, 'requestedValue', r.requested_value,
        'note', r.note, 'createdAt', r.created_at, 'decidedAt', r.decided_at
      ) order by r.created_at desc)
      from public.organization_requests r
      left join public.profiles requester on requester.id = r.requester_user_id
      where r.organization_id = v_active_org
        and (
          coalesce(p_platform_admin, false) or v_role in ('manager', 'owner')
          or (
            v_role = 'teacher' and r.kind = 'history_access_change' and r.status = 'pending'
            and public.organization_is_assigned(p_actor, r.organization_id, r.requester_user_id)
          )
        )
    ), '[]'::jsonb) else null end,
    'students', case when coalesce(p_platform_admin, false) or v_role in ('teacher', 'manager', 'owner') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', student.id, 'membershipId', m.id, 'displayName', student.display_name,
        'email', student.email, 'avatarUrl', null,
        'lastActiveAt', (select max(a.submitted_at) from public.practice_attempts a where a.user_id = m.user_id),
        'completedAttempts', (select count(*) from public.practice_attempts a where a.user_id = m.user_id and public.organization_attempt_is_shared(m.organization_id, m.user_id, a.id) and not exists (select 1 from public.organization_attempt_tombstones t where t.organization_id = m.organization_id and t.attempt_id = a.id)),
        'latestBands', coalesce((select jsonb_object_agg(latest.module, latest.band) from (select distinct on (a.module) a.module, a.band from public.practice_attempts a where a.user_id = m.user_id and public.organization_attempt_is_shared(m.organization_id, m.user_id, a.id) and not exists (select 1 from public.organization_attempt_tombstones t where t.organization_id = m.organization_id and t.attempt_id = a.id) order by a.module, a.submitted_at desc) latest), '{}'::jsonb),
        'archivedAt', null
      ) order by student.display_name nulls last, student.email)
      from public.organization_memberships m
      left join public.profiles student on student.id = m.user_id
      where m.organization_id = v_active_org and m.role = 'student'
        and m.status in ('active', 'leave_requested', 'suspended')
        and (coalesce(p_platform_admin, false) or v_role in ('manager', 'owner') or public.organization_is_assigned(p_actor, m.organization_id, m.user_id))
    ), '[]'::jsonb) else null end,
    'assignments', case when coalesce(p_platform_admin, false) or v_role in ('manager', 'owner') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'organizationId', a.organization_id,
        'teacherUserId', a.teacher_user_id, 'teacherName', teacher.display_name,
        'studentUserId', a.student_user_id, 'studentName', student.display_name,
        'createdAt', a.created_at
      ) order by a.created_at desc)
      from public.teacher_student_assignments a
      left join public.profiles teacher on teacher.id = a.teacher_user_id
      left join public.profiles student on student.id = a.student_user_id
      where a.organization_id = v_active_org and a.revoked_at is null
    ), '[]'::jsonb) else null end
  ) into v_result
  from public.profiles p where p.id = p_actor;

  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- Durable attempt synchronization
-- -------------------------------------------------------------------------

create or replace function public.organization_sync_attempts(
  p_actor uuid,
  p_attempts jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_prior public.organization_sync_receipts%rowtype;
  v_item jsonb;
  v_source text;
  v_count integer := 0;
  v_result jsonb;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{12,120}$' then
    raise exception 'Invalid request identifier.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_attempts) <> 'array' or jsonb_array_length(p_attempts) > 100
     or octet_length(p_attempts::text) > 8388608 then
    raise exception 'Invalid attempt batch.' using errcode = '22023';
  end if;

  v_hash := encode(sha256(convert_to(p_attempts::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('org-sync:' || p_actor::text || ':' || p_idempotency_key), 1, 16))::bit(64)::bigint
  );
  select * into v_prior from public.organization_sync_receipts
  where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.request_hash <> v_hash then
      raise exception 'Request identifier was already used with different data.' using errcode = '22023';
    end if;
    return v_prior.response;
  end if;

  for v_item in select value from jsonb_array_elements(p_attempts)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['module', 'testId', 'testTitle', 'band', 'date'])
       or v_item ->> 'module' not in ('listening', 'reading', 'writing', 'speaking')
       or char_length(v_item ->> 'testId') not between 1 and 180
       or char_length(v_item ->> 'testTitle') not between 1 and 600
       or (v_item ->> 'band')::numeric not between 0 and 9
       or octet_length(v_item::text) > 2097152 then
      raise exception 'Invalid practice attempt.' using errcode = '22023';
    end if;

    begin
      perform (v_item ->> 'date')::timestamptz;
    exception when others then
      raise exception 'Invalid attempt date.' using errcode = '22023';
    end;

    v_source := encode(sha256(convert_to(
      concat_ws('|', v_item ->> 'module', v_item ->> 'testId', v_item ->> 'date'),
      'UTF8'
    )), 'hex');

    insert into public.practice_attempts
      (user_id, source_key, module, test_id, test_title, band, raw_score,
       score_out_of, submitted_at, payload)
    values
      (p_actor, v_source, v_item ->> 'module', v_item ->> 'testId',
       v_item ->> 'testTitle', (v_item ->> 'band')::numeric,
       case when jsonb_typeof(v_item -> 'raw') = 'number' then (v_item ->> 'raw')::numeric end,
       case when jsonb_typeof(v_item -> 'total') = 'number' then (v_item ->> 'total')::numeric end,
       (v_item ->> 'date')::timestamptz, v_item)
    on conflict (user_id, source_key) do update
      set -- A later client may contain the detailed review that an old client
          -- did not. It may enrich, but never replace a nonempty review with a
          -- payload that omits it.
          payload = case
            when public.practice_attempts.payload ? 'review' and not (excluded.payload ? 'review')
              then public.practice_attempts.payload
            else excluded.payload
          end;
    v_count := v_count + 1;
  end loop;

  v_result := jsonb_build_object('ok', true, 'synced', v_count);
  insert into public.organization_sync_receipts
    (actor_user_id, idempotency_key, request_hash, response)
  values (p_actor, p_idempotency_key, v_hash, v_result);
  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- Atomic command bus
-- -------------------------------------------------------------------------

create or replace function public.organization_command(
  p_actor uuid,
  p_platform_admin boolean,
  p_action text,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_prior public.organization_command_receipts%rowtype;
  v_org uuid;
  v_user uuid;
  v_teacher uuid;
  v_student uuid;
  v_student_ids uuid[];
  v_attempt uuid;
  v_request public.organization_requests%rowtype;
  v_application public.organization_applications%rowtype;
  v_membership public.organization_memberships%rowtype;
  v_role text;
  v_requested_role text;
  v_approve boolean;
  v_share boolean;
  v_result jsonb;
  v_seat_pool uuid;
  v_capacity integer;
  v_invitee_email text;
  v_invitation_token text;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{12,120}$' then
    raise exception 'Invalid request identifier.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 65536 then
    raise exception 'Invalid command data.' using errcode = '22023';
  end if;
  if p_action not in (
    'submit_application', 'withdraw_application', 'decide_application',
    'suspend_organization', 'restore_organization',
    'invite_member', 'accept_invitation', 'request_to_join', 'decide_join_request',
    'request_to_leave', 'decide_leave_request', 'request_access_change',
    'decide_access_request', 'assign_teacher', 'assign_teacher_batch', 'unassign_teacher',
    'change_member_role', 'suspend_member', 'restore_member', 'remove_member',
    'archive_attempt', 'restore_attempt', 'remove_attempt_permanently',
    'set_prior_history_sharing', 'reserve_seat', 'release_seat'
  ) then
    raise exception 'Unknown organization action.' using errcode = '22023';
  end if;

  v_hash := encode(sha256(convert_to(p_action || ':' || p_payload::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('org-command:' || p_actor::text || ':' || p_idempotency_key), 1, 16))::bit(64)::bigint
  );
  select * into v_prior from public.organization_command_receipts
  where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.request_hash <> v_hash or v_prior.action <> p_action then
      raise exception 'Request identifier was already used with different data.' using errcode = '22023';
    end if;
    return v_prior.response;
  end if;

  begin
    v_org := nullif(p_payload ->> 'organizationId', '')::uuid;
    v_user := nullif(coalesce(p_payload ->> 'userId', p_payload ->> 'targetUserId'), '')::uuid;
    v_teacher := nullif(p_payload ->> 'teacherUserId', '')::uuid;
    v_student := nullif(p_payload ->> 'studentUserId', '')::uuid;
    v_attempt := nullif(p_payload ->> 'attemptId', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid identifier.' using errcode = '22023';
  end;

  -- Every organization-scoped mutation below should fail closed while BandUp
  -- has suspended/closed the workspace. Platform status and application
  -- decisions are the only commands allowed to operate without an active org.
  if v_org is not null
     and p_action not in ('decide_application', 'suspend_organization', 'restore_organization')
     and not exists (
       select 1 from public.organizations active_org
       where active_org.id = v_org and active_org.status = 'active'
     ) then
    raise exception 'Organization is not active.' using errcode = '42501';
  end if;

  -- Applying is intentionally independent of learner tier. Joining as a
  -- student is where the paid-plan/seat requirement is enforced.
  if p_action = 'submit_application' then
    insert into public.organization_applications
      (applicant_user_id, organization_name, purpose, country, contact_email,
       estimated_students, applicant_role, status, submitted_at)
    values
      (p_actor, btrim(p_payload ->> 'organizationName'), btrim(p_payload ->> 'purpose'),
       btrim(p_payload ->> 'country'), lower(btrim(p_payload ->> 'contactEmail')),
       nullif(p_payload ->> 'estimatedStudents', '')::integer,
       btrim(p_payload ->> 'applicantRole'), 'submitted', now())
    returning * into v_application;
    perform public.organization_audit(null, p_actor, p_action, p_actor, 'application', v_application.id);

  elsif p_action = 'withdraw_application' then
    update public.organization_applications
       set status = 'rejected', review_note = 'Withdrawn by applicant', reviewed_at = now(), reviewed_by = p_actor
     where id = nullif(p_payload ->> 'applicationId', '')::uuid
       and applicant_user_id = p_actor and status in ('draft', 'submitted', 'under_review')
     returning * into v_application;
    if not found then raise exception 'Application cannot be withdrawn.' using errcode = '42501'; end if;
    perform public.organization_audit(null, p_actor, p_action, p_actor, 'application', v_application.id);

  elsif p_action = 'decide_application' then
    if not coalesce(p_platform_admin, false) then raise exception 'Not permitted.' using errcode = '42501'; end if;
    -- A platform organization status button may still arrive from an older UI.
    if p_payload ? 'organizationId' then
      if coalesce((p_payload ->> 'restore')::boolean, false) then
        update public.organizations set status = 'active' where id = v_org;
      else
        update public.organizations set status = 'suspended' where id = v_org;
      end if;
      if not found then raise exception 'Organization not found.'; end if;
      perform public.organization_audit(v_org, p_actor, p_action, null, 'organization', v_org, jsonb_build_object('legacy', true));
    else
      v_approve := coalesce((p_payload ->> 'approve')::boolean, false);
      update public.organization_applications
         set status = case when v_approve then 'approved' else 'rejected' end,
             reviewed_at = now(), reviewed_by = p_actor,
             review_note = nullif(btrim(p_payload ->> 'note'), '')
       where id = nullif(p_payload ->> 'applicationId', '')::uuid
         and status in ('submitted', 'under_review')
       returning * into v_application;
      if not found then raise exception 'Application is no longer awaiting review.'; end if;
      if v_approve then
        insert into public.organizations (application_id, name, slug, join_code, status, created_by)
        values (
          v_application.id, v_application.organization_name, null,
          substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), 'active', v_application.applicant_user_id
        ) returning id into v_org;
        insert into public.organization_memberships
          (organization_id, user_id, role, status, joined_at)
        values (v_org, v_application.applicant_user_id, 'owner', 'active', now());
      end if;
      perform public.organization_audit(v_org, p_actor, p_action, v_application.applicant_user_id, 'application', v_application.id, jsonb_build_object('approved', v_approve));
    end if;

  elsif p_action in ('suspend_organization', 'restore_organization') then
    if not coalesce(p_platform_admin, false) then raise exception 'Not permitted.' using errcode = '42501'; end if;
    update public.organizations
       set status = case when p_action = 'suspend_organization' then 'suspended' else 'active' end
     where id = v_org and status <> 'closed';
    if not found then raise exception 'Organization not found.'; end if;
    perform public.organization_audit(v_org, p_actor, p_action, null, 'organization', v_org);

  elsif p_action = 'request_to_join' then
    select id into v_org from public.organizations
    where join_code = lower(btrim(p_payload ->> 'code')) and status = 'active';
    if v_org is null then raise exception 'Organization code not found.'; end if;
    if not public.organization_student_is_eligible(p_actor, v_org) then
      raise exception 'A Standard, Plus or Pro plan, or an organization seat, is required.' using errcode = '42501';
    end if;
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values (v_org, p_actor, 'student', 'pending')
    on conflict (organization_id, user_id) do update
      set status = case when public.organization_memberships.status = 'removed' then 'pending' else public.organization_memberships.status end;
    insert into public.organization_requests (organization_id, kind, requester_user_id, target_user_id)
    values (v_org, 'join', p_actor, p_actor)
    on conflict (organization_id, requester_user_id, kind)
      where status = 'pending' and kind in ('join', 'leave', 'history_access_change')
      do nothing;
    perform public.organization_audit(v_org, p_actor, p_action, p_actor, 'membership', null);

  elsif p_action = 'decide_join_request' then
    select * into v_request from public.organization_requests
    where id = nullif(p_payload ->> 'requestId', '')::uuid
      and kind = 'join' and status = 'pending'
    for update;
    if not found then raise exception 'Request is no longer awaiting review.'; end if;
    v_org := v_request.organization_id;
    if not exists (select 1 from public.organizations o where o.id = v_org and o.status = 'active') then
      raise exception 'Organization is not active.' using errcode = '42501';
    end if;
    v_role := public.organization_member_role(p_actor, v_org);
    if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then
      raise exception 'Not permitted.' using errcode = '42501';
    end if;
    v_approve := coalesce((p_payload ->> 'approve')::boolean, false);
    if v_approve and not public.organization_student_is_eligible(v_request.requester_user_id, v_org) then
      raise exception 'The student no longer has an eligible plan or seat.' using errcode = '42501';
    end if;
    update public.organization_requests
       set status = case when v_approve then 'approved' else 'rejected' end,
           decided_by = p_actor, decided_at = now()
     where id = v_request.id;
    update public.organization_memberships
       set status = case when v_approve then 'active' else 'removed' end,
           joined_at = case when v_approve then coalesce(joined_at, now()) else joined_at end,
           status_changed_at = now()
     where organization_id = v_org and user_id = v_request.requester_user_id;
    perform public.organization_audit(v_org, p_actor, p_action, v_request.requester_user_id,
      'request', v_request.id, jsonb_build_object('approved', v_approve));

  elsif p_action in ('decide_leave_request', 'decide_access_request') then
    select * into v_request from public.organization_requests
    where id = nullif(p_payload ->> 'requestId', '')::uuid and status = 'pending'
    for update;
    if not found then raise exception 'Request is no longer awaiting review.'; end if;
    if (p_action = 'decide_leave_request' and v_request.kind <> 'leave')
       or (p_action = 'decide_access_request' and v_request.kind <> 'history_access_change') then
      raise exception 'Request type does not match the decision.' using errcode = '22023';
    end if;
    v_org := v_request.organization_id;
    if not exists (select 1 from public.organizations o where o.id = v_org and o.status = 'active') then
      raise exception 'Organization is not active.' using errcode = '42501';
    end if;
    v_role := public.organization_member_role(p_actor, v_org);
    if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') and not (
      v_request.kind = 'history_access_change'
      and v_role = 'teacher'
      and public.organization_is_assigned(p_actor, v_org, v_request.requester_user_id)
    ) then raise exception 'Not permitted.' using errcode = '42501'; end if;
    v_approve := coalesce((p_payload ->> 'approve')::boolean, false);
    update public.organization_requests set status = case when v_approve then 'approved' else 'rejected' end, decided_by = p_actor, decided_at = now() where id = v_request.id;
    if v_request.kind = 'leave' then
      update public.organization_memberships set status = case when v_approve then 'removed' else 'active' end, status_changed_at = now() where organization_id = v_org and user_id = v_request.requester_user_id;
      if v_approve then update public.teacher_student_assignments set revoked_at = now(), revoked_by = p_actor where organization_id = v_org and student_user_id = v_request.requester_user_id and revoked_at is null; end if;
    elsif v_request.kind = 'history_access_change' and v_approve then
      if v_request.note = 'scope:future' then
        update public.organization_memberships set share_future_history = coalesce(v_request.requested_value, false)
        where organization_id = v_org and user_id = v_request.requester_user_id;
      else
        update public.organization_memberships set share_pre_join_history = coalesce(v_request.requested_value, false)
        where organization_id = v_org and user_id = v_request.requester_user_id;
      end if;
    end if;
    perform public.organization_audit(v_org, p_actor, p_action, v_request.requester_user_id, 'request', v_request.id, jsonb_build_object('approved', v_approve));

  elsif p_action = 'request_to_leave' then
    select * into v_membership from public.organization_memberships where organization_id = v_org and user_id = p_actor and role = 'student' and status = 'active' for update;
    if not found then raise exception 'No active student membership.' using errcode = '42501'; end if;
    insert into public.organization_requests (organization_id, kind, requester_user_id, target_user_id, note)
    values (v_org, 'leave', p_actor, p_actor, nullif(btrim(p_payload ->> 'note'), ''));
    update public.organization_memberships set status = 'leave_requested', status_changed_at = now() where id = v_membership.id;
    perform public.organization_audit(v_org, p_actor, p_action, p_actor, 'membership', v_membership.id);

  elsif p_action in ('request_access_change', 'set_prior_history_sharing') then
    v_share := coalesce((p_payload ->> 'share')::boolean, false);
    select * into v_membership from public.organization_memberships where organization_id = v_org and user_id = p_actor and role = 'student' and status in ('active', 'leave_requested') for update;
    if not found then raise exception 'No active student membership.' using errcode = '42501'; end if;
    insert into public.organization_requests (organization_id, kind, requester_user_id, target_user_id, requested_value, note)
    values (
      v_org, 'history_access_change', p_actor, p_actor, v_share,
      case when p_payload ->> 'scope' = 'future' then 'scope:future' else nullif(btrim(p_payload ->> 'note'), '') end
    );
    perform public.organization_audit(v_org, p_actor, p_action, p_actor, 'membership', v_membership.id,
      jsonb_build_object('requestedValue', v_share, 'historyScope', case when p_payload ->> 'scope' = 'future' then 'future' else 'prior' end));

  elsif p_action = 'invite_member' then
    v_role := public.organization_member_role(p_actor, v_org);
    if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then raise exception 'Not permitted.' using errcode = '42501'; end if;
    v_requested_role := coalesce(nullif(p_payload ->> 'role', ''), 'student');
    if v_requested_role not in ('student', 'teacher', 'manager') or (v_requested_role = 'manager' and not (coalesce(p_platform_admin, false) or v_role = 'owner')) then raise exception 'Invalid role.' using errcode = '42501'; end if;
    v_invitee_email := nullif(lower(btrim(p_payload ->> 'email')), '');
    v_invitation_token := nullif(p_payload ->> 'token', '');
    if v_user is null and v_invitee_email is null then
      raise exception 'An invitation must name an account or email.' using errcode = '22023';
    end if;
    if v_invitation_token is null or char_length(v_invitation_token) < 24 then
      raise exception 'A strong invitation token is required.' using errcode = '22023';
    end if;
    if v_user is not null then
      if not exists (
        select 1 from auth.users invited
        where invited.id = v_user
          and (v_invitee_email is null or lower(invited.email) = v_invitee_email)
      ) then
        raise exception 'Invited account and email do not match.' using errcode = '22023';
      end if;
      if v_requested_role = 'student' and not public.organization_student_is_eligible(v_user, v_org) then raise exception 'The student needs an eligible plan or seat.' using errcode = '42501'; end if;
      if exists (
        select 1 from public.organization_memberships existing
        where existing.organization_id = v_org and existing.user_id = v_user
          and existing.status <> 'removed'
      ) then
        raise exception 'That person already has a membership in this organization.' using errcode = '23505';
      end if;
    end if;
    insert into public.organization_requests (organization_id, kind, requester_user_id, target_user_id, requested_role, invitation_email, invitation_token_hash)
    values (v_org, 'invitation', p_actor, v_user, v_requested_role,
      v_invitee_email,
      encode(sha256(convert_to(v_invitation_token, 'UTF8')), 'hex'))
    returning * into v_request;
    perform public.organization_audit(v_org, p_actor, p_action, v_user, 'membership', null, jsonb_build_object('role', v_requested_role));

  elsif p_action = 'accept_invitation' then
    v_invitation_token := nullif(p_payload ->> 'token', '');
    if v_invitation_token is null then raise exception 'Invitation not found.' using errcode = '42501'; end if;
    select * into v_request
    from public.organization_requests
    where id = nullif(p_payload ->> 'requestId', '')::uuid
      and kind = 'invitation' and status = 'pending'
      and invitation_token_hash = encode(sha256(convert_to(v_invitation_token, 'UTF8')), 'hex')
    for update;
    if not found
       or (v_request.target_user_id is not null and v_request.target_user_id <> p_actor)
       or (v_request.invitation_email is not null and not exists (
         select 1 from auth.users invited
         where invited.id = p_actor and lower(invited.email) = v_request.invitation_email
       )) then
      raise exception 'Invitation not found.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.organizations invited_org
      where invited_org.id = v_request.organization_id and invited_org.status = 'active'
    ) then
      raise exception 'Organization is not active.' using errcode = '42501';
    end if;
    if v_request.requested_role = 'student' and not public.organization_student_is_eligible(p_actor, v_request.organization_id) then raise exception 'An eligible plan or seat is required.' using errcode = '42501'; end if;
    select * into v_membership
    from public.organization_memberships
    where organization_id = v_request.organization_id and user_id = p_actor
    for update;
    if v_membership.id is not null and v_membership.status <> 'removed' then
      raise exception 'You already have an active membership in this organization.' using errcode = '23505';
    end if;
    update public.organization_requests set status = 'approved', target_user_id = p_actor, decided_by = p_actor, decided_at = now() where id = v_request.id;
    if v_membership.id is not null then
      update public.organization_memberships
      set role = v_request.requested_role, status = 'active',
          joined_at = coalesce(joined_at, now()), status_changed_at = now()
      where id = v_membership.id;
    else
      insert into public.organization_memberships (organization_id, user_id, role, status, joined_at)
      values (v_request.organization_id, p_actor, v_request.requested_role, 'active', now());
    end if;
    update public.organization_requests
    set status = 'cancelled', decided_by = p_actor, decided_at = now(), updated_at = now()
    where organization_id = v_request.organization_id
      and kind = 'invitation' and status = 'pending' and id <> v_request.id
      and (
        target_user_id = p_actor
        or (invitation_email is not null and exists (
          select 1 from auth.users invited
          where invited.id = p_actor and lower(invited.email) = invitation_email
        ))
      );
    v_org := v_request.organization_id;
    perform public.organization_audit(v_org, p_actor, p_action, p_actor, 'request', v_request.id);

  elsif p_action in ('assign_teacher', 'assign_teacher_batch', 'unassign_teacher') then
    v_role := public.organization_member_role(p_actor, v_org);
    if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then raise exception 'Not permitted.' using errcode = '42501'; end if;
    if p_action = 'assign_teacher_batch' then
      if jsonb_typeof(p_payload -> 'studentUserIds') <> 'array'
         or jsonb_array_length(p_payload -> 'studentUserIds') not between 1 and 500 then
        raise exception 'Choose between 1 and 500 students.' using errcode = '22023';
      end if;
      begin
        select array_agg(distinct item::uuid) into v_student_ids
        from jsonb_array_elements_text(p_payload -> 'studentUserIds') item;
      exception when invalid_text_representation then
        raise exception 'Invalid student identifier.' using errcode = '22023';
      end;
      if not exists (select 1 from public.organization_memberships m where m.organization_id = v_org and m.user_id = v_teacher and m.role = 'teacher' and m.status = 'active')
         or exists (
           select 1 from unnest(v_student_ids) selected(student_id)
           where not exists (
             select 1 from public.organization_memberships m
             where m.organization_id = v_org and m.user_id = selected.student_id
               and m.role = 'student' and m.status in ('active', 'leave_requested')
           )
         ) then
        raise exception 'Teacher or student is not active.' using errcode = '42501';
      end if;
      insert into public.teacher_student_assignments (organization_id, teacher_user_id, student_user_id, assigned_by)
      select v_org, v_teacher, selected.student_id, p_actor
      from unnest(v_student_ids) selected(student_id)
      on conflict (organization_id, teacher_user_id, student_user_id) where revoked_at is null do nothing;
      perform public.organization_audit(v_org, p_actor, p_action, null, 'assignment', null,
        jsonb_build_object('teacherUserId', v_teacher, 'studentUserIds', to_jsonb(v_student_ids), 'count', cardinality(v_student_ids)));
    elsif p_action = 'assign_teacher' then
      if not exists (select 1 from public.organization_memberships m where m.organization_id = v_org and m.user_id = v_teacher and m.role = 'teacher' and m.status = 'active') or not exists (select 1 from public.organization_memberships m where m.organization_id = v_org and m.user_id = v_student and m.role = 'student' and m.status in ('active', 'leave_requested')) then raise exception 'Teacher or student is not active.'; end if;
      insert into public.teacher_student_assignments (organization_id, teacher_user_id, student_user_id, assigned_by)
      values (v_org, v_teacher, v_student, p_actor)
      on conflict (organization_id, teacher_user_id, student_user_id) where revoked_at is null do nothing;
    else
      update public.teacher_student_assignments set revoked_at = now(), revoked_by = p_actor where organization_id = v_org and teacher_user_id = v_teacher and student_user_id = v_student and revoked_at is null;
    end if;
    if p_action <> 'assign_teacher_batch' then
      perform public.organization_audit(v_org, p_actor, p_action, v_student, 'assignment', null, jsonb_build_object('teacherUserId', v_teacher));
    end if;

  elsif p_action in ('change_member_role', 'suspend_member', 'restore_member', 'remove_member') then
    select * into v_membership from public.organization_memberships where organization_id = v_org and user_id = v_user for update;
    if not found then raise exception 'Member not found.'; end if;
    v_role := public.organization_member_role(p_actor, v_org);
    if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then raise exception 'Not permitted.' using errcode = '42501'; end if;
    if v_membership.role = 'owner' and not coalesce(p_platform_admin, false) then raise exception 'Only BandUp can change or remove an owner.' using errcode = '42501'; end if;
    if v_role = 'manager' and v_membership.role in ('manager', 'owner') and not coalesce(p_platform_admin, false) then raise exception 'A manager cannot manage peers or owners.' using errcode = '42501'; end if;
    if p_action = 'change_member_role' then
      v_requested_role := p_payload ->> 'role';
      if v_requested_role not in ('student', 'teacher', 'manager', 'owner') or (v_requested_role in ('manager', 'owner') and not (coalesce(p_platform_admin, false) or v_role = 'owner')) then raise exception 'Invalid role.' using errcode = '42501'; end if;
      if v_requested_role = 'student' and v_membership.role <> 'student' then
        raise exception 'Invite this person as a student so they can accept history sharing first.' using errcode = '23505';
      end if;
      if v_requested_role = 'student' and not public.organization_student_is_eligible(v_user, v_org) then raise exception 'The student needs an eligible plan or seat.' using errcode = '42501'; end if;
      update public.organization_memberships set role = v_requested_role where id = v_membership.id;
      if v_requested_role <> v_membership.role then
        update public.teacher_student_assignments set revoked_at = now(), revoked_by = p_actor
        where organization_id = v_org and revoked_at is null
          and (teacher_user_id = v_user or student_user_id = v_user);
      end if;
    elsif p_action = 'suspend_member' then
      update public.organization_memberships set status = 'suspended', status_changed_at = now() where id = v_membership.id;
    elsif p_action = 'restore_member' then
      if v_membership.status <> 'suspended' then
        raise exception 'A former member must accept a new invitation before rejoining.' using errcode = '23505';
      end if;
      if v_membership.role = 'student' and not public.organization_student_is_eligible(v_user, v_org) then raise exception 'The student needs an eligible plan or seat.' using errcode = '42501'; end if;
      update public.organization_memberships set status = 'active', joined_at = coalesce(joined_at, now()), status_changed_at = now() where id = v_membership.id;
    else
      update public.organization_memberships set status = 'removed', status_changed_at = now() where id = v_membership.id;
      update public.teacher_student_assignments set revoked_at = now(), revoked_by = p_actor where organization_id = v_org and revoked_at is null and (teacher_user_id = v_user or student_user_id = v_user);
    end if;
    perform public.organization_audit(v_org, p_actor, p_action, v_user, 'membership', v_membership.id, case when p_action = 'change_member_role' then jsonb_build_object('role', v_requested_role) else '{}'::jsonb end);

  elsif p_action in ('archive_attempt', 'restore_attempt', 'remove_attempt_permanently') then
    select a.user_id into v_student from public.practice_attempts a where a.id = v_attempt;
    if v_student is null or not public.organization_attempt_is_shared(v_org, v_student, v_attempt) then raise exception 'Attempt not found.' using errcode = '42501'; end if;
    v_role := public.organization_member_role(p_actor, v_org);
    if p_action in ('archive_attempt', 'restore_attempt') then
      if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') and not (v_role = 'teacher' and public.organization_is_assigned(p_actor, v_org, v_student)) then raise exception 'Not permitted.' using errcode = '42501'; end if;
      if exists (select 1 from public.organization_attempt_tombstones t where t.organization_id = v_org and t.attempt_id = v_attempt) then raise exception 'Attempt was permanently removed from this organization.' using errcode = '55000'; end if;
      if p_action = 'archive_attempt' then
        insert into public.organization_attempt_archives (organization_id, attempt_id, archived_by, reason)
        values (v_org, v_attempt, p_actor, nullif(btrim(p_payload ->> 'reason'), ''))
        on conflict (organization_id, attempt_id) do update set archived_by = excluded.archived_by, archived_at = now(), reason = excluded.reason, restored_by = null, restored_at = null;
      else
        update public.organization_attempt_archives set restored_by = p_actor, restored_at = now() where organization_id = v_org and attempt_id = v_attempt and restored_at is null;
      end if;
    else
      if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then raise exception 'Not permitted.' using errcode = '42501'; end if;
      if nullif(btrim(p_payload ->> 'reason'), '') is null
         or char_length(btrim(p_payload ->> 'reason')) < 3 then
        raise exception 'A reason is required for permanent removal.' using errcode = '22023';
      end if;
      insert into public.organization_attempt_tombstones (organization_id, attempt_id, removed_by, reason)
      values (v_org, v_attempt, p_actor, btrim(p_payload ->> 'reason'))
      on conflict (organization_id, attempt_id) do nothing;
    end if;
    perform public.organization_audit(v_org, p_actor, p_action, v_student, 'attempt', v_attempt, jsonb_build_object('reason', p_payload ->> 'reason'));

  elsif p_action in ('reserve_seat', 'release_seat') then
    v_role := public.organization_member_role(p_actor, v_org);
    if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then raise exception 'Not permitted.' using errcode = '42501'; end if;
    if p_action = 'reserve_seat' then
      select pool.id, pool.purchased_seats into v_seat_pool, v_capacity
      from public.organization_seat_pools pool
      where pool.id = nullif(p_payload ->> 'seatPoolId', '')::uuid and pool.organization_id = v_org and pool.status = 'active' and (pool.ends_at is null or pool.ends_at > now()) for update;
      if v_seat_pool is null then raise exception 'Active seat pool not found.'; end if;
      if (select count(*) from public.organization_seat_allocations a where a.seat_pool_id = v_seat_pool and a.status in ('reserved', 'active')) >= v_capacity then raise exception 'No seats are available.' using errcode = '23514'; end if;
      insert into public.organization_seat_allocations (organization_id, seat_pool_id, user_id, status, allocated_by)
      values (v_org, v_seat_pool, v_user, 'reserved', p_actor)
      on conflict (organization_id, user_id) where status in ('reserved', 'active') do nothing;
    else
      update public.organization_seat_allocations set status = 'released', ends_at = now() where organization_id = v_org and user_id = v_user and status in ('reserved', 'active');
    end if;
    perform public.organization_audit(v_org, p_actor, p_action, v_user, 'seat', v_seat_pool);
  end if;

  v_result := jsonb_build_object('ok', true, 'portal', public.organization_portal(p_actor, p_platform_admin))
    || case when p_action = 'invite_member' then
      jsonb_build_object('invitation', jsonb_build_object('requestId', v_request.id))
    else '{}'::jsonb end;
  insert into public.organization_command_receipts
    (actor_user_id, idempotency_key, action, request_hash, response)
  values (p_actor, p_idempotency_key, p_action, v_hash, v_result);
  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- Lock down every table and callable symbol.
-- -------------------------------------------------------------------------

alter table public.organization_applications enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_seat_pools enable row level security;
alter table public.organization_seat_allocations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.teacher_student_assignments enable row level security;
alter table public.organization_requests enable row level security;
alter table public.practice_attempts enable row level security;
alter table public.organization_attempt_archives enable row level security;
alter table public.organization_attempt_tombstones enable row level security;
alter table public.organization_audit_log enable row level security;
alter table public.organization_command_receipts enable row level security;
alter table public.organization_sync_receipts enable row level security;

revoke all on table public.organization_applications, public.organizations,
  public.organization_seat_pools, public.organization_seat_allocations,
  public.organization_memberships, public.teacher_student_assignments,
  public.organization_requests, public.practice_attempts,
  public.organization_attempt_archives, public.organization_attempt_tombstones,
  public.organization_audit_log, public.organization_command_receipts,
  public.organization_sync_receipts from public, anon, authenticated;

revoke all on function public.organization_refuse_mutation() from public, anon, authenticated;
revoke all on function public.organization_refuse_audit_insert_without_context() from public, anon, authenticated;
revoke all on function public.organization_student_is_eligible(uuid, uuid) from public, anon, authenticated;
revoke all on function public.organization_enforce_student_entitlement() from public, anon, authenticated;
revoke all on function public.organization_validate_seat_allocation() from public, anon, authenticated;
revoke all on function public.organization_validate_assignment() from public, anon, authenticated;
revoke all on function public.organization_member_role(uuid, uuid) from public, anon, authenticated;
revoke all on function public.organization_actor_is_platform_admin(uuid) from public, anon, authenticated;
revoke all on function public.organization_is_assigned(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.organization_attempt_is_shared(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.organization_audit(uuid, uuid, text, uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.organization_portal(uuid, boolean) from public, anon, authenticated;
revoke all on function public.organization_student_history(uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public.organization_sync_attempts(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.organization_command(uuid, boolean, text, jsonb, text) from public, anon, authenticated;

grant execute on function public.organization_portal(uuid, boolean) to service_role;
grant execute on function public.organization_student_history(uuid, boolean, uuid) to service_role;
grant execute on function public.organization_sync_attempts(uuid, jsonb, text) to service_role;
grant execute on function public.organization_command(uuid, boolean, text, jsonb, text) to service_role;

notify pgrst, 'reload schema';
