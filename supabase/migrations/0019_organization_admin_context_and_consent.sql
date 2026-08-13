-- Platform-admin workspace selection and explicit student history consent.
-- This migration is additive so databases that already ran 0017/0018 can be
-- upgraded without replacing the core command bus.

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
  v_result jsonb;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if not coalesce(p_platform_admin, false)
     or coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if p_organization is null or not exists (
    select 1 from public.organizations o
    where o.id = p_organization and o.status <> 'closed'
  ) then
    raise exception 'Organization not found.' using errcode = '42501';
  end if;

  v_result := public.organization_portal(p_actor, p_platform_admin);
  v_result := jsonb_set(v_result, '{activeOrganizationId}', to_jsonb(p_organization), true);
  v_result := jsonb_set(v_result, '{members}', coalesce((
    select jsonb_agg(jsonb_build_object(
      'membershipId', m.id,
      'userId', m.user_id,
      'displayName', member.display_name,
      'email', member.email,
      'avatarUrl', null,
      'role', m.role,
      'status', m.status,
      'joinedAt', m.joined_at,
      'assignedTeacherIds', coalesce((
        select jsonb_agg(a.teacher_user_id)
        from public.teacher_student_assignments a
        where a.organization_id = m.organization_id
          and a.student_user_id = m.user_id
          and a.revoked_at is null
      ), '[]'::jsonb)
    ) order by m.role, member.display_name nulls last, member.email)
    from public.organization_memberships m
    left join public.profiles member on member.id = m.user_id
    where m.organization_id = p_organization and m.status <> 'removed'
  ), '[]'::jsonb), true);
  v_result := jsonb_set(v_result, '{requests}', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'organizationId', r.organization_id,
      'kind', r.kind,
      'status', r.status,
      'requesterUserId', r.requester_user_id,
      'requesterName', requester.display_name,
      'requesterEmail', requester.email,
      'targetUserId', r.target_user_id,
      'invitationEmail', r.invitation_email,
      'requestedRole', r.requested_role,
      'requestedValue', r.requested_value,
      'note', r.note,
      'createdAt', r.created_at,
      'decidedAt', r.decided_at
    ) order by r.created_at desc)
    from public.organization_requests r
    left join public.profiles requester on requester.id = r.requester_user_id
    where r.organization_id = p_organization
  ), '[]'::jsonb), true);
  v_result := jsonb_set(v_result, '{students}', coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', student.id,
      'membershipId', m.id,
      'displayName', student.display_name,
      'email', student.email,
      'avatarUrl', null,
      'lastActiveAt', (
        select max(a.submitted_at) from public.practice_attempts a where a.user_id = m.user_id
      ),
      'completedAttempts', (
        select count(*)
        from public.practice_attempts a
        where a.user_id = m.user_id
          and public.organization_attempt_is_shared(m.organization_id, m.user_id, a.id)
          and not exists (
            select 1 from public.organization_attempt_tombstones t
            where t.organization_id = m.organization_id and t.attempt_id = a.id
          )
      ),
      'latestBands', coalesce((
        select jsonb_object_agg(latest.module, latest.band)
        from (
          select distinct on (a.module) a.module, a.band
          from public.practice_attempts a
          where a.user_id = m.user_id
            and public.organization_attempt_is_shared(m.organization_id, m.user_id, a.id)
            and not exists (
              select 1 from public.organization_attempt_tombstones t
              where t.organization_id = m.organization_id and t.attempt_id = a.id
            )
          order by a.module, a.submitted_at desc
        ) latest
      ), '{}'::jsonb),
      'archivedAt', null
    ) order by student.display_name nulls last, student.email)
    from public.organization_memberships m
    left join public.profiles student on student.id = m.user_id
    where m.organization_id = p_organization
      and m.role = 'student'
      and m.status in ('active', 'leave_requested', 'suspended')
  ), '[]'::jsonb), true);
  v_result := jsonb_set(v_result, '{assignments}', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'organizationId', a.organization_id,
      'teacherUserId', a.teacher_user_id,
      'teacherName', teacher.display_name,
      'studentUserId', a.student_user_id,
      'studentName', student.display_name,
      'createdAt', a.created_at
    ) order by a.created_at desc)
    from public.teacher_student_assignments a
    left join public.profiles teacher on teacher.id = a.teacher_user_id
    left join public.profiles student on student.id = a.student_user_id
    where a.organization_id = p_organization and a.revoked_at is null
  ), '[]'::jsonb), true);
  return v_result;
end;
$$;

create or replace function public.organization_consent_command(
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
  v_requested_role text;
begin
  if p_action not in ('request_to_join', 'accept_invitation') then
    raise exception 'Unsupported consent action.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Invalid command data.' using errcode = '22023';
  end if;
  if p_action = 'accept_invitation' then
    select r.requested_role into v_requested_role
    from public.organization_requests r
    where r.id = nullif(p_payload ->> 'requestId', '')::uuid
      and r.kind = 'invitation'
      and r.status = 'pending';
  else
    v_requested_role := 'student';
  end if;
  if v_requested_role = 'student'
     and not coalesce((p_payload ->> 'shareFutureHistoryConsent')::boolean, false) then
    raise exception 'Consent to share future practice history is required.' using errcode = '42501';
  end if;
  return public.organization_command(
    p_actor,
    p_platform_admin,
    p_action,
    p_payload,
    p_idempotency_key
  );
exception when invalid_text_representation then
  raise exception 'Invalid consent value.' using errcode = '22023';
end;
$$;

revoke all on function public.organization_portal_selected(uuid, boolean, uuid)
  from public, anon, authenticated;
revoke all on function public.organization_consent_command(uuid, boolean, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.organization_portal_selected(uuid, boolean, uuid)
  to service_role;
grant execute on function public.organization_consent_command(uuid, boolean, text, jsonb, text)
  to service_role;

notify pgrst, 'reload schema';
