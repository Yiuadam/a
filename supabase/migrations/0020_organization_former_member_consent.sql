-- Keep an approved former membership visible to its learner and allow that
-- learner to change pre-join-history sharing without organization approval.
-- Active/leave-requested learners still enter the existing approval workflow.

create or replace function public.organization_portal_with_former_memberships(
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
  v_result jsonb;
  v_former jsonb;
begin
  v_result := public.organization_portal(p_actor, p_platform_admin);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'organization', jsonb_build_object(
      'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
      'memberCount', (select count(*) from public.organization_memberships members where members.organization_id = o.id and members.status <> 'removed'),
      'studentCount', (select count(*) from public.organization_memberships students where students.organization_id = o.id and students.role = 'student' and students.status <> 'removed'),
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
    'futureHistoryRequestStatus', null,
    'leaveRequestStatus', (
      select r.status from public.organization_requests r
      where r.organization_id = m.organization_id and r.requester_user_id = p_actor
        and r.kind = 'leave'
      order by r.created_at desc limit 1
    )
  ) order by m.status_changed_at desc), '[]'::jsonb)
    into v_former
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = p_actor and m.role = 'student' and m.status = 'removed';

  return jsonb_set(v_result, '{memberships}',
    coalesce(v_result -> 'memberships', '[]'::jsonb) || v_former, true);
end;
$$;

create or replace function public.organization_history_sharing_command(
  p_actor uuid,
  p_platform_admin boolean,
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
  v_membership public.organization_memberships%rowtype;
  v_org uuid;
  v_share boolean;
  v_response jsonb;
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
  begin
    v_org := nullif(p_payload ->> 'organizationId', '')::uuid;
    v_share := coalesce((p_payload ->> 'share')::boolean, false);
  exception when invalid_text_representation then
    raise exception 'Invalid history-sharing data.' using errcode = '22023';
  end;

  select * into v_membership
  from public.organization_memberships
  where organization_id = v_org and user_id = p_actor and role = 'student'
  for update;
  if not found then raise exception 'No student membership.' using errcode = '42501'; end if;

  if v_membership.status in ('active', 'leave_requested') then
    return public.organization_command(p_actor, p_platform_admin,
      'set_prior_history_sharing', p_payload, p_idempotency_key);
  end if;
  if v_membership.status <> 'removed' then
    raise exception 'No active or former student membership.' using errcode = '42501';
  end if;

  v_hash := encode(sha256(convert_to('set_prior_history_sharing:' || p_payload::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('org-command:' || p_actor::text || ':' || p_idempotency_key), 1, 16))::bit(64)::bigint
  );
  select * into v_prior from public.organization_command_receipts
  where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.request_hash <> v_hash or v_prior.action <> 'set_prior_history_sharing' then
      raise exception 'Request identifier was already used with different data.' using errcode = '22023';
    end if;
    return v_prior.response;
  end if;

  update public.organization_memberships set share_pre_join_history = v_share
  where id = v_membership.id;
  perform public.organization_audit(v_org, p_actor, 'set_prior_history_sharing',
    p_actor, 'membership', v_membership.id,
    jsonb_build_object('requestedValue', v_share, 'directAfterLeaving', true));
  v_response := jsonb_build_object('ok', true, 'portal',
    public.organization_portal_with_former_memberships(p_actor, p_platform_admin));
  insert into public.organization_command_receipts
    (actor_user_id, idempotency_key, action, request_hash, response)
  values (p_actor, p_idempotency_key, 'set_prior_history_sharing', v_hash, v_response);
  return v_response;
end;
$$;

revoke all on function public.organization_portal_with_former_memberships(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.organization_history_sharing_command(uuid, boolean, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.organization_portal_with_former_memberships(uuid, boolean)
  to service_role;
grant execute on function public.organization_history_sharing_command(uuid, boolean, jsonb, text)
  to service_role;

notify pgrst, 'reload schema';
