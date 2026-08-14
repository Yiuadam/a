-- Destructive only inside this transaction. Every fixture is rolled back.
-- Run after 0017_organizations.sql on an isolated staging project.

begin;

do $$
declare
  v_admin uuid := '10000000-0000-4000-8000-000000000001';
  v_owner uuid := '10000000-0000-4000-8000-000000000002';
  v_teacher uuid := '10000000-0000-4000-8000-000000000003';
  v_student uuid := '10000000-0000-4000-8000-000000000004';
  v_outsider uuid := '10000000-0000-4000-8000-000000000005';
  v_student_two uuid := '10000000-0000-4000-8000-000000000006';
  v_application uuid;
  v_organization uuid;
  v_request uuid;
  v_attempt uuid;
  v_join_code text;
  v_result jsonb;
  v_first jsonb;
  v_second jsonb;
begin
  insert into auth.users
    (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
     created_at, updated_at, email_confirmed_at)
  values
    (v_admin, null, 'authenticated', 'authenticated', 'org-admin@bandup.test', '{}'::jsonb, '{}'::jsonb, now(), now(), now()),
    (v_owner, null, 'authenticated', 'authenticated', 'org-owner@bandup.test', '{}'::jsonb, '{}'::jsonb, now(), now(), now()),
    (v_teacher, null, 'authenticated', 'authenticated', 'org-teacher@bandup.test', '{}'::jsonb, '{}'::jsonb, now(), now(), now()),
    (v_student, null, 'authenticated', 'authenticated', 'org-student@bandup.test', '{}'::jsonb, '{}'::jsonb, now(), now(), now()),
    (v_outsider, null, 'authenticated', 'authenticated', 'org-outsider@bandup.test', '{}'::jsonb, '{}'::jsonb, now(), now(), now()),
    (v_student_two, null, 'authenticated', 'authenticated', 'org-student-two@bandup.test', '{}'::jsonb, '{}'::jsonb, now(), now(), now());

  update public.profiles set role = 'admin', display_name = 'BandUp Admin' where id = v_admin;
  update public.profiles set display_name = 'Organization Owner' where id = v_owner;
  update public.profiles set display_name = 'Assigned Teacher' where id = v_teacher;
  update public.profiles set display_name = 'Test Student' where id = v_student;
  update public.profiles set display_name = 'Unassigned User' where id = v_outsider;
  update public.profiles set display_name = 'Second Test Student' where id = v_student_two;

  insert into public.subscriptions
    (user_id, provider, status, tier, external_subscription_id, current_period_end)
  values
    (v_student, 'stripe', 'active', 'pro', 'org-probe-subscription', now() + interval '30 days'),
    (v_student_two, 'stripe', 'active', 'standard', 'org-probe-subscription-two', now() + interval '30 days');

  perform public.organization_command(
    v_owner, false, 'submit_application',
    jsonb_build_object(
      'organizationName', 'BandUp Probe School',
      'country', 'Hong Kong',
      'contactEmail', 'org-owner@bandup.test',
      'estimatedStudents', 12,
      'applicantRole', 'Director'
    ),
    'probe-submit-application'
  );
  select id into v_application from public.organization_applications
    where applicant_user_id = v_owner and organization_name = 'BandUp Probe School';
  if v_application is null then raise exception 'Application was not created.'; end if;

  perform public.organization_command(
    v_admin, true, 'decide_application',
    jsonb_build_object('applicationId', v_application, 'approve', true, 'note', 'Staging probe'),
    'probe-approve-application'
  );
  select id, join_code into v_organization, v_join_code
    from public.organizations where application_id = v_application;
  if v_organization is null or v_join_code is null then raise exception 'Organization was not approved.'; end if;

  v_result := public.organization_portal_selected(v_admin, true, v_organization);
  if v_result #>> '{activeOrganizationId}' <> v_organization::text then
    raise exception 'Platform admin could not select an organization workspace.';
  end if;
  begin
    perform public.organization_portal_selected(v_owner, true, v_organization);
    raise exception 'Forged platform-admin context was accepted.';
  exception when insufficient_privilege then null;
  end;

  v_first := public.organization_command(
    v_owner, false, 'invite_member',
    jsonb_build_object(
      'organizationId', v_organization,
      'userId', v_teacher,
      'email', 'org-teacher@bandup.test',
      'role', 'teacher',
      'token', 'probe-teacher-token-1234567890'
    ),
    'probe-invite-teacher'
  );
  v_second := public.organization_command(
    v_owner, false, 'invite_member',
    jsonb_build_object(
      'organizationId', v_organization,
      'userId', v_teacher,
      'email', 'org-teacher@bandup.test',
      'role', 'teacher',
      'token', 'probe-teacher-token-1234567890'
    ),
    'probe-invite-teacher'
  );
  if v_first <> v_second then raise exception 'Idempotent command changed its response.'; end if;
  v_request := (v_first #>> '{invitation,requestId}')::uuid;

  begin
    perform public.organization_command(
      v_teacher, false, 'accept_invitation',
      jsonb_build_object('requestId', v_request, 'token', 'wrong-probe-token-1234567890'),
      'probe-wrong-invite-token'
    );
    raise exception 'Wrong invitation token was accepted.';
  exception when insufficient_privilege then null;
  end;

  perform public.organization_command(
    v_teacher, false, 'accept_invitation',
    jsonb_build_object('requestId', v_request, 'token', 'probe-teacher-token-1234567890'),
    'probe-accept-teacher'
  );

  begin
    perform public.organization_consent_command(
      v_student, false, 'request_to_join',
      jsonb_build_object('code', v_join_code, 'shareFutureHistoryConsent', false),
      'probe-request-join-without-consent'
    );
    raise exception 'Student joined without future-history consent.';
  exception when insufficient_privilege then null;
  end;
  perform public.organization_consent_command(
    v_student, false, 'request_to_join',
    jsonb_build_object('code', v_join_code, 'shareFutureHistoryConsent', true),
    'probe-request-join'
  );
  select id into v_request from public.organization_requests
    where organization_id = v_organization and requester_user_id = v_student
      and kind = 'join' and status = 'pending';
  perform public.organization_command(
    v_owner, false, 'decide_join_request',
    jsonb_build_object('requestId', v_request, 'approve', true),
    'probe-approve-join'
  );
  -- `now()` is fixed for this one large probe transaction; simulate the
  -- separate real request that submits an attempt after joining.
  update public.organization_memberships
    set joined_at = now() - interval '1 minute'
    where organization_id = v_organization and user_id = v_student;

  perform public.organization_consent_command(
    v_student_two, false, 'request_to_join',
    jsonb_build_object('code', v_join_code, 'shareFutureHistoryConsent', true),
    'probe-request-join-two'
  );
  select id into v_request from public.organization_requests
    where organization_id = v_organization and requester_user_id = v_student_two
      and kind = 'join' and status = 'pending';
  perform public.organization_command(
    v_owner, false, 'decide_join_request',
    jsonb_build_object('requestId', v_request, 'approve', true),
    'probe-approve-join-two'
  );
  update public.organization_memberships
    set joined_at = now() - interval '1 minute'
    where organization_id = v_organization and user_id = v_student_two;

  v_first := public.organization_assign_teacher_batch(
    v_owner, false, v_organization, v_teacher,
    jsonb_build_array(v_student, v_student_two),
    'probe-assign-teacher-batch'
  );
  v_second := public.organization_assign_teacher_batch(
    v_owner, false, v_organization, v_teacher,
    jsonb_build_array(v_student, v_student_two),
    'probe-assign-teacher-batch'
  );
  if v_first <> v_second then raise exception 'Batch assignment retry changed its response.'; end if;
  if (select count(*) from public.teacher_student_assignments
      where organization_id = v_organization and teacher_user_id = v_teacher and revoked_at is null) <> 2 then
    raise exception 'Batch assignment did not create both assignments.';
  end if;

  perform public.organization_sync_attempts(
    v_student,
    jsonb_build_array(jsonb_build_object(
      'module', 'speaking',
      'testId', 'probe-speaking-1',
      'testTitle', 'Organization staging speaking test',
      'band', 7.5,
      'date', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'review', jsonb_build_object(
        'summary', 'Clear answers with relevant examples.',
        'transcript', 'A durable staging transcript.'
      )
    )),
    'probe-sync-attempt'
  );
  select id into v_attempt from public.practice_attempts
    where user_id = v_student and test_id = 'probe-speaking-1';

  v_result := public.organization_student_history(v_teacher, false, v_student);
  if (v_result #>> '{student,completedAttempts}')::integer <> 1
     or v_result #>> '{attempts,0,result,review,transcript}' <> 'A durable staging transcript.' then
    raise exception 'Assigned teacher did not receive the complete durable attempt: %', v_result;
  end if;

  begin
    perform public.organization_student_history(v_outsider, false, v_student);
    raise exception 'Unassigned user opened student history.';
  exception when insufficient_privilege then null;
  end;

  perform public.organization_command(
    v_student, false, 'request_access_change',
    jsonb_build_object('organizationId', v_organization, 'share', true, 'note', 'Share prior history'),
    'probe-request-consent'
  );
  select id into v_request from public.organization_requests
    where organization_id = v_organization and requester_user_id = v_student
      and kind = 'history_access_change' and status = 'pending';
  perform public.organization_command(
    v_teacher, false, 'decide_access_request',
    jsonb_build_object('requestId', v_request, 'approve', true),
    'probe-approve-consent'
  );
  if not (select share_pre_join_history from public.organization_memberships
          where organization_id = v_organization and user_id = v_student) then
    raise exception 'Approved history consent was not saved.';
  end if;

  perform public.organization_command(
    v_teacher, false, 'archive_attempt',
    jsonb_build_object('organizationId', v_organization, 'attemptId', v_attempt, 'reason', 'Teacher review complete'),
    'probe-archive-attempt'
  );
  if (public.organization_student_history(v_teacher, false, v_student) #>> '{attempts,0,archivedAt}') is null then
    raise exception 'Archive state was not visible.';
  end if;
  perform public.organization_command(
    v_teacher, false, 'restore_attempt',
    jsonb_build_object('organizationId', v_organization, 'attemptId', v_attempt),
    'probe-restore-attempt'
  );

  begin
    perform public.organization_command(
      v_teacher, false, 'remove_attempt_permanently',
      jsonb_build_object('organizationId', v_organization, 'attemptId', v_attempt, 'reason', 'Must fail'),
      'probe-teacher-permanent-remove'
    );
    raise exception 'Teacher permanently removed an attempt.';
  exception when insufficient_privilege then null;
  end;

  perform public.organization_command(
    v_owner, false, 'remove_attempt_permanently',
    jsonb_build_object('organizationId', v_organization, 'attemptId', v_attempt, 'reason', 'Organization retention decision'),
    'probe-owner-permanent-remove'
  );
  if not exists (select 1 from public.practice_attempts where id = v_attempt) then
    raise exception 'Organization removal deleted the learner source.';
  end if;
  if (public.organization_student_history(v_owner, false, v_student) #>> '{student,completedAttempts}')::integer <> 0 then
    raise exception 'Organization tombstone did not hide the attempt.';
  end if;

  perform public.organization_command(
    v_student, false, 'request_to_leave',
    jsonb_build_object('organizationId', v_organization, 'note', 'Leave staging organization'),
    'probe-request-leave'
  );
  select id into v_request from public.organization_requests
    where organization_id = v_organization and requester_user_id = v_student
      and kind = 'leave' and status = 'pending';
  perform public.organization_command(
    v_owner, false, 'decide_leave_request',
    jsonb_build_object('requestId', v_request, 'approve', true),
    'probe-approve-leave'
  );
  if (select status <> 'removed' from public.organization_memberships
      where organization_id = v_organization and user_id = v_student) then
    raise exception 'Approved leave did not remove the student.';
  end if;
  if exists (select 1 from public.teacher_student_assignments
             where organization_id = v_organization and student_user_id = v_student and revoked_at is null) then
    raise exception 'Approved leave did not revoke teacher assignments.';
  end if;

  if (select count(*) from public.organization_audit_log
      where organization_id = v_organization) < 10 then
    raise exception 'Privileged organization actions were not fully audited.';
  end if;
end;
$$;

rollback;

select
  not exists (select 1 from auth.users where email like 'org-%@bandup.test') as fixtures_rolled_back,
  not exists (select 1 from public.organizations where name = 'BandUp Probe School') as organization_rolled_back,
  'manager, teacher, student, consent, history, archive and leave flows passed' as result;
