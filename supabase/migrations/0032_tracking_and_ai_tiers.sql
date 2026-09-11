-- Two paid tiers instead of three, and no tier that sells the library itself.
--
-- The owner's decision: every reading, listening, writing and speaking paper
-- is free the moment somebody signs in — Standard's whole reason for existing
-- — and Plus and Pro collapse into one AI tier, since there is no longer a
-- reason to sell two different sizes of the same allowance. `standard`,
-- `plus` and `pro` are retired; `tracking` (a saved, synced history) and `ai`
-- (marking, tutor, word lookup, paper generation) replace them. No account
-- holds one of the retired names today — confirmed before this was written —
-- so this is a rename, not a migration of live rows.
--
-- Every function below that ordered subscription rows by a paid hierarchy
-- (`pro` > `plus` > `standard`) is recreated with the shorter one (`ai` >
-- `tracking`), because Postgres has no way to patch one CASE expression
-- inside a function body — the whole function is redefined, unchanged
-- everywhere else.

alter table public.subscriptions
  drop constraint if exists subscriptions_tier_check;

alter table public.subscriptions
  add constraint subscriptions_tier_check check (
    tier in ('free', 'tracking', 'ai')
  );

-- The single answer to "what is this user entitled to?", same shape as
-- 0026's version with the ladder shortened by one rung.
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
      when 'ai' then 2
      when 'tracking' then 1
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

-- Whether an account may join an organisation as a student: an admin, a
-- Tracking or AI subscriber, or somebody holding a seat. Content access is no
-- longer part of this question — every signed-in tier already has the whole
-- library — so what is left to ask is only whether this account pays for
-- something, or has been given a seat by one that does.
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
        and s.tier in ('tracking', 'ai')
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

-- One-time Alipay/WeChat Pay purchases, revalidated against the two plans
-- that exist now instead of the six that used to.
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
    (p_plan_id = 'tracking-monthly' and p_tier = 'tracking' and p_interval = 'month') or
    (p_plan_id = 'tracking-yearly'  and p_tier = 'tracking' and p_interval = 'year') or
    (p_plan_id = 'ai-monthly'       and p_tier = 'ai'       and p_interval = 'month') or
    (p_plan_id = 'ai-yearly'        and p_tier = 'ai'       and p_interval = 'year')
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

-- organization_portal and organization_portal_selected each named the same
-- three retired tiers twice, in a `canJoin`/`reason` pair that has to agree
-- with organization_student_is_eligible above. Both are reproduced in full
-- because Postgres cannot patch a JSON literal buried inside one — everything
-- but the tier lists and the message they explain is unchanged from 0017 and
-- 0031.
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
      'canJoin', coalesce(p_platform_admin, false) or v_tier in ('tracking', 'ai', 'admin'),
      'canApplyToCreate', true,
      'reason', case when coalesce(p_platform_admin, false) or v_tier in ('tracking', 'ai', 'admin') then null
                     else 'A Tracking or AI plan, or an organization seat, is required to join as a student.' end
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

