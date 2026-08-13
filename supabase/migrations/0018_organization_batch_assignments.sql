-- Add atomic multi-student teacher assignment to databases that already ran
-- 0017 before the batch action was introduced. New installs receive the same
-- behavior directly from 0017.

create or replace function public.organization_assign_teacher_batch(
  p_actor uuid,
  p_platform_admin boolean,
  p_organization uuid,
  p_teacher uuid,
  p_students jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_student_ids uuid[];
  v_inserted integer;
  v_hash text;
  v_prior public.organization_command_receipts%rowtype;
  v_result jsonb;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = p_organization and o.status = 'active'
  ) then
    raise exception 'Organization is not active.' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{12,120}$' then
    raise exception 'Invalid request identifier.' using errcode = '22023';
  end if;

  v_role := public.organization_member_role(p_actor, p_organization);
  if not coalesce(p_platform_admin, false) and v_role not in ('manager', 'owner') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_students) <> 'array'
     or jsonb_array_length(p_students) not between 1 and 500 then
    raise exception 'Choose between 1 and 500 students.' using errcode = '22023';
  end if;

  begin
    select array_agg(distinct item::uuid)
      into v_student_ids
      from jsonb_array_elements_text(p_students) item;
  exception when invalid_text_representation then
    raise exception 'Invalid student identifier.' using errcode = '22023';
  end;

  v_hash := encode(sha256(convert_to(
    'assign_teacher_batch:' || jsonb_build_object(
      'organizationId', p_organization,
      'teacherUserId', p_teacher,
      'studentUserIds', p_students
    )::text,
    'UTF8'
  )), 'hex');
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('org-command:' || p_actor::text || ':' || p_idempotency_key), 1, 16))::bit(64)::bigint
  );
  select * into v_prior
    from public.organization_command_receipts
    where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.action <> 'assign_teacher_batch' or v_prior.request_hash <> v_hash then
      raise exception 'Request identifier was already used with different data.' using errcode = '22023';
    end if;
    return v_prior.response;
  end if;

  if not exists (
       select 1 from public.organization_memberships m
       where m.organization_id = p_organization
         and m.user_id = p_teacher
         and m.role = 'teacher'
         and m.status = 'active'
     ) or exists (
       select 1 from unnest(v_student_ids) selected(student_id)
       where not exists (
         select 1 from public.organization_memberships m
         where m.organization_id = p_organization
           and m.user_id = selected.student_id
           and m.role = 'student'
           and m.status in ('active', 'leave_requested')
       )
     ) then
    raise exception 'Teacher or student is not active.' using errcode = '42501';
  end if;

  insert into public.teacher_student_assignments
    (organization_id, teacher_user_id, student_user_id, assigned_by)
  select p_organization, p_teacher, selected.student_id, p_actor
    from unnest(v_student_ids) selected(student_id)
  on conflict (organization_id, teacher_user_id, student_user_id)
    where revoked_at is null do nothing;
  get diagnostics v_inserted = row_count;

  perform public.organization_audit(
    p_organization,
    p_actor,
    'assign_teacher_batch',
    null,
    'assignment',
    null,
    jsonb_build_object(
      'teacherUserId', p_teacher,
      'studentUserIds', to_jsonb(v_student_ids),
      'requested', cardinality(v_student_ids),
      'inserted', v_inserted
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'portal', public.organization_portal(p_actor, p_platform_admin)
  );
  insert into public.organization_command_receipts
    (actor_user_id, idempotency_key, action, request_hash, response)
  values (p_actor, p_idempotency_key, 'assign_teacher_batch', v_hash, v_result);
  return v_result;
end;
$$;

revoke all on function public.organization_assign_teacher_batch(uuid, boolean, uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.organization_assign_teacher_batch(uuid, boolean, uuid, uuid, jsonb, text)
  to service_role;

notify pgrst, 'reload schema';
