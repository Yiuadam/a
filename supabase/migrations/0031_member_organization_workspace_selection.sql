-- Let members select another active organisation they already belong to.
-- The database resolves the membership and role; the browser supplies only an
-- organisation identifier and cannot use this RPC to inspect another roster.

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
        or v_tier in ('standard', 'plus', 'pro', 'admin'),
      'canApplyToCreate', true,
      'reason', case
        when coalesce(p_platform_admin, false)
          or v_tier in ('standard', 'plus', 'pro', 'admin') then null
        else 'A Standard, Plus or Pro plan, or an organisation seat, is required to join as a student.'
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

revoke all on function public.organization_portal_selected(uuid, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.organization_portal_selected(uuid, boolean, uuid)
  to service_role;

notify pgrst, 'reload schema';