create or replace function public.organization_portal_selected(
  p_actor uuid,
  p_platform_admin boolean,
  p_organization uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_tier text;
  v_result jsonb;
begin
  if p_actor is null or not exists (
    select 1 from auth.users user_account where user_account.id = p_actor
  ) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false)
     <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;

  if p_organization is null then
    raise exception 'Organisation not found or membership is not active.'
      using errcode = '42501';
  end if;

  if coalesce(p_platform_admin, false) then
    select 'owner'
      into v_role
      from public.organizations organization
     where organization.id = p_organization
       and organization.status <> 'closed';
  else
    select membership.role
      into v_role
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
     where membership.user_id = p_actor
       and membership.organization_id = p_organization
       and membership.status in ('active', 'leave_requested')
       and organization.status = 'active'
     limit 1;
  end if;
  if v_role is null then
    raise exception 'Organisation not found or membership is not active.'
      using errcode = '42501';
  end if;

  select entitlement.tier into v_tier
    from public.resolve_entitlement(p_actor) entitlement;

  select jsonb_build_object(
    'actor', jsonb_build_object(
      'signedIn', true,
      'userId', p_actor,
      'displayName', actor_profile.display_name,
      'email', actor_profile.email,
      'tier', v_tier,
      'platformAdmin', coalesce(p_platform_admin, false)
    ),
    'eligibility', jsonb_build_object(
      'canJoin', coalesce(p_platform_admin, false)
        or v_tier in ('tracking', 'ai', 'admin'),
      'canApplyToCreate', true,
      'reason', case
        when coalesce(p_platform_admin, false)
          or v_tier in ('tracking', 'ai', 'admin') then null
        else 'A Tracking or AI plan, or an organisation seat, is required to join as a student.'
      end
    ),
    'canClearOwnHistory', not exists (
      select 1 from public.organization_memberships own_membership
       where own_membership.user_id = p_actor
         and own_membership.role = 'student'
         and own_membership.status in ('active', 'leave_requested', 'suspended')
    ),
    'activeOrganizationId', p_organization,
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', membership.id,
        'organization', jsonb_build_object(
          'id', organization.id,
          'name', organization.name,
          'slug', organization.slug,
          'status', organization.status,
          'memberCount', (
            select count(*) from public.organization_memberships member_count
             where member_count.organization_id = organization.id
               and member_count.status <> 'removed'
          ),
          'studentCount', (
            select count(*) from public.organization_memberships student_count
             where student_count.organization_id = organization.id
               and student_count.role = 'student'
               and student_count.status <> 'removed'
          ),
          'createdAt', organization.created_at
        ),
        'role', membership.role,
        'status', membership.status,
        'joinedAt', membership.joined_at,
        'shareFutureHistory', membership.share_future_history,
        'sharePreJoinHistory', membership.share_pre_join_history,
        'preJoinHistoryRequestStatus', (
          select request.status from public.organization_requests request
           where request.organization_id = membership.organization_id
             and request.requester_user_id = p_actor
             and request.kind = 'history_access_change'
             and coalesce(request.note, '') <> 'scope:future'
           order by request.created_at desc limit 1
        ),
        'futureHistoryRequestStatus', (
          select request.status from public.organization_requests request
           where request.organization_id = membership.organization_id
             and request.requester_user_id = p_actor
             and request.kind = 'history_access_change'
             and request.note = 'scope:future'
           order by request.created_at desc limit 1
        ),
        'leaveRequestStatus', (
          select request.status from public.organization_requests request
           where request.organization_id = membership.organization_id
             and request.requester_user_id = p_actor
             and request.kind = 'leave'
           order by request.created_at desc limit 1
        )
      ) order by membership.created_at desc)
        from public.organization_memberships membership
        join public.organizations organization
          on organization.id = membership.organization_id
       where membership.user_id = p_actor
         and membership.status <> 'removed'
    ), '[]'::jsonb),
    'applications', case when coalesce(p_platform_admin, false) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', application.id,
        'organizationName', application.organization_name,
        'country', application.country,
        'contactEmail', application.contact_email,
        'estimatedStudents', application.estimated_students,
        'applicantRole', application.applicant_role,
        'status', application.status,
        'submittedAt', application.submitted_at,
        'reviewedAt', application.reviewed_at,
        'reviewNote', application.review_note
      ) order by application.created_at desc)
        from public.organization_applications application
    ), '[]'::jsonb) else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', application.id,
        'organizationName', application.organization_name,
        'country', application.country,
        'contactEmail', application.contact_email,
        'estimatedStudents', application.estimated_students,
        'applicantRole', application.applicant_role,
        'status', application.status,
        'submittedAt', application.submitted_at,
        'reviewedAt', application.reviewed_at,
        'reviewNote', application.review_note
      ) order by application.created_at desc)
        from public.organization_applications application
       where application.applicant_user_id = p_actor
    ), '[]'::jsonb) end,
    'organizations', case when coalesce(p_platform_admin, false) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', organization.id,
        'name', organization.name,
        'slug', organization.slug,
        'status', organization.status,
        'memberCount', (
          select count(*) from public.organization_memberships member_count
           where member_count.organization_id = organization.id
             and member_count.status <> 'removed'
        ),
        'studentCount', (
          select count(*) from public.organization_memberships student_count
           where student_count.organization_id = organization.id
             and student_count.role = 'student'
             and student_count.status <> 'removed'
        ),
        'createdAt', organization.created_at
      ) order by organization.created_at desc)
        from public.organizations organization
    ), '[]'::jsonb) else null end,
    'members', case when coalesce(p_platform_admin, false) or v_role in ('manager', 'owner') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', membership.id,
        'userId', membership.user_id,
        'displayName', member_profile.display_name,
        'email', member_profile.email,
        'avatarUrl', null,
        'role', membership.role,
        'status', membership.status,
        'joinedAt', membership.joined_at,
        'assignedTeacherIds', coalesce((
          select jsonb_agg(assignment.teacher_user_id)
            from public.teacher_student_assignments assignment
           where assignment.organization_id = membership.organization_id
             and assignment.student_user_id = membership.user_id
             and assignment.revoked_at is null
        ), '[]'::jsonb)
      ) order by membership.role, member_profile.display_name nulls last, member_profile.email)
        from public.organization_memberships membership
        left join public.profiles member_profile on member_profile.id = membership.user_id
       where membership.organization_id = p_organization
         and membership.status <> 'removed'
    ), '[]'::jsonb) else null end,
    'requests', case when coalesce(p_platform_admin, false) or v_role in ('manager', 'owner', 'teacher') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', request.id,
        'organizationId', request.organization_id,
        'kind', request.kind,
        'status', request.status,
        'requesterUserId', request.requester_user_id,
        'requesterName', requester_profile.display_name,
        'requesterEmail', requester_profile.email,
        'targetUserId', request.target_user_id,
        'invitationEmail', request.invitation_email,
        'requestedRole', request.requested_role,
        'requestedValue', request.requested_value,
        'note', request.note,
        'createdAt', request.created_at,
        'decidedAt', request.decided_at
      ) order by request.created_at desc)
        from public.organization_requests request
        left join public.profiles requester_profile
          on requester_profile.id = request.requester_user_id
       where request.organization_id = p_organization
         and (
           coalesce(p_platform_admin, false)
           or v_role in ('manager', 'owner')
           or (
             v_role = 'teacher'
             and request.kind = 'history_access_change'
             and request.status = 'pending'
             and public.organization_is_assigned(
               p_actor,
               request.organization_id,
               request.requester_user_id
             )
           )
         )
    ), '[]'::jsonb) else null end,
    'students', case when coalesce(p_platform_admin, false) or v_role in ('teacher', 'manager', 'owner') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', student_profile.id,
        'membershipId', membership.id,
        'displayName', student_profile.display_name,
        'email', student_profile.email,
        'avatarUrl', null,
        'lastActiveAt', (
          select max(attempt.submitted_at) from public.practice_attempts attempt
           where attempt.user_id = membership.user_id
        ),
        'completedAttempts', (
          select count(*) from public.practice_attempts attempt
           where attempt.user_id = membership.user_id
             and public.organization_attempt_is_shared(
               membership.organization_id,
               membership.user_id,
               attempt.id
             )
             and not exists (
               select 1 from public.organization_attempt_tombstones tombstone
                where tombstone.organization_id = membership.organization_id
                  and tombstone.attempt_id = attempt.id
             )
        ),
        'latestBands', coalesce((
          select jsonb_object_agg(latest.module, latest.band)
            from (
              select distinct on (attempt.module) attempt.module, attempt.band
                from public.practice_attempts attempt
               where attempt.user_id = membership.user_id
                 and public.organization_attempt_is_shared(
                   membership.organization_id,
                   membership.user_id,
                   attempt.id
                 )
                 and not exists (
                   select 1 from public.organization_attempt_tombstones tombstone
                    where tombstone.organization_id = membership.organization_id
                      and tombstone.attempt_id = attempt.id
                 )
               order by attempt.module, attempt.submitted_at desc
            ) latest
        ), '{}'::jsonb),
        'archivedAt', null
      ) order by student_profile.display_name nulls last, student_profile.email)
        from public.organization_memberships membership
        left join public.profiles student_profile on student_profile.id = membership.user_id
       where membership.organization_id = p_organization
         and membership.role = 'student'
         and membership.status in ('active', 'leave_requested', 'suspended')
         and (
           coalesce(p_platform_admin, false)
           or v_role in ('manager', 'owner')
           or public.organization_is_assigned(
             p_actor,
             membership.organization_id,
             membership.user_id
           )
         )
    ), '[]'::jsonb) else null end,
    'assignments', case when coalesce(p_platform_admin, false) or v_role in ('manager', 'owner') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', assignment.id,
        'organizationId', assignment.organization_id,
        'teacherUserId', assignment.teacher_user_id,
        'teacherName', teacher_profile.display_name,
        'studentUserId', assignment.student_user_id,
        'studentName', student_profile.display_name,
        'createdAt', assignment.created_at
      ) order by assignment.created_at desc)
        from public.teacher_student_assignments assignment
        left join public.profiles teacher_profile on teacher_profile.id = assignment.teacher_user_id
        left join public.profiles student_profile on student_profile.id = assignment.student_user_id
       where assignment.organization_id = p_organization
         and assignment.revoked_at is null
    ), '[]'::jsonb) else null end,
    -- Assigned-practice and teacher-feedback storage is Cloudflare-owned in
    -- the current dual-read phase. Keep the response shape explicit so a
    -- Supabase fallback never presents another organisation's stale arrays.
    'practiceAssignments', null,
    'recentFeedback', null
  ) into v_result
  from public.profiles actor_profile
  where actor_profile.id = p_actor;

  return v_result;
end;
$$;

notify pgrst, 'reload schema';
